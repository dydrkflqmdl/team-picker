-- 팀 뽑기 (빨강·파랑·노랑·초록) — Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 Run.
--
-- ⚠️ Run 하기 전에 아래 [관리자 비밀번호] 의 '여기를-바꾸세요' 를 편집기에서 바꾸세요.
--    이 파일은 공개 저장소에 있으니 파일 자체에는 비밀번호를 적지 마세요.
--    다시 Run 할 때 '여기를-바꾸세요' 를 그대로 두면 기존 비밀번호가 유지돼요.
--
-- 구조: 참가자 화면은 테이블에 직접 접근하지 못하고, 아래 함수들만 부를 수 있다.
--   departments() / login() / choose_menu() / pick() / schedule() / team_members()  ← 참가자용 (누구나)
--   board() / admin_add() / admin_update() / admin_remove() / admin_reset() / admin_reset_all()  ← 진행자용 (관리자 비밀번호 필요)
-- 일정표: 진행자가 진행자 화면에서 적고(admin_set), 참가자 화면이 schedule() 로 받아 보여준다.
-- 준비해 둔 기능(시험용: 객실표·자유시간)은 진행자 화면에만 있다. 참가자가 부를 수 있는 함수는 없다.
--   board_state() / admin_assign() / admin_clear() / admin_set()  ← 진행자용 (관리자 비밀번호 필요)
-- 여럿이 동시에 뽑을 때: pick() 끼리만 한 명씩 차례로 처리한다. 메뉴 고르기·진행자 저장·읽기는 뽑기를 기다리지 않는다.
-- 참가자 요청의 제한 시간: 맨 아래에서 anon 을 8초로 늘린다(Supabase 기본 3초).
-- 되돌리기용 기록(people_log): 명단 줄이 바뀌거나 지워질 때, 일정표를 고칠 때 예전 값을 남긴다.

-- 이전 버전(명단·기록) 테이블 정리 — 비어 있음
drop table if exists public.members, public.draws;
-- 이전 버전에 잠깐 있던 참가자용 함수·설정 정리(일정표·객실·자유시간을 참가자 화면에 켜는 장치 — 지금은 진행자 화면에만 둔다)
drop function if exists public.extras(text, text), public.choose_activity(text, text, text);

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
-- 조식 메뉴(12월 18일 금요일 아침). 고르기 전에는 비어 있고, 참가자가 한 번 고르면 못 바꾼다.
-- 'ugeoji' = 우거지 해장국, 'miyeok' = 소고기 미역국, 'hwangtae' = 버섯 황태 해장국
alter table public.people
  add column if not exists menu text check (menu in ('ugeoji', 'miyeok', 'hwangtae'));
-- 객실: 남자 방 'm1'~'m5', 여자 방 'f1'·'f2'. 자유시간(저녁 식사 뒤): 'ski' = 스키, 'sauna' = 사우나. 둘 다 진행자만 넣고 볼 수 있다.
alter table public.people
  add column if not exists room     text check (room in ('m1', 'm2', 'm3', 'm4', 'm5', 'f1', 'f2')),
  add column if not exists activity text check (activity in ('ski', 'sauna'));

-- 설정: 'admin_code'(관리자 비밀번호), 'schedule'(일정표 글 — 진행자가 적고 참가자 화면에도 보임)
-- 변경 기록(되돌리기용): people 의 줄이 바뀌거나 지워질 때마다 예전 값을 남긴다. 진행자가 실수로 전체 삭제·전체 다시 뽑기를 해도
-- SQL Editor 에서 되살릴 수 있다(README "실수로 지웠을 때"). 참가자·진행자 화면은 이 표를 읽지 못한다.
-- 일정표도 진행자가 고칠 때마다(admin_set) 고치기 전 글을 op = 'SCHEDULE' 로 남긴다. 관리자 비밀번호는 남기지 않는다.
--   예전 일정표 보기(SQL Editor): select at, old->>'value' as 일정표 from people_log where op = 'SCHEDULE' order by at desc;
--   찾은 글을 복사해 진행자 화면의 일정 고치기에 붙여 넣고 저장하면 된다.
create table if not exists public.people_log (
  at  timestamptz not null default now(),
  op  text not null,      -- 'UPDATE'·'DELETE'(명단 줄) 또는 'SCHEDULE'(일정표 글)
  old jsonb not null      -- 바뀌기 전(지워지기 전) 그 줄 전체. 'SCHEDULE' 은 {"key": "schedule", "value": 고치기 전 일정표 글}
);

create table if not exists public.config (
  key   text primary key,
  value text not null
);

