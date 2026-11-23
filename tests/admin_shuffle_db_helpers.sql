-- 자동 섞기(admin_shuffle)·아침 메뉴 비우기 시험용 보조 함수(로컬 임시 Postgres 에서만 씀. 운영 DB 에서 Run 하지 말 것).
-- tests/car_db_helpers.sql(스키마 t, t.gate·t.seed·t.counts·t.overfull 등) 다음에 Run 한다. 견본 이름은 모두 지어낸 이름이다.

-- 지어낸 명단 29명(남 20·여 9, 부서 6개 D1~D6, 7번째마다 '이사') — tests/room-random/stats.mjs·seed.sql 과 같은 명단.
-- p_unsexed 가 true 면 성별 없는 사람 1명(D3 / X01)을 더한다. 메뉴·점심·자유시간도 채워 둔다(다른 칸이 안 바뀌는지 보려고).
create or replace function t.seed29(p_unsexed boolean default false) returns void
language plpgsql as $$
begin
  delete from public.people;
  insert into public.people (dept, name, title, gender, menu, lunch, activity)
  select d, nm, case when i % 7 = 0 then '이사' else '사원' end, g,
         (array['ugeoji', 'miyeok', 'hwangtae'])[1 + i % 3], (array['plain', 'spicy'])[1 + i % 2], (array['ski', 'rest'])[1 + (i / 2) % 2]
  from (values
   (1,'D1','M01','남'),(2,'D1','M02','남'),(3,'D1','M03','남'),(4,'D1','M04','남'),(5,'D1','M05','남'),(6,'D1','F01','여'),(7,'D1','F02','여'),(8,'D1','F03','여'),
   (9,'D2','M06','남'),(10,'D2','M07','남'),(11,'D2','M08','남'),(12,'D2','M09','남'),(13,'D2','F04','여'),(14,'D2','F05','여'),
   (15,'D3','M10','남'),(16,'D3','M11','남'),(17,'D3','M12','남'),(18,'D3','F06','여'),(19,'D3','F07','여'),
   (20,'D4','M13','남'),(21,'D4','M14','남'),(22,'D4','M15','남'),(23,'D4','F08','여'),
   (24,'D5','M16','남'),(25,'D5','M17','남'),(26,'D5','F09','여'),
   (27,'D6','M18','남'),(28,'D6','M19','남'),(29,'D6','M20','남')) v(i, d, nm, g)
  order by i;
  if p_unsexed then
    insert into public.people (dept, name, title, gender, menu) values ('D3', 'X01', '사원', null, 'miyeok');
  end if;
  update public.config set value = '[{"id": "car1", "name": "1호차", "label": ""}, {"id": "car2", "name": "2호차", "label": ""}]' where key = 'cars';
  truncate public.people_log;
end $$;

-- 정한 칸(들)을 뺀 나머지 칸 전부를 사람마다 한 줄로(다른 칸이 안 바뀌었는지 비교용)
create or replace function t.rowsig(p_skip text[]) returns text
language sql as $$
  select coalesce(string_agg((to_jsonb(p) - p_skip)::text, E'\n' order by p.id), '') from public.people p;
$$;

-- 한 칸을 'id:값,…' 으로
create or replace function t.col(p_col text) returns text
language sql as $$
  select coalesce(string_agg(p.id || ':' || coalesce(to_jsonb(p)->>p_col, '-'), ',' order by p.id), '') from public.people p;
$$;

