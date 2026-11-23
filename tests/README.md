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
| 발표용 뽑기 화면 시험 | `node run.mjs draw [시나리오 번호...]` |
| 관리자 페이지 정렬 시험(차량 열·분류 단추·엑셀 열·마감 안내·발표용 링크·프로젝터 보기·390px·칸 통일·칸 순서·열림 기억) | `node run.mjs admin` (= `npm run test:admin`, 약 1분) |

`reset.mjs`(초기화 시험): 여섯 항목(팀·방·아침 메뉴·점심·자유시간·탑승 차량)과 차량 목록·운전자·일정표를 채운 뒤, 전체 초기화(취소/확인)·항목별 초기화 여섯 개가 그 항목만 비우는지, 확인은 confirm 한 번뿐이고 백업 상자·파일 받기가 없는지, 마감 뒤 확인 문구(`page.clock.setFixedTime`으로 화면 시계만 마감 뒤로 — 서버 `choices_closed()`는 실제 시계), 초기화 뒤 참가자 메인이 "아직 안 골랐어요/안 뽑았어요"인지, 중간 실패(`page.route`로 `admin_clear(lunch)` 한 번 실패) 뒤 다시 눌러 이어지는지를 봐요.

`admin_align.mjs`(관리자 페이지 정렬 시험): 한눈에 보기의 차량 열·타일(운전자 포함)·정렬, 차량 자료를 못 받았을 때(`board_cars`를 `page.route`로 막음) `-`·분류 단추 없음·엑셀 차량 칸 빈칸과 안내, 분류 단추(차량·아침 메뉴·점심·자유시간·방·팀)의 인원수·누르기·함께 걸기·조건 지우기, 엑셀 파일과 명단 전체 삭제 전 백업 파일의 열, 마감 안내 네 칸이 같은 틀·제목 바로 아래인지, "조식"이 화면에 없는지(식당 복사 글만 예외), 팀 숫자·팀 대신 정하기 문구, 팀·객실표 안내와 `draw.html` 링크 세 곳(버튼 모양), 프로젝터 보기 경고, 프로젝터 보기(`?tv=1`, 팀 열 → 팀을 아직 안 뽑은 사람 → 아침 메뉴가 펼친 채 큰 글씨로), 390px에서 가로로 안 넘치는지(칸 제목 줄의 제목·숫자가 겹치지 않는지 포함)를 봐요.
9·10번은 칸 통일 시험이에요: `#boardView` 바로 아래 칸이 모두 `details.card`이고 제목 줄이 `.sum-t` + `small.sum-n#…Count`뿐(단추 없음)이며 모양이 모두 같은지, 칸 순서(한눈에 보기 → 일정표 → 탑승 차량 → 아침 메뉴 → 점심 → 자유시간 → 객실표 → 팀 → 명단 관리 → 초기화), 처음엔 한눈에 보기만 펼침, 접힌 제목 줄 숫자, 열고 닫은 상태가 새로 고침 뒤 유지(`team-picker-board-open`), 5초 자동 새로고침 중 열린 칸·입력값·초점 유지와 접힌 칸 숫자 갱신, 칸마다 접었다 편 뒤 기능(정렬·일정 고치기·직접 옮기기/고치기·차량 목록 고치기·복사·자동으로 나누기·이름 메뉴·분류·수정·초기화 확인), `localStorage`가 막혀도 오류 없이 동작하는지.
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