-- 참가자(anon)는 테이블을 직접 읽거나 쓸 수 없다. RLS 는 켜두되 정책은 만들지 않는다.
alter table public.people enable row level security;
alter table public.config enable row level security;
alter table public.people_log enable row level security;
revoke all on public.people, public.config, public.people_log from anon, authenticated;

create or replace function public.log_people() returns trigger
language plpgsql set search_path = public as $$
begin
  insert into people_log (op, old) values (tg_op, to_jsonb(old));
  return null;
end $$;
revoke all on function public.log_people() from public, anon, authenticated;
drop trigger if exists people_log on public.people;
create trigger people_log after update or delete on public.people
  for each row execute function public.log_people();

-- [관리자 비밀번호] 무작위 16자 이상(영문 대소문자·숫자 섞어서)으로 정한다. 진행자 화면 주소는 공개라 누구나 대입해 볼 수 있다.
-- 틀려도 일부러 늦게 답하지 않는다: 늦추면 틀린 비밀번호를 한꺼번에 많이 보낼 때 요청마다 DB 연결을 붙잡아 참가자까지 막힌다.
-- 그래서 막는 힘은 비밀번호 길이에서 나온다. 짧거나 쉬운 비밀번호는 금방 뚫린다.
insert into public.config (key, value) values ('admin_code', '여기를-바꾸세요')
on conflict (key) do update set value = excluded.value
  where excluded.value <> '여기를-바꾸세요';

-- ── 내부 함수 ────────────────────────────────────────────
-- 부서: 앞뒤 공백 제거 + 공백 하나로. 이름: 공백 전부 제거("홍 길동" = "홍길동").
-- 한글을 한 가지 꼴(NFC)로 맞추고, 보이지 않는 글자(폭 없는 공백·BOM 등)는 지우고, 전각 공백·NBSP 도 공백으로 봄
-- (엑셀·다른 기기에서 붙여 넣은 이름이 휴대폰에서 친 이름과 달라 로그인이 안 되는 일을 막음)
create or replace function public.norm_dept(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(normalize(coalesce(t, ''), NFC), '[\u200b-\u200d\u2060\ufeff]', '', 'g'), '[\s\u00a0\u3000]+', ' ', 'g'))
$$;

create or replace function public.norm_name(t text) returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(normalize(coalesce(t, ''), NFC), '[\u200b-\u200d\u2060\ufeff]', '', 'g'), '[\s\u00a0\u3000]+', '', 'g')
$$;

create or replace function public.check_admin(p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  select value into v from config where key = 'admin_code';
  if v is null or v = '여기를-바꾸세요' then
    raise exception '관리자 비밀번호가 아직 설정되지 않았어요. SQL Editor 에서 설정해 주세요.';
  end if;
  if p_code is distinct from v then
    raise exception '관리자 비밀번호가 틀렸어요.'; -- 바로 답한다(위 [관리자 비밀번호] 설명)
  end if;
end $$;

-- ── 참가자용 ─────────────────────────────────────────────
-- 로그인 화면의 부서 목록
create or replace function public.departments() returns setof text
language sql stable security definer set search_path = public as $$
  select distinct dept from people order by dept
$$;

-- 명단에 있으면 {dept, name, team, menu}, 없으면 null
create or replace function public.login(p_dept text, p_name text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('dept', dept, 'name', name, 'team', team, 'menu', menu)
  from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name)
$$;

-- 조식 메뉴 고르기. 한 사람이 하나만, 한 번만 고를 수 있다.
-- 이미 골랐으면 새로 보낸 값은 버리고 처음 고른 메뉴를 그대로 돌려준다(동시에 두 번 눌러도 먼저 온 것만 남음).
create or replace function public.choose_menu(p_dept text, p_name text, p_menu text) returns text
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  -- 지나치게 긴 입력은 정리하거나 줄을 잠그기 전에 바로 거절(누구나 부를 수 있는 함수라, 큰 입력으로 다른 사람을 막지 못하게)
  if char_length(p_dept) > 100 or char_length(p_name) > 100 then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  if p_menu is null or p_menu not in ('ugeoji', 'miyeok', 'hwangtae') then
    raise exception '메뉴를 다시 골라 주세요.';
  end if;
  update people set menu = p_menu
  where dept = norm_dept(p_dept) and name = norm_name(p_name) and menu is null;
  select menu into v from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name);
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  return v;
end $$;

