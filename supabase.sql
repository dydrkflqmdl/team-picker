-- 팀 뽑기 (빨강·파랑·노랑·초록) — Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 Run.
--
-- ⚠️ Run 하기 전에 아래 [관리자 비밀번호] 의 '여기를-바꾸세요' 를 편집기에서 바꾸세요.
--    이 파일은 공개 저장소에 있으니 파일 자체에는 비밀번호를 적지 마세요.
--    다시 Run 할 때 '여기를-바꾸세요' 를 그대로 두면 기존 비밀번호가 유지돼요.
--
-- 구조: 참가자 화면은 테이블에 직접 접근하지 못하고, 아래 함수들만 부를 수 있다.
--   departments() / login() / pick()          ← 참가자용 (누구나)
--   board() / admin_add() / admin_update() / admin_remove() / admin_reset()  ← 진행자용 (관리자 비밀번호 필요)

-- 이전 버전(명단·기록) 테이블 정리 — 비어 있음
drop table if exists public.members, public.draws;

-- ── 테이블 ──────────────────────────────────────────────
create table if not exists public.people (
  id        bigint generated always as identity primary key,
  dept      text not null check (char_length(dept) between 1 and 50),
  name      text not null check (char_length(name) between 1 and 50),
  team      text check (team in ('red', 'blue', 'yellow', 'green')),
  picked_at timestamptz,
  unique (dept, name)
);
-- 직급·성별(없어도 됨). 임원 여부는 직급 이름으로 자동 판단: 대표·이사·고문·상무·전무·사장·회장
alter table public.people
  add column if not exists title   text check (char_length(title) <= 30),
  add column if not exists gender  text check (gender in ('남', '여')),
  add column if not exists is_exec boolean
    generated always as (coalesce(title ~ '(대표|이사|고문|상무|전무|사장|회장)', false)) stored;

create table if not exists public.config (
  key   text primary key,
  value text not null
);

-- 참가자(anon)는 테이블을 직접 읽거나 쓸 수 없다. RLS 는 켜두되 정책은 만들지 않는다.
alter table public.people enable row level security;
alter table public.config enable row level security;
revoke all on public.people, public.config from anon, authenticated;

-- [관리자 비밀번호] 8자 이상 권장
insert into public.config (key, value) values ('admin_code', '여기를-바꾸세요')
on conflict (key) do update set value = excluded.value
  where excluded.value <> '여기를-바꾸세요';

-- ── 내부 함수 ────────────────────────────────────────────
-- 부서: 앞뒤 공백 제거 + 공백 하나로. 이름: 공백 전부 제거("홍 길동" = "홍길동").
create or replace function public.norm_dept(t text) returns text
language sql immutable as $$ select regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g') $$;

create or replace function public.norm_name(t text) returns text
language sql immutable as $$ select regexp_replace(coalesce(t, ''), '\s+', '', 'g') $$;

