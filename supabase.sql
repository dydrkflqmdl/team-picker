-- 팀 뽑기 (빨강·파랑·노랑·초록) — Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 Run.
--
-- ⚠️ Run 하기 전에 아래 [관리자 비밀번호] 의 '여기를-바꾸세요' 를 편집기에서 바꾸세요.
--    이 파일은 공개 저장소에 있으니 파일 자체에는 비밀번호를 적지 마세요.
--    다시 Run 할 때 '여기를-바꾸세요' 를 그대로 두면 기존 비밀번호가 유지돼요.
--
-- 구조: 참가자 화면은 테이블에 직접 접근하지 못하고, 아래 함수들만 부를 수 있다.
--   departments() / login() / choose_lunch() / choose_menu() / choose_activity() / pick() / pick_room() / schedule() / team_members() / room_members()  ← 참가자용 (누구나)
--   로그인 뒤 일정·방 뽑기·팀 뽑기·18일 점심·아침 메뉴·자유시간은 아무 순서로나 할 수 있다(서로 먼저 해야 하는 것이 없다).
--   board() / admin_add() / admin_update() / admin_remove() / admin_reset() / admin_reset_all()  ← 진행자용 (관리자 비밀번호 필요)
-- 일정표: 진행자가 진행자 화면에서 적고(admin_set), 참가자 화면이 schedule() 로 받아 보여준다.
-- 객실은 참가자가 직접 뽑고(pick_room — 한 번 뽑으면 끝) 참가자 화면이 room_members() 로 같은 방 사람을 받아 보여준다.
--   진행자는 방을 직접 옮기거나, 비워서(admin_assign·admin_clear) 다시 뽑게 하거나, 방 없는 사람을 한꺼번에 넣을 수 있다.
-- 18일 점심(일반·얼큰 설렁탕, choose_lunch)·18일 아침 메뉴(choose_menu)·금요일 저녁 뒤 자유시간(스키·휴식, choose_activity)은 참가자가 직접 고르고, 마감(choices_closed() — 11월 25일 15시, 한국 시간) 전까지 몇 번이든 바꿀 수 있다.
--   마감 뒤에는 참가자가 처음 고르는 것도 바꾸는 것도 서버가 막는다. 진행자는 마감 뒤에도 계속 고칠 수 있다(admin_assign).
--   board_state() / admin_assign() / admin_clear() / admin_set()  ← 진행자용 (관리자 비밀번호 필요)
-- 여럿이 동시에 뽑을 때: pick() 끼리, pick_room() 끼리만 한 명씩 차례로 처리한다(둘은 서로 다른 차례라 서로 기다리지 않음).
--   메뉴 고르기·진행자 저장·읽기는 뽑기를 기다리지 않는다.
-- 참가자 요청의 제한 시간: 맨 아래에서 anon 을 8초로 늘린다(Supabase 기본 3초).
-- 되돌리기용 기록(people_log): 명단 줄이 바뀌거나 지워질 때, 일정표를 고칠 때 예전 값을 남긴다.

-- 이전 버전(명단·기록) 테이블 정리 — 비어 있음
drop table if exists public.members, public.draws;
-- 이전 버전에 잠깐 있던 참가자용 함수 정리(일정표·객실·자유시간을 참가자 화면에 켜는 장치). choose_activity 는 아래에서 다시 만든다.
drop function if exists public.extras(text, text);

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
-- 조식 메뉴(12월 18일 금요일 아침). 고르기 전에는 비어 있고, 참가자가 마감(choices_closed()) 전까지 고르고 바꿀 수 있다.
-- 'ugeoji' = 우거지 해장국, 'miyeok' = 소고기 미역국, 'hwangtae' = 버섯 황태 해장국
alter table public.people
  add column if not exists menu text check (menu in ('ugeoji', 'miyeok', 'hwangtae'));
-- 객실: 남자 방 'm1'~'m5', 여자 방 'f1'·'f2'. 참가자가 직접 뽑고(pick_room), 자기 방과 같은 방 사람을 볼 수 있다. 진행자도 고칠 수 있다.
-- 자유시간(12월 18일 금요일 저녁 식사 뒤): 'ski' = 스키, 'rest' = 휴식. 참가자가 마감(choices_closed()) 전까지 직접 고르고 바꿀 수 있다.
alter table public.people
  add column if not exists room     text check (room in ('m1', 'm2', 'm3', 'm4', 'm5', 'f1', 'f2')),
  add column if not exists activity text check (activity in ('ski', 'rest'));
-- 예전 버전에는 'sauna'(사우나)가 있었다. 위 add column 은 칸이 이미 있으면 새 조건을 달지 않으므로, 예전 조건을 떼고
-- 'sauna' 는 'rest' 로 바꾼 뒤 새 조건을 단다. 몇 번 다시 Run 해도 괜찮다(이미 새 조건이면 아무것도 안 한다).
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.people'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%activity%' and pg_get_constraintdef(oid) not like '%rest%'
  loop
    execute format('alter table public.people drop constraint %I', c.conname);
  end loop;
  update public.people set activity = 'rest' where activity = 'sauna';
  if not exists (select 1 from pg_constraint where conrelid = 'public.people'::regclass and conname = 'people_activity_check') then
    alter table public.people add constraint people_activity_check check (activity in ('ski', 'rest'));
  end if;
end $$;
-- 점심(12월 18일 금요일): 'plain' = 일반 설렁탕, 'spicy' = 얼큰 설렁탕. 참가자가 마감(choices_closed()) 전까지 고르고 바꿀 수 있다. 진행자도 고칠 수 있다.
alter table public.people add column if not exists lunch text check (lunch in ('plain', 'spicy'));

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

-- 점심·아침 메뉴·자유시간 마감: 2026-11-25 15:00 한국 시간부터 참가자는 고르지도 바꾸지도 못한다(진행자는 계속 가능).
-- 마감 시각은 이 함수에만 적는다. 바꿀 때는 common.js 의 CHOICE_DEADLINE(·LABEL·SHORT)도 함께 고치고 이 파일을 다시 Run 한다.
create or replace function public.choices_closed() returns boolean
language sql stable as $$
  select now() >= timestamptz '2026-11-25 15:00:00+09'
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

-- 명단에 있으면 {dept, name, team, menu, room, activity, lunch}, 없으면 null (room·activity·lunch 는 아직 없으면 null)
create or replace function public.login(p_dept text, p_name text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('dept', dept, 'name', name, 'team', team, 'menu', menu, 'room', room, 'activity', activity, 'lunch', lunch)
  from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name)
$$;

-- 18일(금) 점심 고르기: 'plain' = 일반 설렁탕, 'spicy' = 얼큰 설렁탕. 자유시간처럼 마감(choices_closed()) 전까지는 이미 골랐어도 바꿀 수 있다(새 값으로 덮어씀).
-- 마감 뒤에는 처음 고르기도 바꾸기도 거절한다(진행자는 admin_assign 으로 고칠 수 있음). 저장된 값을 돌려준다.
create or replace function public.choose_lunch(p_dept text, p_name text, p_lunch text) returns text
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  -- 지나치게 긴 입력은 정리하거나 줄을 잠그기 전에 바로 거절(누구나 부를 수 있는 함수라, 큰 입력으로 다른 사람을 막지 못하게)
  if char_length(p_dept) > 100 or char_length(p_name) > 100 then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  if p_lunch is null or p_lunch not in ('plain', 'spicy') then
    raise exception '점심 메뉴를 다시 골라 주세요.';
  end if;
  if choices_closed() then
    raise exception '점심·아침 메뉴와 자유시간은 11월 25일(수) 15시까지만 고르고 바꿀 수 있어요. 바꾸려면 진행자에게 말해 주세요.';
  end if;
  -- 값이 같으면 줄을 다시 쓰지 않는다(같은 걸 또 눌러도 되돌리기 기록이 쌓이지 않게)
  update people set lunch = p_lunch
  where dept = norm_dept(p_dept) and name = norm_name(p_name) and lunch is distinct from p_lunch;
  select lunch into v from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name);
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  return v;
end $$;

