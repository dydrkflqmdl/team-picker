-- 차량 뽑기 시험용 보조 함수(로컬 임시 Postgres 에서만 씀. 운영 DB 에서 Run 하지 말 것).
-- 참가자(anon)가 못 보는 따로 된 스키마 t 에 둔다. 견본 이름은 모두 지어낸 이름이다.
create schema if not exists t;
revoke all on schema t from public, anon, authenticated;

-- 동시 시험의 출발선: 한 세션이 이 표를 잠그고 있다가 풀면, 기다리던 세션들이 한꺼번에 출발한다
create table if not exists t.gate (x int);
grant usage on schema t to anon;
grant select on t.gate to anon;

-- 명단을 n명으로 새로 채운다(차량·팀·방 등은 모두 빈 상태). 부서 3개, 직급 5가지(이사 포함), 성별 번갈아.
-- 이름 = 성(8가지) × 지어낸 이름(8가지) → 64명까지
create or replace function t.seed(n int) returns void
language plpgsql as $$
begin
  delete from public.people;
  insert into public.people (dept, name, title, gender)
  select '시험' || (1 + (i % 3)) || '팀', sn || gn,
         (array['사원', '대리', '과장', '차장', '이사'])[1 + (i % 5)],
         case when i % 2 = 0 then '남' else '여' end
  from (select (row_number() over (order by a.o, b.o) - 1)::int as i, a.sn, b.gn
        from unnest(array['김', '이', '박', '최', '정', '한', '오', '윤']) with ordinality as a(sn, o),
             unnest(array['가람', '나래', '도윤', '서연', '하늘', '별', '지호', '다솜']) with ordinality as b(gn, o)) s
  where i < n
  order by i;
  truncate public.people_log;
end $$;

-- 차량 목록을 검사 없이 바로 바꾼다(깨진 목록 시험용)
create or replace function t.raw_cars(v text) returns void
language sql as $$
  update public.config set value = v where key = 'cars';
$$;

-- 차량별 탄 인원 'id:n,…' (config 순서) + 'none:n'
create or replace function t.counts() returns text
language sql as $$
  select string_agg(l.id || ':' || (select count(*) from public.people p where p.car = l.id), ',' order by l.ord)
         || ',none:' || (select count(*) from public.people where car is null)
  from public.car_list() l;
$$;

-- 정원을 넘은 차량 수(자동 정원은 지금 명단으로 계산한 값)
create or replace function t.overfull() returns int
language sql as $$
  select count(*)::int from public.car_caps() l
  where (select count(*) from public.people p where p.car = l.id) > l.seats;
$$;

-- 운전자로 지정된 사람 id 들
create or replace function t.drivers() returns bigint[]
language sql as $$
  select coalesce(array_agg(l.driver), '{}') from public.car_list() l where l.driver is not null;
$$;

-- 차량 없는 사람(운전자 제외) 중 id 가 가장 작은 사람이 뽑기를 reps 번 되풀이(매번 그 사람 차량만 비움). 결과 'id:n,…'
create or replace function t.first_pick(reps int) returns text
language plpgsql as $$
declare
  d text; nm text; c text; i int;
  res text[] := '{}';
begin
  select dept, name into d, nm from public.people where car is null and id <> all (t.drivers()) order by id limit 1;
  for i in 1..reps loop
    c := public.pick_car(d, nm);
    res := res || c;
    update public.people set car = null, car_at = null where dept = d and name = nm;
  end loop;
  truncate public.people_log;
  return (select string_agg(x || ':' || k, ',' order by x) from (select x, count(*) as k from unnest(res) x group by x) s);
end $$;

-- 전원 뽑기를 rounds 번: 매번 모두 비우고 무작위 순서로 한 명씩 뽑는다(자리가 다 차면 나머지는 차량 없음).
-- 결과: (성별, 임원 여부, 차량 또는 'none') 별 횟수
create or replace function t.full_rounds(rounds int) returns table (gender text, is_exec boolean, car text, n int)
language plpgsql as $$
#variable_conflict use_column
declare
  i int;
  p record;
begin
  create temp table if not exists tally (gender text, is_exec boolean, car text) on commit drop;
  for i in 1..rounds loop
    update public.people set car = null, car_at = null where car is not null;
    for p in select pp.dept, pp.name from public.people pp order by random() loop
      begin
        perform public.pick_car(p.dept, p.name);
      exception when others then
        null;  -- 자리가 다 참
      end;
    end loop;
    insert into tally select pp.gender, pp.is_exec, coalesce(pp.car, 'none') from public.people pp;
  end loop;
  update public.people set car = null, car_at = null where car is not null;
  truncate public.people_log;
  return query select x.gender, x.is_exec, x.car, count(*)::int from tally x group by 1, 2, 3 order by 1, 2, 3;
