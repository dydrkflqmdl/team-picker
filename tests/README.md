# 로컬 시험 환경

운영 Supabase에 **한 건도 닿지 않고** 실제 `supabase.sql` 함수로 화면을 돌려 보는 환경이에요.
로컬 postgres(포트 54329) + 대리 서버(저장소 정적 파일 + `/rest/v1/rpc/<함수>`) + Playwright 도우미로 이뤄져요.

## 처음 한 번

```sh
cd tests && npm install      # playwright, pg. 브라우저는 설치된 Google Chrome 을 써요(없으면 npx playwright install chromium)
npm test                     # = node run.mjs smoke : DB 올리기 → 명단 → 서버 → 브라우저 시험 → DB 끄기 (약 2초)
```

## 명령

| 하고 싶은 일 | 명령 |
|---|---|
| DB 켜기 + `supabase.sql` 새로 적용 | `node run.mjs db-up` |
| DB 끄기 | `node run.mjs db-down` |
| 견본 명단 다시 넣기 | `node run.mjs seed` |
| 일부는 이미 뽑은 상태로 | `node run.mjs seed --picked` |
| 성별 없는 1명 포함 | `node run.mjs seed --no-gender` (둘을 같이 써도 돼요) |
| 대리 서버만 | `node run.mjs server [포트]` (기본 54330) |
| 손으로 눌러 보기: DB+명단+서버 한 번에 | `node run.mjs dev` (Ctrl-C 로 전부 정리) |
| 관리자 페이지 초기화 칸 시험 | `node run.mjs reset` (= `npm run test:reset`, 약 1분) |
| 관리자 페이지 자동 섞기 시험(팀·방·탑승 차량 × 안 뽑은 사람만·전부 새로, 아침 메뉴 초기화) | `node run.mjs shuffle` (= `npm run test:shuffle`, 약 1분 30초) |
| 자동 섞기 DB 시험(임시 Postgres, 이 환경과 따로) | `bash tests/admin_shuffle_db_test.sh` (저장소 맨 위에서, 약 1분 30초. `QUICK=1`이면 통계 판 수를 줄여 빨리) |
| 발표용 뽑기 화면 시험 | `node run.mjs draw [시나리오 번호...]` |
| 관리자 페이지 정렬 시험(차량 열·분류 단추·엑셀 열·마감 안내(마감 전·후·열어 둔 채 넘김)·자유시간 복사·발표용 링크·프로젝터 보기(차량 안 받기)·390px(누르는 자리·표 안 넘침)·빠른 추가 오류·칸 통일·칸 순서·열림 기억·아침 메뉴/점심/자유시간 세 칸 같은 구성과 직접 고치기 토글·복사) | `node run.mjs admin` (= `npm run test:admin`, 약 1분) |

`reset.mjs`(초기화 시험): 여섯 항목(팀·방·아침 메뉴·점심·자유시간·탑승 차량)과 차량 목록·운전자·일정표를 채운 뒤, 전체 초기화(취소/확인)·항목별 초기화 여섯 개가 그 항목만 비우는지, 확인은 confirm 한 번뿐이고 백업 상자·파일 받기가 없는지, 마감 뒤 확인 문구(`page.clock.setFixedTime`으로 화면 시계만 마감 뒤로 — 서버 `choices_closed()`는 실제 시계), 초기화 뒤 참가자 메인이 "아직 안 골랐어요/안 뽑았어요"인지, 중간 실패(`page.route`로 `admin_clear(lunch)` 한 번 실패) 뒤 다시 눌러 이어지는지를 봐요.