-- 팀 규칙 검사(pick 의 기준): 그룹(전체·임원 여부·부서마다·성별마다)마다 팀 인원이 (그룹 인원 ÷ 4)의 내림~올림 사이인지.
-- 'size:어긋난 칸 수,exec:…,dept:…,gender:…,none:팀 없는 사람 수'
create or replace function t.team_check() returns text
language sql as $$
  with u as (
    select p.team, k.cat, k.gkey from public.people p,
      lateral (values ('size', 'all'), ('exec', p.is_exec::text), ('dept', p.dept), ('gender', p.gender)) k(cat, gkey)
    where k.gkey is not null),
  g as (select cat, gkey, count(*)::int as n from u group by 1, 2),
  c as (select g.cat, g.gkey, g.n, t.tm, (select count(*) from u where u.cat = g.cat and u.gkey = g.gkey and u.team = t.tm)::int as k
        from g, unnest(array['red', 'blue', 'yellow', 'green']) t(tm))
  select format('size:%s,exec:%s,dept:%s,gender:%s,none:%s',
    count(*) filter (where cat = 'size' and (k < n / 4 or k > (n + 3) / 4)),
    count(*) filter (where cat = 'exec' and (k < n / 4 or k > (n + 3) / 4)),
    count(*) filter (where cat = 'dept' and (k < n / 4 or k > (n + 3) / 4)),
    count(*) filter (where cat = 'gender' and (k < n / 4 or k > (n + 3) / 4)),
    (select count(*) from public.people where team is null))
  from c;
$$;

-- 방 규칙 검사: 'mixed:남녀가 섞인 사람 수,m:남자 방 인원(m1~m5, 정렬),f:여자 방 인원(정렬),nogender_room:성별 없는데 방 있는 사람 수,sexed_none:성별 있는데 방 없는 사람 수'
create or replace function t.room_check() returns text
language sql as $$
  select format('mixed:%s,m:%s,f:%s,nogender_room:%s,sexed_none:%s',
    (select count(*) from public.people where (gender = '남' and room like 'f%') or (gender = '여' and room like 'm%')),
    (select string_agg(c::text, ',' order by c) from (select (select count(*) from public.people p where p.room = r and p.gender = '남') c
                                                       from unnest(array['m1', 'm2', 'm3', 'm4', 'm5']) r) s),
    (select string_agg(c::text, ',' order by c) from (select (select count(*) from public.people p where p.room = r and p.gender = '여') c
                                                       from unnest(array['f1', 'f2']) r) s),
    (select count(*) from public.people where gender is null and room is not null),
    (select count(*) from public.people where gender is not null and room is null));
$$;

-- 비교 기준(자동 섞기 없이 기존 함수만으로 같은 일): 발표용 뽑기 화면처럼 '그 항목을 비우고(all) → 정해지지 않은 사람을 무작위 순서로 줄 세워
-- → 한 명씩 참가자 함수(pick·pick_room·pick_car)를 부름'. 줄 세우기는 id 순으로 모아 섞는다(draw.js shuffle 과 같은 방식).
-- 같은 setseed 로 시작하면 admin_shuffle 과 결과가 한 글자도 같아야 한다(= 자동 섞기가 참가자 함수 말고 다른 규칙을 쓰지 않음).
-- 차량은 pick_car 를 부르므로 마감 전에만 쓴다.
create or replace function t.ref_shuffle(p_code text, p_what text, p_mode text) returns void
language plpgsql as $$
declare
  ids bigint[]; x public.people; i int; j int; tmp bigint;
begin
  if p_mode = 'all' then
    if p_what = 'team' then perform public.admin_reset(p_code, null);
    elsif p_what = 'room' then perform public.admin_clear(p_code, 'room');
    else perform public.admin_clear_cars(p_code);
    end if;
  end if;
  select coalesce(array_agg(p.id order by p.id), '{}') into ids from public.people p
  where case p_what when 'team' then p.team is null when 'room' then p.room is null else p.car is null end;
  for i in reverse coalesce(cardinality(ids), 0)..2 loop
    j := 1 + floor(random() * i)::int;
    tmp := ids[i]; ids[i] := ids[j]; ids[j] := tmp;
  end loop;
  for i in 1..coalesce(cardinality(ids), 0) loop
    select * into x from public.people where id = ids[i];
    if p_what = 'team' then
      perform public.pick(x.dept, x.name);
    elsif p_what = 'room' then
      if x.gender is not null then perform public.pick_room(x.dept, x.name); end if;
    else
      begin
        perform public.pick_car(x.dept, x.name);  -- 운전자면 뽑지 않고 운전하는 차량을 돌려줌
      exception when others then
        if sqlerrm <> '빈자리가 있는 차량이 없어요. 진행자에게 말해 주세요.' then raise; end if;
      end;
    end if;
  end loop;