-- 조식 메뉴 고르기. 한 사람이 하나만 고르되, 마감(choices_closed()) 전까지는 이미 골랐어도 바꿀 수 있다(새 값으로 덮어씀).
-- 마감 뒤에는 처음 고르기도 바꾸기도 거절한다(진행자는 admin_assign 으로 고칠 수 있음). 저장된 값을 돌려준다.
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
  if choices_closed() then
    raise exception '점심·아침 메뉴와 자유시간은 11월 25일(수) 15시까지만 고르고 바꿀 수 있어요. 바꾸려면 진행자에게 말해 주세요.';
  end if;
  -- 값이 같으면 줄을 다시 쓰지 않는다(같은 걸 또 눌러도 되돌리기 기록이 쌓이지 않게)
  update people set menu = p_menu
  where dept = norm_dept(p_dept) and name = norm_name(p_name) and menu is distinct from p_menu;
  select menu into v from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name);
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  return v;
end $$;

-- 자유시간(금요일 저녁 식사 뒤) 고르기: 'ski' = 스키, 'rest' = 휴식. 조식처럼 마감(choices_closed()) 전까지는 이미 골랐어도 바꿀 수 있다(새 값으로 덮어씀).
-- 마감 뒤에는 처음 고르기도 바꾸기도 거절한다. 저장된 값을 돌려준다.
create or replace function public.choose_activity(p_dept text, p_name text, p_activity text) returns text
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  -- 지나치게 긴 입력은 정리하거나 줄을 잠그기 전에 바로 거절(누구나 부를 수 있는 함수라, 큰 입력으로 다른 사람을 막지 못하게)
  if char_length(p_dept) > 100 or char_length(p_name) > 100 then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  if p_activity is null or p_activity not in ('ski', 'rest') then
    raise exception '자유시간을 다시 골라 주세요.';
  end if;
  if choices_closed() then
    raise exception '점심·아침 메뉴와 자유시간은 11월 25일(수) 15시까지만 고르고 바꿀 수 있어요. 바꾸려면 진행자에게 말해 주세요.';
  end if;
  -- 값이 같으면 줄을 다시 쓰지 않는다(같은 걸 또 눌러도 되돌리기 기록이 쌓이지 않게)
  update people set activity = p_activity
  where dept = norm_dept(p_dept) and name = norm_name(p_name) and activity is distinct from p_activity;
  select activity into v from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name);
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  return v;
end $$;

-- 팀 뽑기. 이미 뽑았으면 그 팀을 그대로 돌려준다(한 번만). 조식 메뉴를 고르지 않았어도 뽑을 수 있다(순서 상관없음).
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
  -- 차례를 기다리기 전에 먼저 확인: 명단에 없거나 이미 뽑은 사람은 기다리지 않고 끝냄
  select * into me from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name);
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  if me.team is not null then
    return me.team;
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

  -- 계획을 세우는 사이 진행자가 이 사람을 지웠으면 팀을 넣지 않는다(이미 팀이 들어 있으면 그 팀을 돌려줌)
  update people set team = teams[myteam], picked_at = now()
  where id = mid and team is null;
  if not found then
    select * into me from people where id = mid;
    if not found then
      raise exception '명단에 없는 부서·이름이에요.';
    end if;
    if me.team is not null then
      return me.team;
    end if;
    raise exception '잠시 뒤 다시 눌러 주세요.';  -- 줄은 있고 팀도 비었는데 못 넣은 경우(사실상 없음)
  end if;
  return teams[myteam];
end $$;