`admin_shuffle.mjs`(자동 섞기 시험): 1) 단추 여섯 개의 이름(`○○ 자동 섞기 · 안 뽑은 사람만`·`○○ 전부 새로 섞기`)·자리(팀·객실표·탑승 차량 칸 아래 `.tools2` 맨 앞, fill → all)가 같은 규칙이고 고르는 칸·초기화 칸에는 없는지, 2) 세 항목 × 두 동작마다 확인 confirm 한 번·첫 줄 문구(대상 인원), 취소하면 쓰기 요청 0건, 확인하면 `admin_shuffle(p_what, p_mode)` 한 번, 결과 안내(`assigned`·`cleared`), 그 항목만 바뀌고 다른 항목·명단·차량 목록은 그대로(DB 비교), 3) 마감 뒤(`page.clock.setFixedTime`)에도 동작하고 탑승 차량은 "결과가 최종" 안내, 4) 성별 없는 사람(방)·운전자(차량) 건너뜀을 이름·부서로 알림(방 전부 새로 섞기는 성별이 없는데 방이 있는 사람이 있으면 "방이 비워져요" 줄도), 명단이 비면 "명단을 먼저 넣어 주세요"(다시 눌러 달라는 말 없음), 5) 0명이면 확인·호출 없이 "넣을 사람이 없어요", 6) 느린 응답(6초, `page.route`) 동안 여섯 단추가 잠기고 5초 자동 새로 받기가 돌아도 그대로·여러 번 눌러도 요청 한 번, 7) 실패(400)면 "아무것도 바뀌지 않았어요"와 이유, 다시 누르면 됨, 8) 함수 없는 예전 DB(`startServer({ missing })`/`server.missing` 으로 `admin_shuffle` 만 404 `PGRST202`): 방은 예전 방식(`admin_assign`)으로 대신 + "예전 방식으로 나눴어요", 팀·차량은 안내만, 9) 팀·탑승 차량·전체 초기화 뒤에는 그 항목의 "자동으로 넣었어요…" 결과 문구가 지워지고(방은 기존대로), 아침 메뉴 초기화가 `admin_clear(menu)` 한 번으로 메뉴만 비우고, 예전 DB(`'menu'` 거절)에서는 `admin_assign(menu)`로 대신, 10) 390px에서 단추가 화면 안·높이 40px 이상, 1280px 36px·한 줄, 프로젝터 보기에서는 안 보임. `SHOT_DIR=폴더`를 주면 390px·1280px·프로젝터 보기 화면을 찍어 둬요.