create or replace function public.check_admin(p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  select value into v from config where key = 'admin_code';
  if v is null or v = '여기를-바꾸세요' then
    raise exception '관리자 비밀번호가 아직 설정되지 않았어요. SQL Editor 에서 설정해 주세요.';
  end if;
  if p_code is distinct from v then
    perform pg_sleep(1); -- 무작위 대입을 느리게
    raise exception '관리자 비밀번호가 틀렸어요.';
  end if;
end $$;

-- ── 참가자용 ─────────────────────────────────────────────
-- 로그인 화면의 부서 목록
create or replace function public.departments() returns setof text
language sql stable security definer set search_path = public as $$
  select distinct dept from people order by dept
$$;

-- 명단에 있으면 {dept, name, team}, 없으면 null
create or replace function public.login(p_dept text, p_name text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('dept', dept, 'name', name, 'team', team)
  from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name)
$$;

-- 팀 뽑기. 이미 뽑았으면 그 팀을 그대로 돌려준다(한 번만).
-- 누를 때마다 '아직 안 뽑은 사람 전원(나 포함)을 어떻게 나누면 가장 고른지' 계획을 새로 세우고, 그 계획의 내 팀을 준다.
-- 1) 고른 기준: 팀 인원, 임원·비임원, 부서마다, 남·여 인원이 팀마다 (그 인원 ÷ 4)의 내림~올림 사이면 완벽.
--    벗어난 만큼 벌점(팀 인원 10000 → 반드시 맞춤, 임원 20, 부서·성별 10).
-- 2) 벌점이 같으면 지금까지 뽑은 인원이 적은 팀을 고른다(안 누르는 사람이 있어도 인원이 덜 벌어지게).
-- 3) 계획은 무작위로 시작해 2000번 바꿔 보며 다듬으므로 매번 랜덤이다.
-- 4) 뽑는 도중에도 팀 인원 차이는 최대 3명(이미 3명 더 많은 팀으로는 안 감).
-- (명단 29명으로 400번 시뮬레이션: 팀 인원·임원·남녀는 400번 모두 고르게, 부서까지 모두 고른 건 98%. 예전 규칙은 7%)
-- ⚠️ 명단에 있는데 안 누르는 사람이 있으면 그 자리만큼 팀 인원이 어긋날 수 있다 → 안 온 사람은 뽑기 전에 명단에서 지운다.
create or replace function public.pick(p_dept text, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  teams constant text[] := array['red', 'blue', 'yellow', 'green'];
  me     people;
  pid    bigint[];                     -- 명단 전체 id (id 순)
  cur    int[];                        -- 사람별 팀 번호 1~4. 뽑은 사람은 고정, 나머지는 계획
  pg     int[];                        -- 사람마다 그룹 번호 4칸(전체·임원 여부·부서·성별), 0 = 없음
  w      int[];                        -- 그룹별 무게
  lo     int[];                        -- 그룹별 팀당 최소 = 내림(그룹 인원 / 4)
  hi     int[];                        -- 그룹별 팀당 최대 = 올림(그룹 인원 / 4)
  cnt    int[];                        -- (그룹, 팀)별 계획 인원: cnt[(그룹-1)*4 + 팀]
  todo   int[] := '{}';                -- 아직 안 뽑은 사람(나 포함)
  ok     int[];                        -- 내가 갈 수 있는 팀
  done   int[] := array[0, 0, 0, 0];   -- 팀별 이미 뽑은 인원
  sz     int[];
  mv     int[];                        -- 이번에 해 볼 변경: (사람, 원래 팀, 새 팀) × 1~2
  n int; nf int; mi int; i int; k int; g int; a int; b int; p int; q int; d int; ca int; cb int;
  cost int := 0; best int; myteam int;
begin
  -- 동시에 여러 명이 눌러도 한 명씩 처리(읽기는 막지 않음)
  lock table people in share row exclusive mode;

  select * into me from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name);
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  if me.team is not null then
    return me.team;
  end if;

  select array_agg(id order by id), array_agg(coalesce(array_position(teams, team), 0) order by id)
  into pid, cur from people;
  n  := cardinality(pid);
  mi := array_position(pid, me.id);

  with u as (
    select id, o, gkey from people,
      unnest(array['all', 'x' || is_exec::text, 'd' || dept, 'g' || gender]) with ordinality as t(gkey, o)),
  gs as (
    select gkey, count(*)::int as gsize, row_number() over (order by gkey)::int as gno
    from u where gkey is not null group by gkey)
  select (select array_agg(coalesce(gs.gno, 0) order by u.id, u.o) from u left join gs using (gkey)),
         (select array_agg(case when gkey = 'all' then 10000 when gkey like 'x%' then 20 else 10 end order by gno) from gs),
         (select array_agg(gsize / 4 order by gno) from gs),
         (select array_agg((gsize + 3) / 4 order by gno) from gs)
  into pg, w, lo, hi;

  for i in 1..n loop
    if cur[i] > 0 then done[cur[i]] := done[cur[i]] + 1; else todo := todo || i; end if;
  end loop;
  nf := cardinality(todo);

  -- 내가 갈 수 있는 팀: 지금까지 뽑은 인원이 (가장 적은 팀 + 3)명 미만인 팀
  select array_agg(x) into ok from generate_series(1, 4) x
  where done[x] < (select min(y) from unnest(done) y) + 3;

  -- 첫 계획: 나는 갈 수 있는 팀 중 아무 데나, 나머지는 무작위 순서로 인원 적은 팀부터 채움
  cur[mi] := ok[1 + floor(random() * cardinality(ok))::int];
  sz := done;
  sz[cur[mi]] := sz[cur[mi]] + 1;
  for i in select x from unnest(todo) x where x <> mi order by random() loop
    select x into b from generate_series(1, 4) x order by sz[x], random() limit 1;
    cur[i] := b;
    sz[b] := sz[b] + 1;
  end loop;

  cnt := array_fill(0, array[cardinality(w) * 4]);
  for i in 1..n loop
    for k in 1..4 loop
      g := pg[(i - 1) * 4 + k];
      if g > 0 then cnt[(g - 1) * 4 + cur[i]] := cnt[(g - 1) * 4 + cur[i]] + 1; end if;
    end loop;
  end loop;

  for g in 1..cardinality(w) loop
    for k in 1..4 loop
      cost := cost + w[g] * (greatest(0, cnt[(g - 1) * 4 + k] - hi[g]) + greatest(0, lo[g] - cnt[(g - 1) * 4 + k]));
    end loop;
  end loop;
  cost := cost + done[cur[mi]] - (select min(y) from unnest(done) y);
  best := cost;
  myteam := cur[mi];

  -- 계획 다듬기: 안 뽑은 사람 둘을 골라 팀을 맞바꾸거나(같은 팀이면 한 명을 다른 팀으로 옮김),
  -- 벌점이 늘지 않으면 받아들인다. 초반에는 조금 늘어나는 것도 가끔 받아들여 막다른 곳을 빠져나온다.
  -- 벌점이 가장 낮았던 계획의 내 팀을 고른다.
  for step in 1..2000 loop
    p := todo[1 + floor(random() * nf)::int];
    q := todo[1 + floor(random() * nf)::int];
    if cur[p] = cur[q] then
      b := 1 + floor(random() * 3)::int;
      if b >= cur[p] then b := b + 1; end if;
      mv := array[p, cur[p], b];
      q := 0;
    else
      mv := array[p, cur[p], cur[q], q, cur[q], cur[p]];
    end if;
    if (p = mi and not mv[3] = any(ok)) or (q = mi and not mv[6] = any(ok)) then
      continue;
    end if;

    d := 0;
    for m in 0..cardinality(mv) / 3 - 1 loop
      i := mv[m * 3 + 1]; a := mv[m * 3 + 2]; b := mv[m * 3 + 3];
      for k in 1..4 loop
        g := pg[(i - 1) * 4 + k];
        continue when g = 0;
        ca := cnt[(g - 1) * 4 + a];
        cb := cnt[(g - 1) * 4 + b];
        d := d + w[g] * ((case when ca <= lo[g] then 1 when ca > hi[g] then -1 else 0 end)
                       + (case when cb >= hi[g] then 1 when cb < lo[g] then -1 else 0 end));
        cnt[(g - 1) * 4 + a] := ca - 1;
        cnt[(g - 1) * 4 + b] := cb + 1;
      end loop;
      if i = mi then d := d + done[b] - done[a]; end if;
      cur[i] := b;
    end loop;

    if d <= 0 or (d < 100 and random() < exp(-d / greatest(0.3, 15 * (1 - step / 2000.0)))) then
      cost := cost + d;
      if cost <= best then best := cost; myteam := cur[mi]; end if;
    else -- 받아들이지 않으면 되돌림
      for m in 0..cardinality(mv) / 3 - 1 loop
        i := mv[m * 3 + 1]; a := mv[m * 3 + 2]; b := mv[m * 3 + 3];
        for k in 1..4 loop
          g := pg[(i - 1) * 4 + k];
          continue when g = 0;
          cnt[(g - 1) * 4 + a] := cnt[(g - 1) * 4 + a] + 1;
          cnt[(g - 1) * 4 + b] := cnt[(g - 1) * 4 + b] - 1;
        end loop;
        cur[i] := a;
      end loop;
    end if;
  end loop;

  update people set team = teams[myteam], picked_at = now() where id = me.id;
  return teams[myteam];
