-- 시험용 Supabase 흉내(로컬 임시 Postgres 에서만 씀. 운영 DB 에서 Run 하지 말 것).
-- supabase.sql 이 기대하는 역할(anon·authenticated)과, Supabase 가 public 스키마에 기본으로 주는 권한을 똑같이 만든다.
-- Supabase 는 새 테이블·함수에 anon·authenticated 권한을 기본으로 주므로, supabase.sql 의 revoke 줄이 제대로 막는지 시험할 수 있다.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  -- 권한 없는 다른 역할(PUBLIC 으로만 권한을 받는지 보려고)
  if not exists (select 1 from pg_roles where rolname = 'nobody_test') then create role nobody_test nologin noinherit; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role, nobody_test;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