-- 팀 뽑기. 이미 뽑았으면 그 팀을 그대로 돌려준다(한 번만). 조식 메뉴를 아직 안 골랐으면 뽑을 수 없다.
-- 누를 때마다 '아직 안 뽑은 사람 전원(나 포함)을 어떻게 나누면 가장 고른지' 계획을 새로 세우고, 그 계획의 내 팀을 준다.
-- 1) 고른 기준: 팀 인원, 임원·비임원, 부서마다, 남·여 인원이 팀마다 (그 인원 ÷ 4)의 내림~올림 사이면 완벽.
--    벗어난 만큼 벌점(팀 인원 10000 → 반드시 맞춤, 임원 20, 부서·성별 10).
-- 2) 벌점이 같으면 지금까지 뽑은 인원이 적은 팀을 고른다(안 누르는 사람이 있어도 인원이 덜 벌어지게).
-- 3) 계획은 무작위로 시작해 2000번 바꿔 보며 다듬으므로 매번 랜덤이다.
-- 4) 뽑는 도중에도 팀 인원 차이는 최대 3명(이미 3명 더 많은 팀으로는 안 감).
-- (명단 29명으로 400번 시뮬레이션: 팀 인원·임원·남녀는 400번 모두 고르게, 부서까지 모두 고른 건 98%. 예전 규칙은 7%)
-- (같은 계획을 3배 빠르게 계산하도록 고친 뒤, 가짜 29명 명단으로 예전 함수와 400번씩 비교해 결과가 같은 것을 확인함)
-- ⚠️ 명단에 있는데 안 누르는 사람이 있으면 그 자리만큼 팀 인원이 어긋날 수 있다 → 안 온 사람은 뽑기 전에 명단에서 지운다.
-- 여럿이 동시에 누르면 pick 끼리만 한 명씩 차례로 처리한다(잠금 번호 261112, 1 — 트랜잭션이 끝나면 저절로 풀림).
--   메뉴 고르기·진행자 저장·읽기는 이 차례를 기다리지 않는다.
--   한 명에 3ms 남짓(개발용 Mac 기준)이라 29명이 한꺼번에 눌러도 0.2초 안에 끝난다. Supabase 무료 플랜이 5배 느려도 1초 안쪽.
--   기다리다 제한 시간을 넘기면 Postgres 오류(57014 등)를 코드 그대로 돌려준다. 참가자 화면이 잠시 뒤 다시 보내고,
--   같은 사람이 다시 보내도 처음 뽑은 팀이 나온다.
create or replace function public.pick(p_dept text, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  teams constant text[] := array['red', 'blue', 'yellow', 'green'];
  me     people;
  mid    bigint;                       -- 내 id(차례가 온 뒤 다시 읽을 때)
  pid    bigint[];                     -- 명단 전체 id (id 순)
  cur    int[];                        -- 사람별 팀 번호 1~4. 뽑은 사람은 고정, 나머지는 계획
  -- 칸 = (그룹, 팀). 그룹은 '전체', 임원 여부, 부서마다, 성별마다 하나씩. 칸 번호 = 그룹 시작 위치 + 팀 번호(1~4)
  b1 int[]; b2 int[]; b3 int[]; b4 int[];  -- 사람별 그룹 시작 위치: 전체·임원 여부·부서·성별(성별이 비면 무게 0인 빈 그룹)
  cw     int[];                        -- 칸별 무게(벌점 배수)
  clo    int[];                        -- 칸별 팀당 최소 = 내림(그룹 인원 / 4)
  chi    int[];                        -- 칸별 팀당 최대 = 올림(그룹 인원 / 4)
  cnt    int[];                        -- 칸별 계획 인원
  todo   int[] := '{}';                -- 아직 안 뽑은 사람(나 포함)
  ok     int[] := '{}';                -- 내가 갈 수 있는 팀
  okb    boolean[] := array[false, false, false, false];  -- 팀마다 내가 갈 수 있는지
  done   int[] := array[0, 0, 0, 0];   -- 팀별 이미 뽑은 인원
  sz     int[];
  n int; nf int; mi int; i int; k int; c int; p int; q int; a int; b int; d int; m int; r int;
  cost int := 0; best int; myteam int;
begin
  -- 지나치게 긴 입력은 바로 거절(누구나 부를 수 있는 함수라, 큰 입력으로 차례를 오래 쥐어 다른 사람을 막지 못하게)
  if char_length(p_dept) > 100 or char_length(p_name) > 100 then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  -- 차례를 기다리기 전에 먼저 확인: 명단에 없거나, 이미 뽑았거나, 메뉴를 안 고른 사람은 기다리지 않고 끝냄
  select * into me from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name);
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  if me.team is not null then
    return me.team;
  end if;
  -- 조식 메뉴를 먼저 골라야 한다(진행자가 메뉴를 지운 뒤 예전에 열어 둔 화면에서 누른 경우도 여기서 막힘)
  if me.menu is null then
    raise exception '조식 메뉴를 먼저 골라 주세요.';
  end if;

  -- 차례 기다리기(pick 끼리만). 앞사람이 커밋한 뒤에 차례가 오므로, 아래에서 새로 읽으면 앞사람이 뽑은 팀이 보인다.
  -- 기다리는 사이 바뀐 것(다른 기기에서 뽑음, 진행자가 지움 등)도 다시 읽어 반영한다.
  perform pg_advisory_xact_lock(261112, 1);
  mid := me.id;
  select * into me from people where id = mid;
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  if me.team is not null then
    return me.team;
  end if;
  if me.menu is null then
    raise exception '조식 메뉴를 먼저 골라 주세요.';
  end if;

  -- 명단·팀·그룹을 한 문장으로 읽는다(그사이 진행자가 명단을 고쳐도 서로 어긋나지 않게)
  with u as (
    select id, team, o, gkey from people,
      unnest(array['all', 'x' || is_exec::text, 'd' || dept, 'g' || gender]) with ordinality as t(gkey, o)),
  gs as (
    select gkey, count(*)::int as gsize, row_number() over (order by gkey)::int as gno
    from u where gkey is not null group by gkey),
  pb as (
    select u.id, u.team, u.o, (coalesce(gs.gno, (select count(*) from gs)::int + 1) - 1) * 4 as base
    from u left join gs using (gkey)),
  cells as (
    select gno, t, case when gkey = 'all' then 10000 when gkey like 'x%' then 20 else 10 end as w,
           gsize / 4 as lo, (gsize + 3) / 4 as hi
    from gs, generate_series(1, 4) t)
  select (select array_agg(id order by id) from pb where o = 1),
         (select array_agg(coalesce(array_position(teams, team), 0) order by id) from pb where o = 1),
         (select array_agg(base order by id) from pb where o = 1),
         (select array_agg(base order by id) from pb where o = 2),
         (select array_agg(base order by id) from pb where o = 3),
         (select array_agg(base order by id) from pb where o = 4),
         (select array_agg(w order by gno, t) from cells) || array[0, 0, 0, 0],  -- 끝의 4칸: 성별이 빈 사람의 빈 그룹
         (select array_agg(lo order by gno, t) from cells) || array[0, 0, 0, 0],
         (select array_agg(hi order by gno, t) from cells) || array[0, 0, 0, 0]
  into pid, cur, b1, b2, b3, b4, cw, clo, chi;
  n  := cardinality(pid);
  mi := array_position(pid, mid);
  if mi is null then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;

  for i in 1..n loop
    if cur[i] > 0 then done[cur[i]] := done[cur[i]] + 1; else todo := todo || i; end if;
  end loop;
  nf := cardinality(todo);

  -- 내가 갈 수 있는 팀: 지금까지 뽑은 인원이 (가장 적은 팀 + 3)명 미만인 팀
  m := least(done[1], done[2], done[3], done[4]);
  for k in 1..4 loop
    if done[k] < m + 3 then okb[k] := true; ok := ok || k; end if;
  end loop;

  -- 첫 계획: 나는 갈 수 있는 팀 중 아무 데나, 나머지는 무작위 순서로 인원 적은 팀부터 채움(적은 팀이 여럿이면 그중 아무 데나)
  cur[mi] := ok[1 + floor(random() * cardinality(ok))::int];
  sz := done;
  sz[cur[mi]] := sz[cur[mi]] + 1;
  for i in select x from unnest(todo) x where x <> mi order by random() loop
    m := least(sz[1], sz[2], sz[3], sz[4]);
    r := 1 + floor(random() * ((sz[1] = m)::int + (sz[2] = m)::int + (sz[3] = m)::int + (sz[4] = m)::int))::int;
    b := 0;
    loop
      b := b + 1;
      if sz[b] = m then r := r - 1; exit when r = 0; end if;
    end loop;
    cur[i] := b;
    sz[b] := sz[b] + 1;
  end loop;

  cnt := array_fill(0, array[cardinality(cw)]);
  for i in 1..n loop
    k := cur[i];
    cnt[b1[i] + k] := cnt[b1[i] + k] + 1;
    cnt[b2[i] + k] := cnt[b2[i] + k] + 1;
    cnt[b3[i] + k] := cnt[b3[i] + k] + 1;
    cnt[b4[i] + k] := cnt[b4[i] + k] + 1;
  end loop;
  for c in 1..cardinality(cw) loop
    cost := cost + cw[c] * (greatest(0, cnt[c] - chi[c]) + greatest(0, clo[c] - cnt[c]));
  end loop;
  cost := cost + done[cur[mi]] - least(done[1], done[2], done[3], done[4]);
  best := cost;
  myteam := cur[mi];

  -- 계획 다듬기: 안 뽑은 사람 둘(p, q)을 골라 팀을 맞바꾸거나(같은 팀이면 p 를 다른 팀으로 옮김),
  -- 벌점이 늘지 않으면 받아들인다. 초반에는 조금 늘어나는 것도 가끔 받아들여 막다른 곳을 빠져나온다.
  -- 벌점이 가장 낮았던 계획의 내 팀을 고른다.
  -- 빠르게 하려고 벌점 변화(d)는 칸 인원을 그대로 둔 채 계산하고, 받아들일 때만 칸 인원을 고친다(고쳤다 되돌리지 않음).
  --   칸 x 에서 한 명 빠질 때: 무게 × (x 인원 <= 최소면 +1, > 최대면 -1, 아니면 0)
  --   칸 y 에 한 명 들어갈 때: 무게 × (y 인원 >= 최대면 +1, < 최소면 -1, 아니면 0)
  --   맞바꿀 때 두 사람이 같은 그룹이면(예: 같은 부서) 그 그룹 인원은 그대로라 0. '전체' 그룹은 늘 같아서 b2~b4 만 본다.
  for step in 1..2000 loop
    p := todo[1 + floor(random() * nf)::int];
    q := todo[1 + floor(random() * nf)::int];
    a := cur[p];
    b := cur[q];
    if a = b then  -- p 를 a 팀에서 다른 팀 b 로 옮김
      b := 1 + floor(random() * 3)::int;
      if b >= a then b := b + 1; end if;
      continue when p = mi and not okb[b];
      q := 0;
      d := cw[b1[p] + a] * (case when cnt[b1[p] + a] <= clo[b1[p] + a] then 1 when cnt[b1[p] + a] > chi[b1[p] + a] then -1 else 0 end)
         + cw[b1[p] + b] * (case when cnt[b1[p] + b] >= chi[b1[p] + b] then 1 when cnt[b1[p] + b] < clo[b1[p] + b] then -1 else 0 end)
         + cw[b2[p] + a] * (case when cnt[b2[p] + a] <= clo[b2[p] + a] then 1 when cnt[b2[p] + a] > chi[b2[p] + a] then -1 else 0 end)
         + cw[b2[p] + b] * (case when cnt[b2[p] + b] >= chi[b2[p] + b] then 1 when cnt[b2[p] + b] < clo[b2[p] + b] then -1 else 0 end)
         + cw[b3[p] + a] * (case when cnt[b3[p] + a] <= clo[b3[p] + a] then 1 when cnt[b3[p] + a] > chi[b3[p] + a] then -1 else 0 end)
         + cw[b3[p] + b] * (case when cnt[b3[p] + b] >= chi[b3[p] + b] then 1 when cnt[b3[p] + b] < clo[b3[p] + b] then -1 else 0 end)
         + cw[b4[p] + a] * (case when cnt[b4[p] + a] <= clo[b4[p] + a] then 1 when cnt[b4[p] + a] > chi[b4[p] + a] then -1 else 0 end)
         + cw[b4[p] + b] * (case when cnt[b4[p] + b] >= chi[b4[p] + b] then 1 when cnt[b4[p] + b] < clo[b4[p] + b] then -1 else 0 end)
         + (case when p = mi then done[b] - done[a] else 0 end);
    else           -- p 는 a → b, q 는 b → a 로 맞바꿈
      continue when (p = mi and not okb[b]) or (q = mi and not okb[a]);
      d := (case when b2[p] = b2[q] then 0 else
              cw[b2[p] + a] * (case when cnt[b2[p] + a] <= clo[b2[p] + a] then 1 when cnt[b2[p] + a] > chi[b2[p] + a] then -1 else 0 end)
            + cw[b2[p] + b] * (case when cnt[b2[p] + b] >= chi[b2[p] + b] then 1 when cnt[b2[p] + b] < clo[b2[p] + b] then -1 else 0 end)
            + cw[b2[q] + b] * (case when cnt[b2[q] + b] <= clo[b2[q] + b] then 1 when cnt[b2[q] + b] > chi[b2[q] + b] then -1 else 0 end)
            + cw[b2[q] + a] * (case when cnt[b2[q] + a] >= chi[b2[q] + a] then 1 when cnt[b2[q] + a] < clo[b2[q] + a] then -1 else 0 end) end)
         + (case when b3[p] = b3[q] then 0 else
              cw[b3[p] + a] * (case when cnt[b3[p] + a] <= clo[b3[p] + a] then 1 when cnt[b3[p] + a] > chi[b3[p] + a] then -1 else 0 end)
            + cw[b3[p] + b] * (case when cnt[b3[p] + b] >= chi[b3[p] + b] then 1 when cnt[b3[p] + b] < clo[b3[p] + b] then -1 else 0 end)
            + cw[b3[q] + b] * (case when cnt[b3[q] + b] <= clo[b3[q] + b] then 1 when cnt[b3[q] + b] > chi[b3[q] + b] then -1 else 0 end)
            + cw[b3[q] + a] * (case when cnt[b3[q] + a] >= chi[b3[q] + a] then 1 when cnt[b3[q] + a] < clo[b3[q] + a] then -1 else 0 end) end)
         + (case when b4[p] = b4[q] then 0 else
              cw[b4[p] + a] * (case when cnt[b4[p] + a] <= clo[b4[p] + a] then 1 when cnt[b4[p] + a] > chi[b4[p] + a] then -1 else 0 end)
            + cw[b4[p] + b] * (case when cnt[b4[p] + b] >= chi[b4[p] + b] then 1 when cnt[b4[p] + b] < clo[b4[p] + b] then -1 else 0 end)
            + cw[b4[q] + b] * (case when cnt[b4[q] + b] <= clo[b4[q] + b] then 1 when cnt[b4[q] + b] > chi[b4[q] + b] then -1 else 0 end)
            + cw[b4[q] + a] * (case when cnt[b4[q] + a] >= chi[b4[q] + a] then 1 when cnt[b4[q] + a] < clo[b4[q] + a] then -1 else 0 end) end)
         + (case when p = mi then done[b] - done[a] when q = mi then done[a] - done[b] else 0 end);
    end if;

    if d <= 0 or (d < 100 and random() < exp(-d / greatest(0.3, 15 * (1 - step / 2000.0::float8)))) then
      if q = 0 then
        cnt[b1[p] + a] := cnt[b1[p] + a] - 1;  cnt[b1[p] + b] := cnt[b1[p] + b] + 1;
        cnt[b2[p] + a] := cnt[b2[p] + a] - 1;  cnt[b2[p] + b] := cnt[b2[p] + b] + 1;
        cnt[b3[p] + a] := cnt[b3[p] + a] - 1;  cnt[b3[p] + b] := cnt[b3[p] + b] + 1;
        cnt[b4[p] + a] := cnt[b4[p] + a] - 1;  cnt[b4[p] + b] := cnt[b4[p] + b] + 1;
      else
        if b2[p] <> b2[q] then
          cnt[b2[p] + a] := cnt[b2[p] + a] - 1;  cnt[b2[p] + b] := cnt[b2[p] + b] + 1;
          cnt[b2[q] + b] := cnt[b2[q] + b] - 1;  cnt[b2[q] + a] := cnt[b2[q] + a] + 1;
        end if;
        if b3[p] <> b3[q] then
          cnt[b3[p] + a] := cnt[b3[p] + a] - 1;  cnt[b3[p] + b] := cnt[b3[p] + b] + 1;
          cnt[b3[q] + b] := cnt[b3[q] + b] - 1;  cnt[b3[q] + a] := cnt[b3[q] + a] + 1;
        end if;
        if b4[p] <> b4[q] then
          cnt[b4[p] + a] := cnt[b4[p] + a] - 1;  cnt[b4[p] + b] := cnt[b4[p] + b] + 1;
          cnt[b4[q] + b] := cnt[b4[q] + b] - 1;  cnt[b4[q] + a] := cnt[b4[q] + a] + 1;
        end if;
        cur[q] := a;
      end if;
      cur[p] := b;
      cost := cost + d;
      if cost <= best then best := cost; myteam := cur[mi]; end if;
    end if;
  end loop;

  -- 계획을 세우는 사이 진행자가 이 사람을 지웠거나 조식을 지웠으면(전체 다시 뽑기 등) 팀을 넣지 않는다
  update people set team = teams[myteam], picked_at = now()
  where id = mid and team is null and menu is not null;
  if not found then
    select * into me from people where id = mid;
    if not found then
      raise exception '명단에 없는 부서·이름이에요.';
    end if;
    if me.team is not null then
      return me.team;
    end if;
    raise exception '조식 메뉴를 먼저 골라 주세요.';
  end if;
  return teams[myteam];
