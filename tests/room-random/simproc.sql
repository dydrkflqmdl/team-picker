-- 시험용 DB 전용. call sim('A', 4000, null); 처럼 부른다(pre = {"이름": "방"} 진행자가 먼저 넣은 사람).
drop function if exists sim(text, int, jsonb);
drop table if exists ordt;
create table ordt(id bigint, ord int);
-- 한 판마다 커밋(운영처럼 사람마다 따로 커밋하지는 않지만, 한 판 안에서 차례대로 부르는 건 같음)
create or replace procedure sim(scn text, runs int, pre jsonb) language plpgsql as $$
declare r int; x record; o int;
begin
  for r in 1..runs loop
    update people set room = null where room is not null;
    if pre is not null then
      update people p set room = e.value from jsonb_each_text(pre) e where p.name = e.key;
    end if;
    o := 0;
    delete from ordt;
    for x in select id, dept, name from people where room is null and gender is not null order by random() loop
      o := o + 1;
      perform pick_room(x.dept, x.name);
      insert into ordt values (x.id, o);
    end loop;
    insert into res select scn, r, p.id, p.room, t.ord from people p left join ordt t on t.id = p.id;
    commit;
  end loop;
end $$;