end $$;

-- ── 진행자용 (관리자 비밀번호 필요) ───────────────────────
-- 전체 현황: [{id, dept, name, title, gender, is_exec, team, picked_at}, ...]
create or replace function public.board(p_code text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  return (
    select coalesce(json_agg(json_build_object(
             'id', id, 'dept', dept, 'name', name, 'title', title, 'gender', gender,
             'is_exec', is_exec, 'team', team, 'picked_at', picked_at)
             order by picked_at nulls last, dept, name), '[]'::json)
    from people
  );
end $$;

-- 명단 추가: p_rows = [{"dept": "개발팀", "name": "홍길동", "title": "대리", "gender": "남"}, ...]
-- title·gender 는 없어도 됨. 이미 있는 (부서, 이름)은 건너뜀. 추가된 수를 돌려줌.
create or replace function public.admin_add(p_code text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform check_admin(p_code);
  insert into people (dept, name, title, gender)
  select distinct on (norm_dept(r->>'dept'), norm_name(r->>'name'))
         norm_dept(r->>'dept'), norm_name(r->>'name'),
         nullif(btrim(r->>'title'), ''),
         case when btrim(r->>'gender') ~* '^(남|남자|남성|m|male)$' then '남'
              when btrim(r->>'gender') ~* '^(여|여자|여성|f|female)$' then '여' end
  from jsonb_array_elements(p_rows) r
  where norm_dept(r->>'dept') <> '' and norm_name(r->>'name') <> ''
  on conflict (dept, name) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- 사람 정보 고치기: p_row = {"dept": "영상사업부", "name": "홍길동", "title": "대리", "gender": "남"}
-- 부서·이름은 비울 수 없고, 같은 부서에 같은 이름이 이미 있으면 막는다. 이미 뽑은 팀은 그대로 둔다.
create or replace function public.admin_update(p_code text, p_id bigint, p_row jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_dept text := norm_dept(p_row->>'dept');
  v_name text := norm_name(p_row->>'name');
begin
  perform check_admin(p_code);
  if v_dept = '' or v_name = '' then
    raise exception '부서와 이름은 비울 수 없어요.';
  end if;
  if exists (select 1 from people where dept = v_dept and name = v_name and id <> p_id) then
    raise exception '%의 % 님이 이미 명단에 있어요.', v_dept, v_name;
  end if;
  update people
  set dept   = v_dept,
      name   = v_name,
      title  = nullif(btrim(p_row->>'title'), ''),
      gender = case when btrim(p_row->>'gender') ~* '^(남|남자|남성|m|male)$' then '남'
                    when btrim(p_row->>'gender') ~* '^(여|여자|여성|f|female)$' then '여' end
  where id = p_id;
  if not found then
    raise exception '명단에서 그 사람을 찾을 수 없어요. 새로고침해 주세요.';
  end if;
end $$;

-- 사람 삭제. p_id 가 null 이면 명단 전체 삭제.
create or replace function public.admin_remove(p_code text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  delete from people where p_id is null or id = p_id;
end $$;

-- 다시 뽑을 수 있게 초기화. p_id 가 null 이면 전체 초기화.
create or replace function public.admin_reset(p_code text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  update people set team = null, picked_at = null where p_id is null or id = p_id;
end $$;

-- ── 실행 권한 ────────────────────────────────────────────
revoke all on function public.norm_dept(text), public.norm_name(text), public.check_admin(text)
  from public, anon, authenticated;

revoke all on function
  public.departments(), public.login(text, text), public.pick(text, text),
  public.board(text), public.admin_add(text, jsonb), public.admin_update(text, bigint, jsonb),
  public.admin_remove(text, bigint), public.admin_reset(text, bigint)
  from public;
grant execute on function
  public.departments(), public.login(text, text), public.pick(text, text),
  public.board(text), public.admin_add(text, jsonb), public.admin_update(text, bigint, jsonb),
  public.admin_remove(text, bigint), public.admin_reset(text, bigint)
  to anon, authenticated;