end $$;

-- 판마다 결과를 모아 두는 표(아래 프로시저가 씀)
create table if not exists t.rounds (c1 int, c2 int, unassigned int, overfull int, errors int, drvcar int);
create table if not exists t.picks (car text);

-- 차량 두 대(car1·car2) 목록에서 전원 뽑기를 rounds 번: 매번 손님 차량을 모두 비우고 명단 전원(운전자 포함)이 무작위 순서로 한 번씩 뽑는다.
-- 한 트랜잭션에서 수만 번 고치면 지워진 줄이 쌓여 점점 느려지므로 판마다 커밋한다(프로시저, psql 에서 call 로 부름).
-- 결과는 t.rounds 에 판마다 한 줄. 요약은 t.rounds_summary()
create or replace procedure t.all_rounds(rounds int)
language plpgsql as $$
declare
  i int; p record; c1 int; c2 int; errs int;
begin
  truncate t.rounds;
  for i in 1..rounds loop
    update public.people set car = null, car_at = null where car is not null;
    errs := 0;
    for p in select pp.dept, pp.name from public.people pp order by random() loop
      begin
        perform public.pick_car(p.dept, p.name);
      exception when others then
        errs := errs + 1;
      end;
    end loop;
    select count(*) filter (where car = 'car1'), count(*) filter (where car = 'car2') into c1, c2 from public.people;
    insert into t.rounds values (c1, c2,
      (select count(*) from public.people where car is null and id <> all (t.drivers())),
      t.overfull(), errs,
      (select count(*) from public.people where car is not null and id = any (t.drivers())));
    commit;
  end loop;
  update public.people set car = null, car_at = null where car is not null;
  truncate public.people_log;
  commit;
end $$;

-- 'maxdiff:최대 차이,unassigned:못 탄 손님 수 합,overfull:정원 넘은 차량 수 합,errors:오류 수,drvcar:차량이 들어간 운전자 수 합,
--  more1:car1 이 많았던 판,more2:car2 가 많았던 판,equal:같았던 판'
create or replace function t.rounds_summary() returns text
language sql as $$
  select format('maxdiff:%s,unassigned:%s,overfull:%s,errors:%s,drvcar:%s,more1:%s,more2:%s,equal:%s',
                coalesce(max(abs(c1 - c2)), 0), coalesce(sum(unassigned), 0), coalesce(sum(overfull), 0), coalesce(sum(errors), 0),
                coalesce(sum(drvcar), 0), count(*) filter (where c1 > c2), count(*) filter (where c2 > c1), count(*) filter (where c1 = c2))
  from t.rounds;
$$;

-- 운전자가 아닌 사람 중 id 가 가장 작은 사람이 "마지막 차례"로 뽑기를 reps 번: 매번 모두 비우고 나머지 전원이 무작위 순서로 먼저 뽑음.
-- 판마다 커밋. 결과는 t.picks, 요약은 t.picks_summary() → 'car1:n,car2:m'
create or replace procedure t.last_pick(reps int)
language plpgsql as $$
declare
  i int; p record; tid bigint; td text; tn text;
begin
  truncate t.picks;
  select id, dept, name into tid, td, tn from public.people where id <> all (t.drivers()) order by id limit 1;
  for i in 1..reps loop
    update public.people set car = null, car_at = null where car is not null;
    for p in select pp.dept, pp.name from public.people pp where pp.id <> tid order by random() loop
      perform public.pick_car(p.dept, p.name);
    end loop;
    insert into t.picks values (public.pick_car(td, tn));
    commit;
  end loop;
  update public.people set car = null, car_at = null where car is not null;
  truncate public.people_log;
  commit;
end $$;
create or replace function t.picks_summary() returns text
language sql as $$
  select string_agg(car || ':' || k, ',' order by car) from (select car, count(*) as k from t.picks group by car) s;
$$;

-- 명단에 사람 n 명을 더한다(지어낸 이름 '추가1' … , 부서 '시험9팀'). 이미 있으면 건너뜀
create or replace function t.add_people(n int) returns void
language sql as $$
  insert into public.people (dept, name, title, gender)
  select '시험9팀', '추가' || i, '사원', case when i % 2 = 0 then '남' else '여' end
  from generate_series(1, n) i
  where not exists (select 1 from public.people p where p.dept = '시험9팀' and p.name = '추가' || i);
$$;

-- 함수는 기본으로 PUBLIC 이 부를 수 있으니 거둔다(시험 함수는 postgres 만)
revoke all on all functions in schema t from public;
revoke all on all procedures in schema t from public;