`admin_align.mjs`(관리자 페이지 정렬 시험): 한눈에 보기의 차량 열·타일(운전자 포함)·정렬, 차량 자료를 못 받았을 때(`board_cars`를 `page.route`로 막음) `-`·분류 단추 없음·엑셀 차량 칸 빈칸과 안내, 분류 단추(차량·아침 메뉴·점심·자유시간·방·팀)의 인원수·누르기·함께 걸기·조건 지우기, 엑셀 파일과 명단 전체 삭제 전 백업 파일의 열, 마감 안내 네 칸이 같은 틀·제목 바로 아래인지, "조식"이 화면에 없는지(식당 복사 글만 예외), 팀 숫자·팀 대신 정하기 문구, 팀·객실표 안내와 `draw.html` 링크 세 곳(버튼 모양), 프로젝터 보기 경고, 프로젝터 보기(`?tv=1`, 팀 열 → 팀을 아직 안 뽑은 사람 → 아침 메뉴가 펼친 채 큰 글씨로), 390px에서 가로로 안 넘치는지(칸 제목 줄의 제목·숫자가 겹치지 않는지 포함)를 봐요.
11~15번(새로 더함): 11) 마감 안내 네 칸·탑승 차량 안내의 마감 전 문구와 마감 뒤 "마감됐어요(…)" 문구(`page.clock.setFixedTime`으로 화면 시계를 마감 전·후로 고정), 그리고 `page.clock.install` + `fastForward` 로 화면을 연 채 마감을 넘겼을 때 문구가 바뀌고 열린 칸·입력값이 그대로인지, 12) 자유시간 복사 단추(칸 안 아래 도구 줄·복사 글의 스키·휴식·안 고른 사람 명단·클립보드 허용/막힘), 13) 390px 한눈에 보기 표가 옆으로 안 밀리고 여덟 열이 모두 보이는지·누르는 자리 40px 이상·백업 확인 상자와 이름 메뉴가 화면 안인지·1280px 모양이 그대로인지, 14) 늦게 온 사람 빠른 추가 오류가 `#quickMsg`에 나오는지, 15) 프로젝터 보기에서 `board_cars` 를 안 받고 관리자 페이지로 돌아오면 곧바로 받는지. 5번(마감 안내)은 화면 시계를 마감 전으로 고정해 시험을 언제 돌려도 같아요.
16~20번(아침 메뉴·점심·자유시간 세 칸을 같은 구성으로 맞춘 것): 16) 세 칸의 요소 순서(제목 줄 → 마감 안내 → 목록 → 도구 줄[직접 고치기 토글 · 복사 단추] → 안내줄 → 복사 상자)·id 짝(`○Deadline`·`○Move`·`○Copy`·`○CopyMsg`·`○CopyBox`·`○Count`)·묶음 제목·"아직 안 고른 사람"·이름표(이름 직급 · 부서, 직급 높은 순)·글자 크기/여백/도구 줄 모양(computed style)이 같고, 자유시간만 술 금지 안내가 더 있고, 아침 메뉴 칸의 관리용 요소는 모두 `admin-only`인지, 17) 세 칸 각각 직접 고치기가 꺼짐 기본 → 켜면 고르는 칸 29개 → 바꾸면 `admin_assign(menu|lunch|activity)` 한 번(그 사람만, DB 반영, 칸 안 묶음 이동) → 참가자 화면(index.html, 견본 로그인)에 반영 → "안 고름"으로 비우기(빈 값) → 끄면 보기만 → 저장 실패(`page.route`로 400) 시 고르는 칸이 되돌아오고 오류 안내 → 고르는 칸을 잡고 있는 동안 DB가 바뀌고 5초 새로고침이 돌아도 칸 열림·토글·초점·값 유지, 나오면 맞춤 → 마감 뒤(`page.clock.setFixedTime`)에도 바뀜, 18) 복사 글 한 줄(아침 메뉴 "조식"·점심 "점심")·클립보드 허용/막힘(직접 복사 상자)·직접 고친 인원 반영·세 상자가 안 섞임, 19) 프로젝터 보기(`?tv=1`)에서 직접 고치기·복사·안내줄·고르는 칸이 안 보이고(켜 둔 채 가도) 아침 메뉴 이름표·글자 크기·제목 줄 숫자가 예전 그대로(부서·이름순, 이름·부서만), 돌아오면 다시 보임, 20) 390px에서 세 칸의 도구 줄 자리·크기가 같고 누르는 자리 40px 이상·가로로 안 넘침, 1280px에서 도구 줄 크기가 같음.
9·10번은 칸 통일 시험이에요: `#boardView` 바로 아래 칸이 모두 `details.card`이고 제목 줄이 `.sum-t` + `small.sum-n#…Count`뿐(단추 없음)이며 모양이 모두 같은지, 칸 순서(한눈에 보기 → 일정표 → 탑승 차량 → 아침 메뉴 → 점심 → 자유시간 → 객실표 → 팀 → 명단 관리 → 초기화), 처음엔 한눈에 보기만 펼침, 접힌 제목 줄 숫자, 열고 닫은 상태가 새로 고침 뒤 유지(`team-picker-board-open`), 5초 자동 새로고침 중 열린 칸·입력값·초점 유지와 접힌 칸 숫자 갱신, 칸마다 접었다 편 뒤 기능(정렬·일정 고치기·직접 옮기기/고치기·차량 목록 고치기·복사·방 전부 새로 섞기(확인 취소)·이름 메뉴·분류·수정·초기화 확인), `localStorage`가 막혀도 오류 없이 동작하는지.
- 같은 context 의 페이지끼리 `localStorage`를 같이 쓰므로, 시험은 탭을 처음 열 때만 칸 열림 기억(`team-picker-board-open`)을 지워요(`openBoard`의 `addInitScript` + `sessionStorage`). 칸을 펼 때는 `openCard`(이미 펴져 있으면 그대로)를 써요.

- 관리자 비밀번호(시험용): `test-admin-code-0000` (`db.mjs`의 `ADMIN_CODE`). `supabase.sql`은 고치지 않고, 적용할 때 `admin_code` 입력 줄만 이 값으로 바꿔요.
- 데이터 폴더 `tests/.pgdata`, 로그 `tests/.pgdata.log`는 gitignore. 이미 돌고 있는 다른 postgres는 건드리지 않아요(포트가 쓰이고 있으면 멈춰요. `PGTEST_PORT`로 바꿔요).
- `psql -h 127.0.0.1 -p 54329 -U postgres draw_test`로 직접 들여다볼 수 있어요.