end $$;

-- 일정표 글(진행자가 진행자 화면에서 적음). 명단에 있는 사람만 받을 수 있다: 명단에 없으면 null, 적어 둔 일정이 없으면 ''.
create or replace function public.schedule(p_dept text, p_name text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select value from config where key = 'schedule'), '')
  from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name)
$$;

-- 우리 팀 사람들: 팀을 뽑은 사람에게만 같은 팀 사람들 [{dept, name, title}] (나 포함, 뽑은 차례). 팀이 없거나 명단에 없으면 null.
create or replace function public.team_members(p_dept text, p_name text) returns json
language sql stable security definer set search_path = public as $$
  select json_agg(json_build_object('dept', p.dept, 'name', p.name, 'title', p.title) order by p.picked_at, p.id)
  from people me
  join people p on p.team = me.team
  where me.dept = norm_dept(p_dept) and me.name = norm_name(p_name) and me.team is not null
$$;

-- ── 진행자용 (관리자 비밀번호 필요) ───────────────────────
-- 전체 현황: [{id, dept, name, title, gender, is_exec, team, picked_at, menu, room, activity}, ...]
create or replace function public.board(p_code text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  return (
    select coalesce(json_agg(json_build_object(
             'id', id, 'dept', dept, 'name', name, 'title', title, 'gender', gender,
             'is_exec', is_exec, 'team', team, 'picked_at', picked_at, 'menu', menu,
             'room', room, 'activity', activity)
             order by picked_at nulls last, dept, name), '[]'::json)
    from people
  );
end $$;

-- 진행자 화면이 5초마다 받는 것: {people: board() 와 같은 목록, schedule: 일정표 글}
create or replace function public.board_state(p_code text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  return json_build_object(
    'people', board(p_code),
    'schedule', coalesce((select value from config where key = 'schedule'), ''));
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
-- "menu" 가 들어 있으면 조식 메뉴도 고친다("" 이면 안 고른 상태로 되돌려 그 사람이 다시 고르게 함). 없으면 그대로 둔다.
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
                    when btrim(p_row->>'gender') ~* '^(여|여자|여성|f|female)$' then '여' end,
      menu   = case when p_row ? 'menu' then nullif(p_row->>'menu', '') else menu end
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

-- 팀만 다시 뽑을 수 있게 초기화(조식 메뉴는 그대로). p_id 가 null 이면 모든 사람의 팀.
create or replace function public.admin_reset(p_code text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  update people set team = null, picked_at = null where p_id is null or id = p_id;
end $$;

-- 전체 다시 뽑기: 모든 사람의 팀과 조식 메뉴를 지워 처음부터 다시 하게 한다.
-- admin_reset 과 이름을 달리한 이유: 예전에 열어 둔 진행자 화면의 "전체 다시 뽑기(팀 초기화)"는 admin_reset 을 부르는데,
-- 그 단추가 묻지도 않고 조식까지 지우는 일이 없어야 한다.
create or replace function public.admin_reset_all(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  update people set team = null, picked_at = null, menu = null
  where team is not null or menu is not null;
end $$;

-- 객실·자유시간을 사람마다 넣기: p_what = 'room' 또는 'activity', p_rows = [{"id": 3, "value": "m1"}, ...] ("" 이면 비움).
-- 목록에 없는 사람은 그대로 둔다. 바뀐 사람 수를 돌려준다.
create or replace function public.admin_assign(p_code text, p_what text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform check_admin(p_code);
  if p_what is null or p_what not in ('room', 'activity') then
    raise exception '바꿀 수 없는 항목이에요.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '보낸 내용이 올바르지 않아요. 새로고침한 뒤 다시 해 주세요.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where coalesce(r->>'id', '') !~ '^\d{1,18}$'
       or (coalesce(r->>'value', '') <> ''
           and not (r->>'value' = any (case when p_what = 'room'
                      then array['m1', 'm2', 'm3', 'm4', 'm5', 'f1', 'f2'] else array['ski', 'sauna'] end)))) then
    raise exception '보낸 내용이 올바르지 않아요. 새로고침한 뒤 다시 해 주세요.';
  end if;
  if p_what = 'room' then
    update people p set room = nullif(r->>'value', '')
    from jsonb_array_elements(p_rows) r where p.id = (r->>'id')::bigint;
  else
    update people p set activity = nullif(r->>'value', '')
    from jsonb_array_elements(p_rows) r where p.id = (r->>'id')::bigint;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- 모든 사람의 객실('room') 또는 자유시간('activity')을 비운다.
create or replace function public.admin_clear(p_code text, p_what text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  if p_what = 'room' then
    update people set room = null where room is not null;
  elsif p_what = 'activity' then
    update people set activity = null where activity is not null;
  else
    raise exception '바꿀 수 없는 항목이에요.';
  end if;
end $$;

-- 진행자 설정 저장. 'schedule'(일정표 글, 4000자까지 — 참가자 화면에도 보임)만 바꿀 수 있다(관리자 비밀번호 'admin_code' 는 여기서 못 바꾼다).
-- 고치기 전 일정표 글은 people_log 에 op = 'SCHEDULE' 로 남긴다(잘못 덮어써도 되찾을 수 있게). 글이 그대로면 아무것도 바꾸지 않는다.
create or replace function public.admin_set(p_code text, p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_new text := coalesce(p_value, '');
  v_old text;
begin
  perform check_admin(p_code);
  if p_key is distinct from 'schedule' then
    raise exception '바꿀 수 없는 설정이에요.';
  end if;
  if char_length(v_new) > 4000 then
    raise exception '일정표가 너무 길어요. 4000자까지 적을 수 있어요.';
  end if;
  -- 진행자 두 명이 동시에 저장해도 예전 글이 빠짐없이 남게, 일정표 줄을 잠그고 읽는다(처음 저장이면 빈 줄부터 만든다)
  insert into config (key, value) values ('schedule', '') on conflict (key) do nothing;
  select value into v_old from config where key = 'schedule' for update;
  if v_old is distinct from v_new then
    if v_old <> '' then
      insert into people_log (op, old) values ('SCHEDULE', jsonb_build_object('key', 'schedule', 'value', v_old));
    end if;
    insert into config (key, value) values ('schedule', v_new)
    on conflict (key) do update set value = excluded.value;
  end if;
end $$;

-- ── 실행 권한 ────────────────────────────────────────────
revoke all on function public.norm_dept(text), public.norm_name(text), public.check_admin(text)
  from public, anon, authenticated;

revoke all on function
  public.departments(), public.login(text, text), public.choose_menu(text, text, text), public.pick(text, text), public.schedule(text, text), public.team_members(text, text),
  public.board(text), public.admin_add(text, jsonb), public.admin_update(text, bigint, jsonb),
  public.admin_remove(text, bigint), public.admin_reset(text, bigint), public.admin_reset_all(text),
  public.board_state(text), public.admin_assign(text, text, jsonb), public.admin_clear(text, text), public.admin_set(text, text, text)
  from public;
grant execute on function
  public.departments(), public.login(text, text), public.choose_menu(text, text, text), public.pick(text, text), public.schedule(text, text), public.team_members(text, text),
  public.board(text), public.admin_add(text, jsonb), public.admin_update(text, bigint, jsonb),
  public.admin_remove(text, bigint), public.admin_reset(text, bigint), public.admin_reset_all(text),
  public.board_state(text), public.admin_assign(text, text, jsonb), public.admin_clear(text, text), public.admin_set(text, text, text)
  to anon, authenticated;

-- ── 참가자 요청의 제한 시간 ───────────────────────────────
-- Supabase 는 참가자 화면(anon)의 요청이 3초를 넘으면 취소한다(오류 코드 57014). 뽑기는 한 명씩 차례로 처리하므로
-- 여럿이 한꺼번에 누르면 뒤에 선 사람은 앞사람들을 기다린 시간까지 이 안에 들어야 한다. 서버가 느릴 때를 대비해 8초로 늘린다.
-- (참가자 화면은 요청 하나를 20초까지 기다리므로 그보다 짧게 잡는다. 시간 초과(57014)면 화면이 잠시 뒤 다시 보낸다.)
-- 이 앱에서 anon 은 위에서 허락한 함수만 부르고, 모두 금방 끝나는 함수라 늘려도 오래 붙잡히는 요청은 없다.
-- 권한이 없어 못 바꾸면 경고만 남기고 나머지는 그대로 설치된다. 확인: select rolconfig from pg_roles where rolname = 'anon';
do $$
begin
  alter role anon set statement_timeout = '8s';
exception when others then
  raise warning 'anon 의 제한 시간을 바꾸지 못했어요(Supabase 기본 3초 그대로): %', sqlerrm;
end $$;
notify pgrst, 'reload config';  -- Supabase API(PostgREST)가 바뀐 제한 시간을 바로 읽게 함