-- 방 뽑기. 남녀 따로, 같은 부서 사람은 되도록 같은 방, 직급은 보지 않고 무작위. 한 번 뽑으면 끝(다시 부르면 같은 방을 돌려줌).
-- 다시 뽑게 하려면 진행자가 그 사람(또는 전원)의 방을 비운다(admin_assign·admin_clear).
-- 생각은 팀 뽑기(pick)와 같다: 누를 때마다 '같은 성별에서 아직 방이 없는 사람 전원(나 포함)을 그 성별의 방에 어떻게 넣으면
-- 가장 좋은지' 계획을 새로 세우고, 그 계획의 내 방을 준다. 이미 방이 있는 사람(뽑았거나 진행자가 넣은 사람)은 그대로 둔다.
-- 1) 방 인원: 그 성별 인원 ÷ 방 수의 내림~올림 사이면 0, 벗어난 만큼 벌점 10000(반드시 맞춤). 예: 남 20명 5실 → 4명씩, 여 9명 2실 → 5·4명.
-- 2) 같은 부서 모으기: 방마다 '그 방에 있는 부서 수'를 더한 것(= (방, 부서) 짝의 수)이 벌점. 적을수록 같은 부서가 한 방에 모인다.
--    부서가 방보다 크면 쪼개지는 건 어쩔 수 없다(그래도 되도록 적은 방으로).
-- 3) 계획은 무작위 부서 순서로 '같은 부서가 이미 있는 방, 없으면 빈자리가 많은 방'에 채워 넣어 시작하고, 3000번 바꿔 보며 다듬는다.
--    벌점이 같은 계획끼리는 무작위라 매번 다르다.
-- 뽑을 때마다 (이미 뽑은 사람을 그대로 둔 채) 가장 좋은 계획을 따르므로, 모두 다 뽑으면 처음부터 한꺼번에 나눈 것만큼 좋은 나눔이 된다.
-- 뽑는 도중의 방 인원은 맞추지 않는다(예: 첫 두 사람이 같은 부서면 같은 방). 마지막 인원은 계획이 맞춘다.
-- (가짜 29명 명단(남 20·여 9, 부서 6개)으로 시험: 한 명씩 무작위 순서로 다 뽑기 400번 모두 방 인원이 맞고 (방, 부서) 짝의 수가
--  이론상 가장 적은 값(남 7·여 6)이었다. 진행자가 8명·15명을 먼저 아무 방에 넣어 둔 뒤 나머지가 뽑기 600번은 599번이 그 상태의
--  가장 적은 값, 1번이 그보다 1 많음. 한 명에 7ms 남짓(개발용 Mac)이라 29명이 한꺼번에 눌러도 0.2초 안에 끝난다.)
-- ⚠️ 명단에 있는데 안 누르는 사람이 있으면 그 자리만큼 방 인원이 어긋날 수 있다 → 진행자가 '방 없는 사람만 넣기'로 채운다.
-- 성별이 빈 사람은 뽑을 수 없고(진행자가 성별을 넣거나 직접 방을 넣음) 계획에서도 뺀다.
-- 진행자가 다른 성별의 방에 직접 넣은 사람도 계획에서 뺀다(그 사람은 그 방에 그대로 둠).
-- 여럿이 동시에 누르면 pick_room 끼리만 한 명씩 차례로 처리한다(잠금 번호 261112, 2 — 팀 뽑기의 261112, 1 과 달라 서로 기다리지 않음).
--   메뉴 고르기·팀 뽑기·진행자 저장·읽기는 이 차례를 기다리지 않는다. 기다리다 제한 시간을 넘기면 Postgres 오류(57014 등)를
--   코드 그대로 돌려준다. 참가자 화면이 잠시 뒤 다시 보내고, 같은 사람이 다시 보내도 처음 뽑은 방이 나온다.
create or replace function public.pick_room(p_dept text, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  me     people;
  mid    bigint;                       -- 내 id(차례가 온 뒤 다시 읽을 때)
  rooms  text[];                       -- 내 성별의 방 키
  nr     int;                          -- 방 수
  pid    bigint[];                     -- 계획에 드는 사람(같은 성별) id
  pd     int[];                        -- 사람별 부서 번호 1~nd
  cur    int[];                        -- 사람별 방 번호 1~nr. 방이 있는 사람은 고정, 나머지는 계획
  cnt    int[];                        -- 방별 계획 인원
  dc     int[];                        -- (부서, 방) 칸별 계획 인원. 칸 번호 = (부서 번호 - 1) × nr + 방 번호
  tc     int[];                        -- (부서, 방) 칸별 계획 인원 중 아직 방이 없는 사람(옮길 수 있는 사람)만
  cap    int[];                        -- 첫 계획에서 방마다 채울 인원
  dk     float8[];                     -- 첫 계획에서 부서를 줄 세울 무작위 순서
  todo   int[] := '{}';                -- 아직 방이 없는 사람(나 포함)
  nd int; n int; nf int; mi int; lo int; hi int; extra int;
  i int; j int; k int; p int; q int; a int; b int; xp int; xq int; m int; d int; dg int; e float8;
  cost int := 0; best int; myroom int;
  steps constant int := 3000;
begin
  -- 지나치게 긴 입력은 바로 거절(누구나 부를 수 있는 함수라, 큰 입력으로 차례를 오래 쥐어 다른 사람을 막지 못하게)
  if char_length(p_dept) > 100 or char_length(p_name) > 100 then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  -- 차례를 기다리기 전에 먼저 확인: 명단에 없거나, 이미 방이 있거나, 성별이 없는 사람은 기다리지 않고 끝냄
  select * into me from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name);
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  if me.room is not null then
    return me.room;
  end if;
  if me.gender is null then
    raise exception '명단에 성별이 없어 방을 뽑을 수 없어요. 진행자에게 말해 주세요.';
  end if;

  -- 차례 기다리기(pick_room 끼리만). 앞사람이 커밋한 뒤에 차례가 오므로, 아래에서 새로 읽으면 앞사람이 뽑은 방이 보인다.
  -- 기다리는 사이 바뀐 것(다른 기기에서 뽑음, 진행자가 방을 넣음·성별을 고침·지움 등)도 다시 읽어 반영한다.
  perform pg_advisory_xact_lock(261112, 2);
  mid := me.id;
  select * into me from people where id = mid;
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  if me.room is not null then
    return me.room;
  end if;
  if me.gender is null then
    raise exception '명단에 성별이 없어 방을 뽑을 수 없어요. 진행자에게 말해 주세요.';
  end if;
  rooms := case me.gender when '남' then array['m1', 'm2', 'm3', 'm4', 'm5'] else array['f1', 'f2'] end;
  nr := cardinality(rooms);

  -- 같은 성별 사람(방이 없거나 이 성별의 방에 있는 사람)과 부서·방을 한 문장으로 읽는다
  with g as (
    select id, dense_rank() over (order by dept)::int as dno, coalesce(array_position(rooms, room), 0) as r
    from people
    where gender = me.gender and (room is null or room = any (rooms)))
  select array_agg(id order by id), array_agg(dno order by id), array_agg(r order by id), max(dno)
  into pid, pd, cur, nd from g;
  n  := coalesce(cardinality(pid), 0);
  mi := array_position(pid, mid);
  if mi is null then  -- 두 번 읽는 사이 진행자가 이 사람을 고친 경우(사실상 없음)
    raise exception '잠시 뒤 다시 눌러 주세요.';
  end if;
  lo := n / nr;                -- 방마다 최소(내림)
  hi := (n + nr - 1) / nr;     -- 방마다 최대(올림)

  cnt := array_fill(0, array[nr]);
  dc  := array_fill(0, array[nd * nr]);
  tc  := array_fill(0, array[nd * nr]);
  for i in 1..n loop
    if cur[i] > 0 then
      cnt[cur[i]] := cnt[cur[i]] + 1;
      dc[(pd[i] - 1) * nr + cur[i]] := dc[(pd[i] - 1) * nr + cur[i]] + 1;
    else
      todo := todo || i;
    end if;
  end loop;
  nf := cardinality(todo);

  -- 첫 계획: 방마다 채울 인원을 정하고(최소 인원, 이미 그보다 많으면 지금 인원, 남는 자리는 아직 최대가 아닌 방 아무 데나 한 명씩),
  -- 방 없는 사람을 부서끼리 붙여 무작위 부서 순서로 한 명씩, 자리가 남은 방 중 '같은 부서가 가장 많은 방(이미 방이 있는 사람 포함),
  -- 같으면 빈자리가 많은 방, 그래도 같으면 아무 데나'에 넣는다. 이미 방이 있는 사람의 부서를 따라가므로 다듬기가 덜 헤맨다.
  cap := array_fill(lo, array[nr]);
  for k in 1..nr loop
    cap[k] := greatest(lo, cnt[k]);
  end loop;
  extra := n;
  for k in 1..nr loop
    extra := extra - cap[k];
  end loop;
  while extra > 0 loop
    select k2 into k from generate_series(1, nr) k2 order by (cap[k2] < hi) desc, random() limit 1;
    cap[k] := cap[k] + 1;
    extra := extra - 1;
  end loop;
  select array_agg(random()) into dk from generate_series(1, nd);
  for i in select x from unnest(todo) x order by dk[pd[x]], random() loop
    select k2 into k from generate_series(1, nr) k2
    where cnt[k2] < cap[k2]
    order by dc[(pd[i] - 1) * nr + k2] desc, cap[k2] - cnt[k2] desc, random() limit 1;
    if not found then  -- 자리는 늘 남지만, 혹시 모자라면 아무 방에나
      k := 1 + floor(random() * nr)::int;
    end if;
    cur[i] := k;
    cnt[k] := cnt[k] + 1;
    dc[(pd[i] - 1) * nr + k] := dc[(pd[i] - 1) * nr + k] + 1;
    tc[(pd[i] - 1) * nr + k] := tc[(pd[i] - 1) * nr + k] + 1;
  end loop;

  for k in 1..nr loop
    cost := cost + 10000 * (greatest(0, cnt[k] - hi) + greatest(0, lo - cnt[k]));
  end loop;
  for k in 1..nd * nr loop
    if dc[k] > 0 then cost := cost + 1; end if;
  end loop;
  best := cost;
  myroom := cur[mi];

  -- 계획 다듬기: 방 없는 사람 둘(p, q)을 골라
  --   같은 방이면 p 를 다른 방으로 옮기고,
  --   다른 방·다른 부서면 맞바꾼다. 절반은 두 사람만, 절반은 두 사람이 속한 '부서 덩어리'를 같은 수만큼 통째로 맞바꾼다
  --   (예: p 방의 영업부 3명 중 2명 ↔ q 방의 품질부 2명). 한 명씩 맞바꾸면 벌점이 두 번 올랐다 내려가야 하는 자리 바꿈을
  --   한 번에 할 수 있어, 이미 방이 정해진 사람이 몇 있을 때도 가장 좋은 계획을 잘 찾는다.
  --   같은 부서 둘이면 맞바꿔도 벌점은 그대로고 누가 어느 방인지만 바뀐다.
  -- 벌점이 늘지 않으면 받아들인다. 초반에는 조금 늘어나는 것도 가끔 받아들여 막다른 곳을 빠져나온다.
  -- 벌점이 같은 계획 사이는 자유롭게 오가므로 누가 어느 방인지가 무작위가 된다.
  -- 벌점이 가장 낮았던 계획(같으면 나중 것)의 내 방을 고른다.
  -- 빠르게 하려고 벌점 변화(d)는 바뀌는 칸만 보고 계산한다(m = 옮기는 사람 수).
  --   방 인원: x 방에서 한 명 빠질 때 10000 × (x 인원 <= 최소면 +1, > 최대면 -1, 아니면 0), y 방에 들어갈 때 (>= 최대면 +1, < 최소면 -1)
  --   부서 짝: (부서, 빠지는 방) 칸이 m명이었으면 짝이 없어져 -1, (부서, 들어가는 방) 칸이 0명이었으면 짝이 생겨 +1
  -- 길잡이: 짝의 수만 보면 벌점이 같은 계획이 너무 많아(평평해서) 더 나은 계획 쪽으로 가는 길을 잘 못 찾는다.
  --   그래서 앞쪽 80% 동안은 '같은 부서끼리 한 방에 더 많이 모이는 쪽'(칸 인원² 의 합, 바뀐 양 dg)을 조금 더 쳐 준다.
  --   이 덤은 점점 줄어 뒤쪽 20% 에는 0 이라, 마지막 고르기는 위 벌점만 본다(덤 때문에 결과 기준이 바뀌지 않음).
  for step in 1..steps loop
    p := todo[1 + floor(random() * nf)::int];
    q := todo[1 + floor(random() * nf)::int];
    a := cur[p];
    b := cur[q];
    xp := (pd[p] - 1) * nr;
    xq := (pd[q] - 1) * nr;
    if a = b then  -- p 를 a 방에서 다른 방 b 로 옮김
      b := 1 + floor(random() * (nr - 1))::int;
      if b >= a then b := b + 1; end if;
      q := 0;
      m := 1;
      d := 10000 * ((case when cnt[a] <= lo then 1 when cnt[a] > hi then -1 else 0 end)
                  + (case when cnt[b] >= hi then 1 when cnt[b] < lo then -1 else 0 end))
         + (case when dc[xp + a] = 1 then -1 else 0 end) + (case when dc[xp + b] = 0 then 1 else 0 end);
      dg := 2 * (dc[xp + b] - dc[xp + a] + 1);
    elsif xp = xq then  -- 같은 부서 둘을 맞바꿈: 벌점은 그대로
      m := 1;
      d := 0;
      dg := 0;
    else           -- p 쪽 m명은 a → b, q 쪽 m명은 b → a (방 인원은 그대로)
      m := case when random() < 0.5 then 1 else least(tc[xp + a], tc[xq + b]) end;
      d := (case when dc[xp + a] = m then -1 else 0 end) + (case when dc[xp + b] = 0 then 1 else 0 end)
         + (case when dc[xq + b] = m then -1 else 0 end) + (case when dc[xq + a] = 0 then 1 else 0 end);
      dg := 2 * m * (dc[xp + b] - dc[xp + a] + m) + 2 * m * (dc[xq + a] - dc[xq + b] + m);
    end if;

    -- e = 벌점 변화 - 길잡이 덤. 방 인원을 어기는 변화(d >= 100)는 받지 않고, 나머지는 e 가 0 이하면 받고 아니면 온도에 따라 가끔 받는다.
    e := d - 1.5 * greatest(0, 1 - step / (0.8 * steps)) * dg;
    if d < 100 and (e <= 0 or random() < exp(-e / greatest(0.1, 1 - step / steps::float8))) then
      if q = 0 then
        cnt[a] := cnt[a] - 1;  cnt[b] := cnt[b] + 1;
      else
        cur[q] := a;
      end if;
      cur[p] := b;
      if m > 1 then  -- 덩어리 맞바꾸기: p·q 말고 m - 1 명씩 더 옮긴다(같은 부서 안에서 누구든 벌점은 같음)
        i := m - 1;
        j := m - 1;
        for k in select x from unnest(todo) x order by random() loop
          exit when i = 0 and j = 0;
          if k <> p and k <> q then
            if i > 0 and pd[k] = pd[p] and cur[k] = a then cur[k] := b; i := i - 1;
            elsif j > 0 and pd[k] = pd[q] and cur[k] = b then cur[k] := a; j := j - 1;
            end if;
          end if;
        end loop;
      end if;
      dc[xp + a] := dc[xp + a] - m;  dc[xp + b] := dc[xp + b] + m;
      tc[xp + a] := tc[xp + a] - m;  tc[xp + b] := tc[xp + b] + m;
      if q > 0 then
        dc[xq + b] := dc[xq + b] - m;  dc[xq + a] := dc[xq + a] + m;
        tc[xq + b] := tc[xq + b] - m;  tc[xq + a] := tc[xq + a] + m;
      end if;
      cost := cost + d;
      if cost <= best then best := cost; myroom := cur[mi]; end if;
    end if;
  end loop;

  -- 계획을 세우는 사이 진행자가 이 사람에게 방을 넣었거나, 지웠거나, 성별을 바꿨으면 그것을 따른다
  update people set room = rooms[myroom]
  where id = mid and room is null and gender = me.gender;
  if not found then
    select * into me from people where id = mid;
    if not found then
      raise exception '명단에 없는 부서·이름이에요.';
    end if;
    if me.room is not null then
      return me.room;
    end if;
    if me.gender is null then
      raise exception '명단에 성별이 없어 방을 뽑을 수 없어요. 진행자에게 말해 주세요.';
    end if;
    raise exception '잠시 뒤 다시 눌러 주세요.';  -- 그사이 성별이 바뀐 경우: 다시 누르면 바뀐 성별의 방에서 뽑음
  end if;
  return rooms[myroom];
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

