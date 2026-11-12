-- 팀 뽑기용 테이블. Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 한 번이면 끝.
-- 로그인 없이 링크만 있으면 누구나 읽고/추가하고/지울 수 있는 설정이다(워크숍용).

create table if not exists public.members (
  id         bigint generated always as identity primary key,
  name       text not null unique check (char_length(btrim(name)) between 1 and 50),
  created_at timestamptz not null default now()
);

create table if not exists public.draws (
  id         bigint generated always as identity primary key,
  team_count int not null check (team_count between 1 and 100),
  teams      jsonb not null,               -- [["A","B"],["C","D"]]
  created_at timestamptz not null default now()
);

alter table public.members enable row level security;
alter table public.draws   enable row level security;

-- 수정(update) 정책은 일부러 만들지 않는다 → RLS 가 update 를 막는다(화면에도 수정 기능 없음).
grant select, insert, delete on public.members, public.draws to anon;

create policy "members: 누구나 읽기" on public.members for select to anon using (true);
create policy "members: 누구나 추가" on public.members for insert to anon with check (true);
create policy "members: 누구나 삭제" on public.members for delete to anon using (true);

create policy "draws: 누구나 읽기" on public.draws for select to anon using (true);
create policy "draws: 누구나 추가" on public.draws for insert to anon with check (true);
create policy "draws: 누구나 삭제" on public.draws for delete to anon using (true);