end $$;

-- 비교용 전체 상태(팀·뽑은 시각 여부·방·차량)
create or replace function t.state() returns text
language sql as $$
  select coalesce(string_agg(p.id || ':' || coalesce(p.team, '-') || '/' || coalesce(p.room, '-') || '/' || coalesce(p.car, '-'), ',' order by p.id), '')
  from public.people p;
$$;

-- 차례대로 한 명씩(id 순) 차량 뽑기를 fn 으로(예전 pick_car 와 지금 pick_car 비교용). 빈자리 없음은 '-' 로 기록. 결과 'id:차량,…'
create or replace function t.pick_all_with(fn text) returns text
language plpgsql as $$
declare x record; v text; res text[] := '{}';
begin
  for x in select id, dept, name from public.people order by id loop
    begin
      execute format('select %s($1, $2)', fn) into v using x.dept, x.name;
    exception when others then
      if sqlerrm <> '빈자리가 있는 차량이 없어요. 진행자에게 말해 주세요.' then raise; end if;
      v := '-';
    end;
    res := res || (x.id || ':' || v);
  end loop;
  return array_to_string(res, ',');
end $$;

-- 방 통계용: admin_shuffle('room', mode) 를 runs 번(판마다 커밋). pre = {"이름": "방"} 을 판마다 먼저 넣음.
-- 결과는 t.room_res(scn, run, name, room) 에 쌓는다 → CSV 로 내보내 tests/admin_shuffle_room_stats.mjs 로 완전 무작위 기준과 비교
create table if not exists t.room_res (scn text, run int, name text, room text);
create or replace procedure t.room_runs(p_code text, scn text, p_mode text, runs int, pre jsonb)
language plpgsql as $$
declare r int;
begin
  for r in 1..runs loop
    update public.people set room = null where room is not null;
    if pre is not null then
      update public.people p set room = e.value from jsonb_each_text(pre) e where p.name = e.key;
    end if;
    perform public.admin_shuffle(p_code, 'room', p_mode);
    insert into t.room_res select scn, r, p.name, p.room from public.people p;
    commit;
  end loop;
  update public.people set room = null where room is not null;
  truncate public.people_log;
  commit;
end $$;

-- 팀 통계용: admin_shuffle('team', 'all') 를 runs 번(판마다 커밋) 해서 t.team_check() 결과를 센다
--   → '인원 완벽(팀 없는 사람 없음) 판 수/인원·임원·성별 완벽 판 수/부서까지 완벽 판 수/전체'
create table if not exists t.team_res (chk text);
create or replace procedure t.team_runs(p_code text, runs int)
language plpgsql as $$
declare r int;
begin
  truncate t.team_res;
  for r in 1..runs loop
    perform public.admin_shuffle(p_code, 'team', 'all');
    insert into t.team_res values (t.team_check());
    commit;
  end loop;
  truncate public.people_log;
  commit;
end $$;
create or replace function t.team_summary() returns text
language sql as $$
  select format('%s/%s/%s/%s',
    count(*) filter (where chk like 'size:0,%,none:0'),
    count(*) filter (where chk like 'size:0,exec:0,dept:%,gender:0,none:0'),
    count(*) filter (where chk = 'size:0,exec:0,dept:0,gender:0,none:0'),
    count(*))
  from t.team_res;
$$;

-- 차량 통계용: admin_shuffle('car', 'all') 를 runs 번 → 사람마다 car1 에 탄 횟수와 판마다 두 차량 인원 차이 최댓값
create table if not exists t.car_res (run int, id bigint, car text);
create or replace procedure t.car_runs(p_code text, runs int)
language plpgsql as $$
declare r int;
begin
  truncate t.car_res;
  for r in 1..runs loop
    perform public.admin_shuffle(p_code, 'car', 'all');
    insert into t.car_res select r, p.id, p.car from public.people p;
    commit;
  end loop;
  truncate public.people_log;
  commit;
end $$;

revoke all on all functions in schema t from public;
revoke all on all procedures in schema t from public;
