-- 팀 뽑기 (빨강·파랑·노랑·초록) — Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 Run.
--
-- ⚠️ Run 하기 전에 아래 [관리자 비밀번호] 의 '여기를-바꾸세요' 를 편집기에서 바꾸세요.
--    이 파일은 공개 저장소에 있으니 파일 자체에는 비밀번호를 적지 마세요.
--    다시 Run 할 때 '여기를-바꾸세요' 를 그대로 두면 기존 비밀번호가 유지돼요.
--
-- 구조: 참가자 화면은 테이블에 직접 접근하지 못하고, 아래 함수들만 부를 수 있다.
--   departments() / login() / pick()          ← 참가자용 (누구나)
--   board() / admin_add() / admin_remove() / admin_reset()  ← 진행자용 (관리자 비밀번호 필요)

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
-- 1) 지금 인원이 가장 적은 팀들 중에서 → 팀 인원 차이는 항상 최대 1명
-- 2) 내 부서 사람이 가장 적은 팀을 고르고 → 부서가 흩어짐
-- 3) 그래도 같으면 랜덤
create or replace function public.pick(p_dept text, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  me     people;
  chosen text;
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

  with t(team) as (values ('red'), ('blue'), ('yellow'), ('green')),
  c as (
    select t.team,
           count(p.id) as total,
           count(p.id) filter (where p.dept = me.dept) as same_dept
    from t left join people p on p.team = t.team
    group by t.team
  )
  select c.team into chosen
  from c
  where c.total = (select min(total) from c)
  order by c.same_dept, random()
  limit 1;

  update people set team = chosen, picked_at = now() where id = me.id;
  return chosen;
end $$;

-- ── 진행자용 (관리자 비밀번호 필요) ───────────────────────
-- 전체 현황: [{id, dept, name, team, picked_at}, ...]
create or replace function public.board(p_code text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  return (
    select coalesce(json_agg(json_build_object(
             'id', id, 'dept', dept, 'name', name, 'team', team, 'picked_at', picked_at)
             order by picked_at nulls last, dept, name), '[]'::json)
    from people
  );
end $$;

-- 명단 추가: p_rows = [{"dept": "개발팀", "name": "홍길동"}, ...]. 이미 있으면 건너뜀. 추가된 수를 돌려줌.
create or replace function public.admin_add(p_code text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform check_admin(p_code);
  insert into people (dept, name)
  select distinct norm_dept(r->>'dept'), norm_name(r->>'name')
  from jsonb_array_elements(p_rows) r
  where norm_dept(r->>'dept') <> '' and norm_name(r->>'name') <> ''
  on conflict (dept, name) do nothing;
  get diagnostics n = row_count;
  return n;
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
  public.board(text), public.admin_add(text, jsonb),
  public.admin_remove(text, bigint), public.admin_reset(text, bigint)
  from public;
grant execute on function
  public.departments(), public.login(text, text), public.pick(text, text),
  public.board(text), public.admin_add(text, jsonb),
  public.admin_remove(text, bigint), public.admin_reset(text, bigint)
  to anon, authenticated;
