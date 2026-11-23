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
