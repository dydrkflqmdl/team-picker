# 팀 뽑기

이 프로젝트는 HTML 파일 하나(`index.html`)로 된 팀 뽑기 페이지예요. 데이터는 Supabase에 저장하고, GitHub Pages로 배포해요.

## 처음 한 번 설정

1. Supabase에서 새 프로젝트를 만들고 SQL Editor를 열어요. [`supabase.sql`](supabase.sql) 내용을 붙여넣고 **Run**을 눌러요.
2. Project Settings → API에서 **Project URL**과 **publishable(또는 anon) 키**를 복사해요. 두 값을 `index.html` 위쪽의 `SUPABASE_URL`, `SUPABASE_KEY`에 넣어요.
   - publishable 키는 원래 공개해도 되는 키예요. 대신 `service_role`이나 `secret` 키는 절대 넣지 마세요.
3. `main`에 push하면 GitHub Pages에 반영돼요. Settings → Pages에서 Source를 `main` / `/ (root)`로 설정해 두면 돼요.

## 로컬에서 보기

`index.html`을 더블클릭해서 브라우저로 열면 돼요. 서버는 필요 없어요.

## 알아둘 점

- 링크를 아는 사람은 **누구나** 명단과 기록을 추가하거나 지울 수 있어요. 워크숍용으로 일부러 로그인 없이 만들었어요.
- Supabase 무료 프로젝트는 1주일 동안 쓰지 않으면 일시정지돼요. 그러면 대시보드에서 **Restore**를 누르면 다시 쓸 수 있어요.