## 견본 명단 (`seed.mjs`)

29명: 남 20·여 9, 부서 6(`시험영업부`…`시험기획부`), 임원 4(대표이사·상무·이사·전무). 이름은 `견본가`, `견본나`, … `견본고`.
`--picked`는 id 1~12에 팀·아침, 1~10 중 성별 있는 사람에 방, 1~8에 점심, 1~6에 자유시간을 채워요(팀 균형을 맞춘 값이 아니라 화면 시험용).
코드에서는 `resetRoster(client, { picked, noGender })`, `applyPicked(client)`, `roster()`를 써요. `resetRoster`는 명단·변경 기록·일정표를 비우고 id를 1부터 다시 매겨요.

## 대리 서버 (`server.mjs`)

```js
import { startServer } from './server.mjs';
const server = await startServer({ port: 0 });   // 0 = 빈 포트 아무거나. server.url, server.calls(받은 rpc 기록 {fn,args,status,ms}), await server.close()
// 예전 DB 흉내: startServer({ port: 0, missing: ['admin_shuffle'] }) 또는 server.missing.add('admin_shuffle') — 그 함수만 404 PGRST202
```

- 저장소 루트의 정적 파일을 내줘요(`tests/`와 `.`으로 시작하는 것은 안 내줘요).
- `POST /rest/v1/rpc/<함수>`(`[a-z_]+`만): 로컬 DB에서 `set local role anon` 상태로 `함수(p_x := …)`를 불러요. 성공 200 + JSON(void 는 204), 함수에서 낸 오류는 400 + `{message, code, details, hint}`, 없는 함수·인자는 404 `PGRST202`. `anon`이 못 부르는 함수는 400(`42501`)이라 실제 권한도 그대로 시험돼요. 요청 제한 시간은 운영처럼 8초.
- 마감: `choices_closed()`는 실제 시계를 써요(2026-11-25 15:00 KST 이후에는 점심·아침·자유시간 고르기가 거절돼요). 그 뒤에 시험하려면 마감이 지난 상태가 정상 동작이에요.

## Playwright 도우미 (`helpers.mjs`)

```js
import { openTestBrowser } from './helpers.mjs';
const env = await openTestBrowser(server.url);    // { browser, context, guard, newPage(), close() }
const page = await env.newPage();
await page.goto(`${server.url}/board.html`);
// ... 시험 ...
env.guard.assertClean();                          // 허용 안 된 외부 요청이 있었으면 여기서 throw
await env.close();
```

이미 만든 context/page에는 `await guardNetwork(context, server.url)`만 걸면 돼요(새 context마다 따로 걸어야 해요. `launchBrowser()`도 따로 써요).

**운영 DB를 막는 방법(두 겹)**
1. `route('**/*')`: `https://*.supabase.co/**`는 경로·본문만 로컬 대리 서버로 넘겨 답을 돌려주고(운영으로는 연결하지 않음), 로컬 주소·`data:`·`blob:`·`about:` 말고는 모두 abort 하며 `guard.blocked`에 적어요. `assertClean()`이 이게 비어 있는지 확인해요. `guard.proxied`는 로컬로 돌린 요청 목록이에요.
2. Chrome 실행 인자 `--host-resolver-rules`로 `127.0.0.1`/`localhost` 말고는 이름 풀이 자체를 막아요(`route`에 안 잡히는 웹소켓도 막힘).

## 알아 둘 점

- 같은 context 의 페이지끼리는 `localStorage`를 공유해요. 관리자 화면은 비밀번호를 저장하므로, 로그인 실패를 시험하려면 새 context 를 써요(`smoke.mjs` 참고).
- 시험마다 상태를 맞추려면 `resetRoster`로 다시 넣어요. DB를 통째로 새로 만들려면 `db-up`(`buildSchema()`).
- 참가자 메인에서 방·팀 뽑기 단추(`#goRoom`, `#goTeam`)는 숨겨져 있어요(`hidden`). 로그인 확인에는 `#goMenu`를 써요.
- 화면의 `supabase.js`에 `integrity` 해시가 있어요. 대리 서버가 파일을 그대로 내주므로 문제없지만, 파일을 바꾸면 해시도 맞춰야 해요.
