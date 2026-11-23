-- 시험용 DB 전용(운영 DB 에 쓰지 말 것: people 을 지우고 지어낸 명단을 넣음)
-- 지어낸 명단: 남 20·여 9, 부서 6개(D1~D6). 이름은 M01.. / F01..
alter table people disable trigger people_log;
delete from people;
insert into people (dept, name, title, gender)
select d, nm, case when i % 7 = 0 then '이사' else '사원' end, g from (values
 (1,'D1','M01','남'),(2,'D1','M02','남'),(3,'D1','M03','남'),(4,'D1','M04','남'),(5,'D1','M05','남'),(6,'D1','F01','여'),(7,'D1','F02','여'),(8,'D1','F03','여'),
 (9,'D2','M06','남'),(10,'D2','M07','남'),(11,'D2','M08','남'),(12,'D2','M09','남'),(13,'D2','F04','여'),(14,'D2','F05','여'),
 (15,'D3','M10','남'),(16,'D3','M11','남'),(17,'D3','M12','남'),(18,'D3','F06','여'),(19,'D3','F07','여'),
 (20,'D4','M13','남'),(21,'D4','M14','남'),(22,'D4','M15','남'),(23,'D4','F08','여'),
 (24,'D5','M16','남'),(25,'D5','M17','남'),(26,'D5','F09','여'),
 (27,'D6','M18','남'),(28,'D6','M19','남'),(29,'D6','M20','남')) v(i, d, nm, g);
drop table if exists res;
create table res(scn text, run int, id bigint, room text, ord int);
create or replace function sim(scn text, runs int, pre jsonb) returns void language plpgsql as $$
declare r int; x record; o int;
begin
  for r in 1..runs loop
    update people set room = null;
    if pre is not null then
      update people p set room = e.value from jsonb_each_text(pre) e where p.name = e.key;
    end if;
    o := 0;
    create temp table if not exists ordt(id bigint, ord int) on commit drop;
    delete from ordt;
    for x in select id, dept, name from people where room is null and gender is not null order by random() loop
      o := o + 1;
      perform pick_room(x.dept, x.name);
      insert into ordt values (x.id, o);
    end loop;
    insert into res select scn, r, p.id, p.room, t.ord from people p left join ordt t on t.id = p.id;
  end loop;
end $$;