-- 같은 방 사람들: 객실이 정해진 사람에게만 같은 방 사람들 [{dept, name, title}] (나 포함, 부서·이름 순). 방이 없거나 명단에 없으면 null.
create or replace function public.room_members(p_dept text, p_name text) returns json
language sql stable security definer set search_path = public as $$
  select json_agg(json_build_object('dept', p.dept, 'name', p.name, 'title', p.title) order by p.dept, p.name)
  from people me
  join people p on p.room = me.room
  where me.dept = norm_dept(p_dept) and me.name = norm_name(p_name) and me.room is not null
$$;

-- ── 진행자용 (관리자 비밀번호 필요) ───────────────────────
-- 전체 현황: [{id, dept, name, title, gender, is_exec, team, picked_at, menu, room, activity, lunch}, ...]
create or replace function public.board(p_code text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  return (
    select coalesce(json_agg(json_build_object(
             'id', id, 'dept', dept, 'name', name, 'title', title, 'gender', gender,
             'is_exec', is_exec, 'team', team, 'picked_at', picked_at, 'menu', menu,
             'room', room, 'activity', activity, 'lunch', lunch)
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

-- 객실·자유시간·조식·점심을 사람마다 넣기: p_what = 'room' 또는 'activity' 또는 'menu'(ugeoji·miyeok·hwangtae) 또는 'lunch'(plain·spicy). 진행자는 참가자 마감(choices_closed()) 뒤에도 쓸 수 있다. p_rows = [{"id": 3, "value": "m1"}, ...] ("" 이면 비움).
-- 목록에 없는 사람은 그대로 둔다. 바뀐 사람 수를 돌려준다.
create or replace function public.admin_assign(p_code text, p_what text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform check_admin(p_code);
  if p_what is null or p_what not in ('room', 'activity', 'menu', 'lunch') then
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
                      then array['m1', 'm2', 'm3', 'm4', 'm5', 'f1', 'f2']
                      when p_what = 'menu' then array['ugeoji', 'miyeok', 'hwangtae']
                      when p_what = 'lunch' then array['plain', 'spicy']
                      else array['ski', 'rest'] end)))) then
    raise exception '보낸 내용이 올바르지 않아요. 새로고침한 뒤 다시 해 주세요.';
  end if;
  if p_what = 'room' then
    update people p set room = nullif(r->>'value', '')
    from jsonb_array_elements(p_rows) r where p.id = (r->>'id')::bigint;
  elsif p_what = 'menu' then
    update people p set menu = nullif(r->>'value', '')
    from jsonb_array_elements(p_rows) r where p.id = (r->>'id')::bigint;
  elsif p_what = 'lunch' then
    update people p set lunch = nullif(r->>'value', '')
    from jsonb_array_elements(p_rows) r where p.id = (r->>'id')::bigint;
  else
    update people p set activity = nullif(r->>'value', '')
    from jsonb_array_elements(p_rows) r where p.id = (r->>'id')::bigint;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- 모든 사람의 객실('room')·자유시간('activity')·점심('lunch')을 비운다.
create or replace function public.admin_clear(p_code text, p_what text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  if p_what = 'room' then
    update people set room = null where room is not null;
  elsif p_what = 'activity' then
    update people set activity = null where activity is not null;
  elsif p_what = 'lunch' then
    update people set lunch = null where lunch is not null;
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
revoke all on function public.norm_dept(text), public.norm_name(text), public.check_admin(text), public.choices_closed()
  from public, anon, authenticated;

revoke all on function
  public.departments(), public.login(text, text), public.choose_lunch(text, text, text), public.choose_menu(text, text, text), public.choose_activity(text, text, text), public.pick(text, text), public.pick_room(text, text), public.schedule(text, text), public.team_members(text, text), public.room_members(text, text),
  public.board(text), public.admin_add(text, jsonb), public.admin_update(text, bigint, jsonb),
  public.admin_remove(text, bigint), public.admin_reset(text, bigint), public.admin_reset_all(text),
  public.board_state(text), public.admin_assign(text, text, jsonb), public.admin_clear(text, text), public.admin_set(text, text, text)
  from public;
grant execute on function
  public.departments(), public.login(text, text), public.choose_lunch(text, text, text), public.choose_menu(text, text, text), public.choose_activity(text, text, text), public.pick(text, text), public.pick_room(text, text), public.schedule(text, text), public.team_members(text, text), public.room_members(text, text),
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

-- ══ 탑승 차량 뽑기 ═══════════════════════════════════════
-- 이 묶음은 위의 다른 기능과 따로 떨어져 있다(위 함수·권한 줄은 건드리지 않음). 여러 번 Run 해도 안전하다:
-- 칸은 없을 때만 더하고, 차량 목록(config 'cars')은 처음 한 번만 넣으므로 진행자가 고친 목록과 뽑은 결과는 그대로 남는다.
--   pick_car() / car_state()                                        ← 참가자용 (누구나)
--   board_cars() / admin_set_car() / admin_clear_cars() / admin_set_cars()  ← 진행자용 (관리자 비밀번호 필요)
-- 규칙: 성별·나이·직급·부서를 전혀 보지 않는 완전 무작위. 남은 빈자리 하나하나가 같은 확률이다
--   (= 차량마다 남은 자리 수에 비례해서 고름). 한 번 뽑으면 끝.
-- 정원: 차량마다 seats 를 적으면 그 숫자, 비워 두면 "자동(반씩)". 자동 차량의 정원은 뽑을 때마다 그때의 명단으로 다시 센다:
--   N = 명단 인원 - (명단에 실제로 있는) 운전자 수, F = seats 를 적은 차량들의 seats 합, A = 자동 차량 수
--   자동 차량 하나의 정원 = ceil(max(N - F, 0) / A)
--   두 대 모두 자동이면 정원이 ceil(N/2) 씩이라, 모두 뽑으면 두 차량의 차이는 1명 이내이고(N 이 홀수면 남는 빈자리 하나가
--   무작위 차량에 생김), 빈자리마다 같은 확률로 고르므로 누구나 뽑는 차례와 상관없이 각 차량에 1/2 확률이다.
--   명단에서 사람이 지워져 정원보다 많이 탄 차량은 더 뽑히지 않을 뿐 오류를 내지 않는다.
-- 운전자: 차량마다 driver(명단의 사람 id)를 고를 수 있다. 운전자는 정원에 들지 않고, 뽑지 않아도 그 차량에 탄다
--   (people.car 는 비워 두고 config 로만 정한다. 그래서 탄 인원·정원 계산·차량 모두 비우기가 손님만 다룬다).
--   운전자가 pick_car 를 부르면 뽑지 않고 운전하는 차량 id 를 돌려준다. 운전자가 명단에서 지워지면 그 차량은 운전자 없음으로 보인다.
-- 여럿이 동시에 누를 때: pick_car 와 진행자의 차량 넣기·비우기·목록 저장은 한 명씩 차례로 처리한다
--   (잠금 번호 261112, 3 — 팀 뽑기(1)·방 뽑기(2)와 달라 서로 기다리지 않음). 정원 계산도 차례 안에서 하므로 어느 차량도 정원을 넘지 않는다.
-- 차량 변경도 위 people_log 트리거가 그대로 남긴다(op = 'UPDATE', 바뀌기 전 줄 전체). 차량 목록을 고치면 고치기 전 목록을 op = 'CARS' 로 남긴다.

-- 사람마다 탄 차량(config 'cars' 의 id, 없으면 null)과 배정된 시각(같은 차량 안의 순서용). 운전자는 여기에 넣지 않는다.
alter table public.people
  add column if not exists car    text check (car ~ '^[a-z0-9_-]{1,20}$'),
  add column if not exists car_at timestamptz;

-- 차량 목록: [{"id": 영문 소문자·숫자·_·- 1~20자, "name": 보이는 이름 1~30자, "label": 함께 보이는 문구 0~30자(예: '○○님 차량'),
--              "seats": 정원(운전자 뺀 손님 자리 수, 1~99, 없으면 자동), "driver": 운전자(명단의 사람 id, 없으면 운전자 미지정)}, ...] (이 순서대로 보임)
-- 처음 한 번만 넣는다(on conflict do nothing). 다시 Run 해도 진행자가 관리자 페이지에서 고친 목록은 그대로 남는다.
-- 처음 값은 차량 두 대, 정원 자동(반씩), 운전자·문구 없음. 운전자와 문구('○○님 차량')는 배포 뒤 관리자 페이지에서 고른다
-- (저장소에 실제 이름을 남기지 않으려고 여기에는 적지 않음).
insert into public.config (key, value) values
  ('cars', '[{"id": "car1", "name": "1호차", "label": ""}, {"id": "car2", "name": "2호차", "label": ""}]')
on conflict (key) do nothing;

-- 차량 목록 검사. 맞으면 null, 틀리면 무엇이 틀렸는지 한국어 문구를 돌려준다(admin_set_cars 와 car_list 가 같이 씀).
-- 운전자가 명단에 있는지는 여기서 보지 않는다(운전자가 명단에서 지워져도 뽑기는 그대로 되게). 저장할 때 admin_set_cars 가 본다.
create or replace function public.car_check(j jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare
  e       jsonb;
  ids     text[] := '{}';
  names   text[] := '{}';
  drvs    text[] := '{}';   -- 운전자 id (겹침 검사용)
  dnames  text[] := '{}';   -- 그 운전자의 차량 이름
  v_id    text;
  v_name  text;
  v_seats text;
  v_drv   text;
  k       int;
begin
  if j is null or jsonb_typeof(j) <> 'array' then
    return '차량 목록은 [ … ] 모양의 목록이어야 해요.';
  end if;
  if jsonb_array_length(j) < 1 or jsonb_array_length(j) > 20 then
    return '차량은 1대에서 20대까지 둘 수 있어요.';
  end if;
  for e in select x from jsonb_array_elements(j) x loop
    if jsonb_typeof(e) <> 'object' then
      return '차량 하나하나는 {"id", "name"} 모양이어야 해요.';
    end if;
    v_id := e->>'id';
    if jsonb_typeof(e->'id') is distinct from 'string' or v_id !~ '^[a-z0-9_-]{1,20}$' then
      return format('차량 id "%s" 가 올바르지 않아요. 영문 소문자·숫자·_·- 로 1~20자예요.', left(coalesce(v_id, ''), 30));
    end if;
    if v_id = any (ids) then
      return format('차량 id "%s" 가 두 번 있어요.', v_id);
    end if;
    v_name := btrim(e->>'name');
    if jsonb_typeof(e->'name') is distinct from 'string' or char_length(v_name) not between 1 and 30 then
      return format('차량 "%s" 의 이름은 1~30자여야 해요.', v_id);
    end if;
    if v_name = any (names) then
      return format('차량 이름 "%s" 가 두 번 있어요.', v_name);
    end if;
    -- 문구: 없거나 null 이면 빈 문구. 있으면 글자로 30자까지(앞뒤 공백은 빼고 셈)
    if coalesce(jsonb_typeof(e->'label'), 'null') not in ('null', 'string') then
      return format('"%s" 의 문구는 글자로 적어 주세요.', v_name);
    end if;
    if jsonb_typeof(e->'label') = 'string' and char_length(btrim(e->>'label')) > 30 then
      return format('"%s" 의 문구는 30자까지 적을 수 있어요.', v_name);
    end if;
    -- 정원: 없거나 null 이면 자동. 있으면 1~99 정수(숫자로 바꾸기 전에 모양부터 봐서 글자·소수·아주 큰 수를 거름)
    if coalesce(jsonb_typeof(e->'seats'), 'null') <> 'null' then
      v_seats := e->>'seats';
      if jsonb_typeof(e->'seats') <> 'number' or v_seats !~ '^[0-9]{1,2}$' or v_seats::int < 1 then
        return format('"%s" 의 정원은 비워 두거나(자동) 1~99 사이의 정수여야 해요.', v_name);
      end if;
    end if;
    -- 운전자: 없거나 null 이면 미지정. 있으면 명단의 사람 번호(양의 정수), 한 사람은 한 차량만
    if coalesce(jsonb_typeof(e->'driver'), 'null') <> 'null' then
      v_drv := e->>'driver';
      if jsonb_typeof(e->'driver') <> 'number' or v_drv !~ '^[1-9][0-9]{0,17}$' then
        return format('"%s" 의 운전자 값이 올바르지 않아요(명단의 사람 번호여야 해요).', v_name);
      end if;
      k := array_position(drvs, v_drv);
      if k is not null then
        return format('한 사람이 "%s"·"%s" 두 차량의 운전자예요. 한 차량에만 골라 주세요.', dnames[k], v_name);
      end if;
      drvs := drvs || v_drv;
      dnames := dnames || v_name;
    end if;
    ids := ids || v_id;
    names := names || v_name;
  end loop;
  return null;
end $$;

-- 예전 모양(운전자·문구 칸이 없던 것)의 car_list 가 있으면 한 번만 지운다(돌려주는 칸이 바뀌어 create or replace 로는 못 바꿈)
do $$
begin
  if to_regprocedure('public.car_list()') is not null
     and not exists (select 1 from pg_proc where oid = to_regprocedure('public.car_list()') and 'driver' = any (proargnames)) then
    drop function public.car_list();
  end if;
end $$;

-- 지금 차량 목록을 적힌 그대로 표로(config 순서). seats 가 null 이면 자동, driver 가 null 이면 운전자 미지정.
-- 목록이 깨져 있으면(SQL Editor 에서 잘못 고친 경우) 알아볼 수 있는 오류를 낸다.
create or replace function public.car_list()
returns table (ord int, id text, name text, label text, seats int, driver bigint)
language plpgsql stable set search_path = public as $$
declare
  v   text;
  j   jsonb;
  msg text;
begin
  select c.value into v from config c where c.key = 'cars';
  if v is null then
    raise exception '차량 목록이 아직 없어요(config 의 cars). 진행자에게 말해 주세요.';
  end if;
  begin
    j := v::jsonb;
  exception when others then
    j := null;
  end;
  if j is null then
    raise exception '차량 목록이 잘못 저장돼 있어요(config 의 cars 가 JSON 이 아니에요). 진행자에게 말해 주세요.';
  end if;
  msg := car_check(j);
  if msg is not null then
    raise exception '차량 목록이 잘못 저장돼 있어요(config 의 cars: %). 진행자에게 말해 주세요.', msg;
  end if;
  return query
    select t.o::int, t.e->>'id', btrim(t.e->>'name'), coalesce(btrim(t.e->>'label'), ''),
           (t.e->>'seats')::int, (t.e->>'driver')::bigint
    from jsonb_array_elements(j) with ordinality as t(e, o)
    order by t.o;
end $$;

-- 차량 목록 + 지금 정원(자동이면 그때의 명단으로 계산). driver_ok = 운전자가 명단에 실제로 있음.
--   N = 명단 인원 - 명단에 있는 운전자 수, F = 적은 seats 합, A = 자동 차량 수 → 자동 정원 = ceil(max(N - F, 0) / A)
create or replace function public.car_caps()
returns table (ord int, id text, name text, label text, seats int, auto boolean, driver bigint, driver_ok boolean)
language plpgsql stable set search_path = public as $$
begin
  return query
    with l as materialized (select * from car_list()),
    d as (select l.ord as o, (l.driver is not null and exists (select 1 from people p where p.id = l.driver)) as ok from l),
    k as (select ((select count(*) from people) - (select count(*) from d where d.ok))::int as n,
                 coalesce((select sum(l.seats) from l where l.seats is not null), 0)::int as f,
                 (select count(*) from l where l.seats is null)::int as a)
    select l.ord, l.id, l.name, l.label,
           coalesce(l.seats, ceil(greatest(k.n - k.f, 0)::numeric / greatest(k.a, 1))::int),
           l.seats is null, l.driver, d.ok
    from l join d on d.o = l.ord cross join k
    order by l.ord;
end $$;

-- ── 참가자용 ─────────────────────────────────────────────
-- 차량 뽑기. 돌려주는 값은 차량 id.
-- 운전자면 뽑지 않고 운전하는 차량을, 이미 차량이 있으면 그 차량을 그대로 돌려준다(새로 뽑지 않음).
-- 빈자리가 남은 차량들 가운데 남은 자리 수에 비례해 무작위로 고른다(빈자리 하나하나가 같은 확률).
-- 성별·나이·직급·부서는 보지 않는다.
-- 마감(choices_closed() — 점심·조식·자유시간과 같은 11월 25일(수) 15시, 한국 시간) 뒤에는 아직 차량이 없는 참가자를 거절한다.
--   오류 문구는 기존 고르기와 같은 "…까지만 고르고 바꿀 수 있어요" 꼴. 이미 뽑은 사람·운전자는 마감 뒤에도 자기 차량을 돌려받는다.
--   car_state 와 진행자 함수(admin_set_car·admin_clear_cars·admin_set_cars)는 마감과 상관없이 된다.
--   choices_closed() 는 now()(요청이 시작된 시각) 기준이라, 마감 전에 눌러 차례를 기다린 사람은 마감을 조금 넘겨 배정돼도 받아들여진다(choose_lunch 등과 같은 기준).
create or replace function public.pick_car(p_dept text, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  me    people;
  mid   bigint;        -- 내 id(차례가 온 뒤 다시 읽을 때)
  ids   text[];        -- 차량 id (config 순서)
  frees int[];         -- 차량별 남은 자리
  total int := 0;      -- 남은 자리 합
  r     int;
  k     int;
  v     text;
begin
  -- 지나치게 긴 입력은 바로 거절(누구나 부를 수 있는 함수라, 큰 입력으로 차례를 오래 쥐어 다른 사람을 막지 못하게)
  if char_length(p_dept) > 100 or char_length(p_name) > 100 then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  -- 차례를 기다리기 전에 먼저 확인: 명단에 없거나, 운전자거나, 이미 차량이 있는 사람은 기다리지 않고 끝냄
  select * into me from people
  where dept = norm_dept(p_dept) and name = norm_name(p_name);
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  select c.id into v from car_list() c where c.driver = me.id;
  if v is not null then
    return v;
  end if;
  if me.car is not null then
    return me.car;
  end if;
  -- 마감(choices_closed(), 점심·조식·자유시간과 같은 시각) 뒤에는 아직 차량이 없는 사람을 거절(빠른 거절. 최종 판단은 아래 차례 안에서 한 번 더).
  -- 문구는 기존 고르기와 같은 "…까지만 고르고 바꿀 수 있어요" 꼴이라 화면이 마감 거절로 알아봄(common.js 의 CHOICE_CLOSED_ERR)
  if choices_closed() then
    raise exception '탑승 차량 뽑기는 11월 25일(수) 15시까지만 고르고 바꿀 수 있어요. 차량은 진행자에게 말해 주세요.';
  end if;

  -- 차례 기다리기(pick_car·진행자 차량 바꾸기끼리만). 앞사람이 커밋한 뒤에 차례가 오므로 아래에서 새로 읽으면 앞사람이 탄 자리가 보인다.
  -- 기다리는 사이 바뀐 것(다른 기기에서 뽑음, 진행자가 넣음·지움·운전자 지정 등)도 다시 읽어 반영한다.
  perform pg_advisory_xact_lock(261112, 3);
  mid := me.id;
  select * into me from people where id = mid;
  if not found then
    raise exception '명단에 없는 부서·이름이에요.';
  end if;
  select c.id into v from car_list() c where c.driver = mid;
  if v is not null then
    return v;
  end if;
  if me.car is not null then
    return me.car;
  end if;
  -- 마감 최종 판단(차례 안). 이미 차량이 있는 사람·운전자는 위에서 자기 차량을 돌려받았으므로 여기까지 온 사람만 거절
  if choices_closed() then
    raise exception '탑승 차량 뽑기는 11월 25일(수) 15시까지만 고르고 바꿀 수 있어요. 차량은 진행자에게 말해 주세요.';
  end if;

  -- 차량별 남은 자리 = 지금 정원 - 지금 탄 인원(0 아래로는 안 내려감. 사람이 지워져 정원보다 많이 탄 차량은 0)
  select array_agg(c.id order by c.ord), array_agg(greatest(0, c.seats - coalesce(n.cnt, 0)) order by c.ord)
  into ids, frees
  from car_caps() c
  left join (select p.car, count(*)::int as cnt from people p where p.car is not null group by p.car) n
    on n.car = c.id;
  for k in 1..coalesce(cardinality(ids), 0) loop
    total := total + frees[k];
  end loop;
  if total = 0 then
    raise exception '빈자리가 있는 차량이 없어요. 진행자에게 말해 주세요.';
  end if;

  -- 빈자리 0 ~ total-1 중 하나를 고르고, 그 자리가 속한 차량을 찾는다
  r := floor(random() * total)::int;
  v := null;
  for k in 1..cardinality(ids) loop
    r := r - frees[k];
    if r < 0 then
      v := ids[k];
      exit;
    end if;
  end loop;

  update people set car = v, car_at = clock_timestamp()
  where id = mid and car is null;
  if not found then
    select * into me from people where id = mid;
    if not found then
      raise exception '명단에 없는 부서·이름이에요.';
    end if;
    if me.car is not null then
      return me.car;
    end if;
    raise exception '잠시 뒤 다시 눌러 주세요.';  -- 줄은 있고 차량도 비었는데 못 넣은 경우(사실상 없음)
  end if;
  return v;
end $$;

-- 참가자 화면의 차량 현황. 명단에 없으면 null. 있으면
-- {"cars": [{id, name, label, seats(지금 정원), auto(자동 정원인지), count(지금 탄 손님 수),
--            driver: {dept, name, title} 또는 null(운전자 미지정·명단에 없음)}] (config 순서),
--  "car": 내 차량 id(운전자면 운전하는 차량) 또는 null,
--  "members": 내 차량에 탄 손님 [{dept, name, title}] (배정된 순서. 손님이면 나 포함, 운전자면 손님만이라 빈 목록일 수 있음) 또는 null(차량이 없을 때)}
create or replace function public.car_state(p_dept text, p_name text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'cars', (select coalesce(json_agg(json_build_object(
                      'id', c.id, 'name', c.name, 'label', c.label, 'seats', c.seats, 'auto', c.auto,
                      'count', (select count(*) from people p where p.car = c.id),
                      'driver', (select json_build_object('dept', p.dept, 'name', p.name, 'title', p.title)
                                 from people p where p.id = c.driver)) order by c.ord), '[]'::json)
             from car_caps() c),
    'car', x.car,
    'members', case when x.car is null then null else
                 coalesce((select json_agg(json_build_object('dept', p.dept, 'name', p.name, 'title', p.title) order by p.car_at, p.id)
                           from people p where p.car = x.car), '[]'::json) end)
  from people me
  cross join lateral (select coalesce((select c.id from car_list() c where c.driver = me.id), me.car) as car) x
  where me.dept = norm_dept(p_dept) and me.name = norm_name(p_name)
$$;

-- ── 진행자용 (관리자 비밀번호 필요) ───────────────────────
-- 차량 현황: {"cars": [{id, name, label, seats(지금 정원), auto, driver(사람 id 또는 null — 명단에서 지워진 사람일 수도 있음)}] (config 순서),
--            "people": [{id, dept, name, title, gender, car, car_at}] (명단 전원, 안 뽑은 사람·운전자 포함. 운전자의 car 는 null)}
create or replace function public.board_cars(p_code text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  return json_build_object(
    'cars', (select coalesce(json_agg(json_build_object(
                      'id', c.id, 'name', c.name, 'label', c.label, 'seats', c.seats, 'auto', c.auto, 'driver', c.driver)
                      order by c.ord), '[]'::json)
             from car_caps() c),
    'people', (select coalesce(json_agg(json_build_object(
                        'id', p.id, 'dept', p.dept, 'name', p.name, 'title', p.title, 'gender', p.gender,
                        'car', p.car, 'car_at', p.car_at)
                        order by p.car_at nulls last, p.dept, p.name), '[]'::json)
               from people p));
end $$;

-- 한 사람의 차량을 직접 넣거나 옮긴다. p_car 가 null 이나 '' 이면 비운다(= 그 사람이 다시 뽑게 함).
-- 정원(자동이면 지금 계산된 정원)을 넘게는 못 넣는다(pick_car 와 같은 차례를 써서 동시에 뽑는 사람과 엇갈리지 않음).
-- 운전자는 손님으로 넣지 못한다(운전자는 차량 목록에서 바꿈).
create or replace function public.admin_set_car(p_code text, p_id bigint, p_car text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_car   text := nullif(p_car, '');
  v_old   text;
  v_seats int;
  v_cnt   int;
begin
  perform check_admin(p_code);
  perform pg_advisory_xact_lock(261112, 3);
  select car into v_old from people where id = p_id;
  if not found then
    raise exception '명단에서 그 사람을 찾을 수 없어요. 새로고침해 주세요.';
  end if;
  if v_car is null then
    update people set car = null, car_at = null where id = p_id and (car is not null or car_at is not null);
    return;
  end if;
  if exists (select 1 from car_list() c where c.driver = p_id) then
    raise exception '운전자는 차량 목록 고치기에서 바꿔요.';
  end if;
  select c.seats into v_seats from car_caps() c where c.id = v_car;
  if not found then
    raise exception '없는 차량이에요. 새로고침해 주세요.';
  end if;
  if v_old is not distinct from v_car then
    return;  -- 이미 그 차량
  end if;
  select count(*) into v_cnt from people where car = v_car;
  if v_cnt >= v_seats then
    raise exception '그 차량은 자리가 다 찼어요(정원 %명).', v_seats;
  end if;
  update people set car = v_car, car_at = clock_timestamp() where id = p_id;
end $$;

-- 모든 사람의 차량을 비운다(처음부터 다시 뽑기). 운전자 지정(차량 목록)은 그대로 둔다.
create or replace function public.admin_clear_cars(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_admin(p_code);
  perform pg_advisory_xact_lock(261112, 3);
  update people set car = null, car_at = null where car is not null or car_at is not null;
end $$;

-- 차량 목록 저장: p_cars = [{"id": "car1", "name": "1호차", "label": "○○님 차량", "seats": 정원(없으면 자동), "driver": 사람 id(없으면 미지정)}, ...]
-- 검사: 1~20대, id 는 영문 소문자·숫자·_·- 1~20자로 겹치지 않음, 이름 1~30자로 겹치지 않음, 문구 0~30자,
--   정원은 없거나 1~99 정수, 운전자는 명단에 있는 사람으로 차량끼리 겹치지 않고 어느 차량의 손님도 아님.
-- 탄 사람이 있는 차량을 빼거나, 정원을 적었는데 지금 탄 인원보다 작으면 거절한다(먼저 사람을 옮기거나 비움).
-- 이름·문구 앞뒤 공백은 지우고 id·name·label·seats·driver 만 남겨 저장한다. 고치기 전 목록은 people_log 에 op = 'CARS' 로 남긴다.
create or replace function public.admin_set_cars(p_code text, p_cars jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  msg     text;
  v_old   text;
  v_oldj  jsonb;
  v_new   text;
  r       record;
  pp      people;
begin
  perform check_admin(p_code);
  msg := car_check(p_cars);
  if msg is not null then
    raise exception '%', msg;
  end if;
  perform pg_advisory_xact_lock(261112, 3);
  select value into v_old from config where key = 'cars';
  -- 오류 문구에 쓸 예전 이름(예전 목록이 깨져 있어도 저장은 되게, 읽기 실패는 무시)
  begin
    v_oldj := v_old::jsonb;
  exception when others then
    v_oldj := null;
  end;
  if v_oldj is null or jsonb_typeof(v_oldj) <> 'array' then
    v_oldj := '[]'::jsonb;
  end if;
  for r in
    select p.car, count(*)::int as cnt, e.e as ne,
           coalesce((select btrim(o->>'name') from jsonb_array_elements(v_oldj) o
                     where jsonb_typeof(o) = 'object' and o->>'id' = p.car limit 1), p.car) as oname
    from people p
    left join lateral (select x as e from jsonb_array_elements(p_cars) x where x->>'id' = p.car) e on true
    where p.car is not null
    group by p.car, e.e
    order by p.car
  loop
    if r.ne is null then
      raise exception '"%" 에 탄 사람이 %명 있어 목록에서 뺄 수 없어요. 먼저 그 사람들의 차량을 비우거나 옮겨 주세요.', r.oname, r.cnt;
    end if;
    if jsonb_typeof(r.ne->'seats') = 'number' and (r.ne->>'seats')::int < r.cnt then
      raise exception '"%" 의 정원(%명)이 지금 탄 인원(%명)보다 적어요. 먼저 사람을 옮기거나 비워 주세요.',
        btrim(r.ne->>'name'), (r.ne->>'seats')::int, r.cnt;
    end if;
  end loop;
  -- 운전자: 명단에 있어야 하고, 어느 차량의 손님으로도 타 있지 않아야 함(먼저 직접 옮기기에서 비움)
  for r in
    select btrim(t.e->>'name') as cname, (t.e->>'driver')::bigint as drv
    from jsonb_array_elements(p_cars) with ordinality as t(e, o)
    where jsonb_typeof(t.e->'driver') = 'number'
    order by t.o
  loop
    select * into pp from people where id = r.drv;
    if not found then
      raise exception '"%" 의 운전자가 명단에 없어요(명단에서 지워진 사람이에요). 운전자를 다시 골라 주세요.', r.cname;
    end if;
    if pp.car is not null then
      raise exception '% 님이 이미 %에 손님으로 타 있어요. 먼저 비워 주세요.', pp.name,
        coalesce((select btrim(x->>'name') from jsonb_array_elements(p_cars) x where x->>'id' = pp.car limit 1), pp.car);
    end if;
  end loop;
  select jsonb_agg(
           jsonb_build_object('id', t.e->>'id', 'name', btrim(t.e->>'name'), 'label', coalesce(btrim(t.e->>'label'), ''))
           || case when jsonb_typeof(t.e->'seats') = 'number' then jsonb_build_object('seats', (t.e->>'seats')::int) else '{}'::jsonb end
           || case when jsonb_typeof(t.e->'driver') = 'number' then jsonb_build_object('driver', (t.e->>'driver')::bigint) else '{}'::jsonb end
           order by t.o)::text
  into v_new
  from jsonb_array_elements(p_cars) with ordinality as t(e, o);
  if v_old is distinct from v_new then
    if v_old is not null then
      insert into people_log (op, old) values ('CARS', jsonb_build_object('key', 'cars', 'value', v_old));
    end if;
    insert into config (key, value) values ('cars', v_new)
    on conflict (key) do update set value = excluded.value;
  end if;
end $$;

-- 차량 뽑기 실행 권한(이 묶음의 함수만). 안쪽 함수(car_check·car_list·car_caps)는 아무도 직접 못 부른다.
revoke all on function public.car_check(jsonb), public.car_list(), public.car_caps() from public, anon, authenticated;
revoke all on function
  public.pick_car(text, text), public.car_state(text, text),
  public.board_cars(text), public.admin_set_car(text, bigint, text), public.admin_clear_cars(text), public.admin_set_cars(text, jsonb)
  from public;
grant execute on function
  public.pick_car(text, text), public.car_state(text, text),
  public.board_cars(text), public.admin_set_car(text, bigint, text), public.admin_clear_cars(text), public.admin_set_cars(text, jsonb)
  to anon, authenticated;
notify pgrst, 'reload schema';  -- Supabase API(PostgREST)가 새 함수를 바로 알게 함
