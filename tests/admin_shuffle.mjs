// 관리자 페이지(board.html) 자동 섞기 시험: 팀·방·탑승 차량 칸의 "○○ 자동 섞기 · 안 뽑은 사람만"(fill)·"○○ 전부 새로 섞기"(all) 단추와
// 아침 메뉴 초기화(admin_clear('menu') 한 번)를 본다.
//   1) 단추 여섯 개의 이름·자리가 같은 규칙(각 칸 아래 도구 줄 맨 앞, fill → all), 고르는 칸(아침 메뉴·점심·자유시간)·초기화 칸에는 없음
//   2) 세 항목 × 두 동작: 확인 한 번(취소하면 쓰기 요청 0건), admin_shuffle 호출 인자, 결과 안내, 그 항목만 바뀌고 다른 항목·명단은 그대로(DB 비교)
//   3) 마감 뒤(화면 시계 고정)에도 동작 + 탑승 차량의 "최종" 안내   4) 건너뛴 사람(성별 없음·운전자) 안내   5) 0명이면 안내만(호출 없음)
//   6) 진행 중 단추 잠금(느린 응답 + 5초 자동 새로 받기와 겹침)   7) 실패하면 "아무것도 바뀌지 않았어요"
//   8) 함수 없는 예전 DB(대리 서버가 admin_shuffle 에 404 PGRST202): 방은 예전 방식으로 대신, 팀·차량은 안내만
//   9) 아침 메뉴 초기화 = admin_clear('menu') 한 번, 예전 DB(그 항목 거절)에서는 예전 방식으로 대신   10) 390px·1280px·프로젝터 보기
// 사용: node run.mjs shuffle   (DB 올리기 → 시험 → DB 끄기). 운영 DB 에는 닿지 않음(helpers.mjs 의 guardNetwork).
// 견본 이름은 seed.mjs 의 지어낸 이름('견본○'), 관리자 비밀번호는 시험용 값.
import assert from 'node:assert/strict';
import { ADMIN_CODE, connect } from './db.mjs';
import { resetRoster, roster } from './seed.mjs';
import { startServer } from './server.mjs';
import { openTestBrowser } from './helpers.mjs';

const CARS = [{ id: 'car1', name: '1호차', label: '견본 문구', driver: 29 }, { id: 'car2', name: '2호차', label: '' }]; // 운전자: 견본고(id 29)
const BEFORE = '2026-11-24T10:00:00+09:00'; // 마감 전(화면 시계)
const AFTER = '2026-11-26T10:00:00+09:00';  // 마감 뒤(화면 시계)
const ITEM = {
  team: { label: '팀', card: 'teamCard', msg: '#teamMsg', cols: ['team', 'picked_at'], fill: '#teamFill', all: '#teamAuto' },
  room: { label: '방', card: 'roomCard', msg: '#roomMsg', cols: ['room'], fill: '#roomFill', all: '#roomAuto' },
  car: { label: '탑승 차량', card: 'carCard', msg: '#carMsg', cols: ['car', 'car_at'], fill: '#carFill', all: '#carAuto' },
};
const ALL_COLS = ['team', 'picked_at', 'room', 'menu', 'lunch', 'activity', 'car', 'car_at'];
const title = (what, mode) => (mode === 'all' ? `${ITEM[what].label} 전부 새로 섞기` : `${ITEM[what].label} 자동 섞기 · 안 뽑은 사람만`);
const OLD_DB = 'DB가 아직 새 버전이 아니에요. 진행자(개발 담당)에게 supabase.sql을 다시 적용해 달라고 해 주세요.';

// 여섯 항목을 채운 상태: seed --picked(팀·아침 12명, 방 10명, 점심 8명, 자유시간 6명) + 차량 목록·운전자 + 차량 손님 5명(id 1~5)
async function fill(db, opts = {}) {
  await resetRoster(db, { picked: true, ...opts });
  await db.query('select public.admin_set_cars($1, $2::jsonb)', [ADMIN_CODE, JSON.stringify(CARS)]);
  await db.query("update public.people set car = case when id % 2 = 0 then 'car1' else 'car2' end, car_at = now() - (10 - id) * interval '1 second' where id <= 5");
}
const rows = async (db) => (await db.query(
  `select id, dept, name, title, gender, is_exec, team, picked_at::text, menu, room, activity, lunch, car, car_at::text from public.people order by id`)).rows;
const settings = async (db) => Object.fromEntries((await db.query(
  `select key, value from public.config where key in ('cars', 'schedule', 'admin_code') order by key`)).rows.map((r) => [r.key, r.value]));
const filled = (rs, cols) => rs.filter((r) => cols.some((c) => r[c] != null)).length;
function diff(a, b, ignore = []) {
  const out = [];
  if (a.length !== b.length) out.push(`인원 ${a.length} → ${b.length}`);
  for (const x of a) {
    const y = b.find((r) => r.id === x.id);
    if (!y) { out.push(`${x.id} 사라짐`); continue; }
    for (const k of Object.keys(x)) if (!ignore.includes(k) && String(x[k]) !== String(y[k])) out.push(`${x.id}.${k}: ${x[k]} → ${y[k]}`);
  }
  return out;
}
// 확인 상자: 오는 순서대로 plan(true = 확인, false = 취소). 계획이 없으면 취소
function dialogs(page) {
  const seen = [], plan = [];
  page.on('dialog', async (d) => {
    seen.push({ type: d.type(), msg: d.message() });
    if (plan.shift()) await d.accept(); else await d.dismiss();
  });
  return { seen, plan: (...a) => plan.push(...a) };
}

export async function shuffleTests() {
  const db = await connect();
  const server = await startServer({ port: 0 });
  const env = await openTestBrowser(server.url);
  let pass = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log('  통과: ' + msg); };
  const eq = (a, b, msg) => { assert.deepEqual(a, b, `${msg}\n    기대: ${JSON.stringify(b)}\n    실제: ${JSON.stringify(a)}`); pass++; console.log('  통과: ' + msg); };
  const errors = [];
  const writes = (from) => server.calls.slice(from).filter((c) => /^admin_|^pick/.test(c.fn)).map((c) => c.fn + (c.args.p_what ? `(${c.args.p_what}${c.args.p_mode ? ',' + c.args.p_mode : ''})` : '') + (c.status >= 400 ? `:${c.status}` : ''));
  const R = roster();
  const who = (id) => `${R[id - 1].name}(${R[id - 1].dept})`;

  async function openBoard({ clock = BEFORE, width = 1280, url = '' } = {}) {
    const page = await env.newPage();
    await page.setViewportSize({ width, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    if (clock) await page.clock.setFixedTime(new Date(clock));
    await page.addInitScript((c) => { try { localStorage.setItem('team-picker-admin', JSON.stringify(c)); if (!sessionStorage.getItem('fresh')) { localStorage.removeItem('team-picker-board-open'); sessionStorage.setItem('fresh', '1'); } } catch {} }, ADMIN_CODE);
    const d = dialogs(page);
    await page.goto(`${server.url}/board.html${url}`);
    if (!/tv=1/.test(url)) await page.locator('#glanceBody tr').nth(28).waitFor({ timeout: 10000 });
    return { page, d };
  }
  const openCard = async (page, id) => { if (!(await page.locator(`#${id}`).evaluate((el) => el.open))) await page.locator(`#${id} > summary`).click(); };
  // 단추를 누르고 끝날 때까지(잠금이 풀릴 때까지) 기다림. 취소했으면 잠깐 더 기다려 요청이 안 나가는지 봄
  async function press(page, d, sel, accept) {
    const n = d.seen.length;
    d.plan(accept);
    await page.locator(sel).click();
    await page.waitForFunction(() => !document.querySelector('[data-shuffle]:disabled'), null, { timeout: 20000 });
    await page.waitForTimeout(accept ? 50 : 300);
    return d.seen.slice(n);
  }
  const text = async (page, sel) => (await page.locator(sel).innerText()).replace(/\s+/g, ' ').trim();

  try {
    // ── 1. 이름·자리: 세 칸이 같은 규칙 ──
    await fill(db);
    {
      const { page } = await openBoard();
      const lay = await page.evaluate(() => [...document.querySelectorAll('[data-shuffle]')].map((b) => {
        const row = b.parentElement;
        return { what: b.dataset.shuffle, mode: b.dataset.mode, id: b.id, text: b.textContent.trim(), card: row.parentElement.id, rowTools2: row.classList.contains('tools2'),
          index: [...row.children].indexOf(b), sm: b.classList.contains('sm'), type: b.type };
      }));
      eq(lay.length, 6, '[자리] 자동 섞기 단추는 모두 여섯 개(팀·방·탑승 차량 × 안 뽑은 사람만·전부 새로)');
      for (const [what, it] of Object.entries(ITEM)) {
        const two = lay.filter((x) => x.what === what);
        eq(two.map((x) => [x.mode, x.text, x.id, x.card, x.rowTools2, x.index, x.sm, x.type]),
          [['fill', title(what, 'fill'), it.fill.slice(1), it.card, true, 0, true, 'button'], ['all', title(what, 'all'), it.all.slice(1), it.card, true, 1, true, 'button']],
          `[자리·${it.label}] "${title(what, 'fill')}"·"${title(what, 'all')}"가 ${it.card} 칸 안 아래 도구 줄(.tools2) 맨 앞에 차례로`);
      }
      eq(await page.locator('#menuCard [data-shuffle], #lunchCard [data-shuffle], #actCard [data-shuffle], #resetCard [data-shuffle], summary [data-shuffle]').count(), 0, '[자리] 고르는 칸(아침 메뉴·점심·자유시간)·초기화 칸·제목 줄에는 자동 섞기 없음');
      ok((await page.locator('#resetCard .reset-zone > p:first-child').textContent()).replace(/\s+/g, ' ').includes('자동 섞기는 각 칸(팀·객실표·탑승 차량) 아래 도구 줄에 있어요'), '[자리] 초기화 칸 설명에 "자동 섞기는 각 칸에 있어요"');
      eq(await page.locator('#resetCard .reset-items button').allTextContents(), ['팀 초기화', '방 초기화', '아침 메뉴 초기화', '점심 초기화', '자유시간 초기화', '탑승 차량 초기화', '점수 초기화'], '[자리] 항목별 초기화 단추는 그대로(맨 끝에 점수 초기화가 더해짐)');
      await page.close();
    }

    // ── 2. 세 항목 × 두 동작(마감 전): 확인 한 번 · 취소하면 요청 0건 · 호출 인자 · 결과 안내 · 그 항목만 바뀜 ──
    const EXPECT = { // [지금 기록 있는 사람, fill 대상, all 대상]
      team: [12, 17, 29], room: [10, 19, 29], car: [5, 23, 28],
    };
    for (const what of Object.keys(ITEM)) {
      for (const mode of ['fill', 'all']) {
        const it = ITEM[what], [have, nFill, nAll] = EXPECT[what], n = mode === 'all' ? nAll : nFill;
        await fill(db);
        const snap = await rows(db), conf = await settings(db);
        const { page, d } = await openBoard();
        await openCard(page, it.card);
        const tag = `[${title(what, mode)}]`;
        // 취소
        const c0 = server.calls.length;
        let seen = await press(page, d, it[mode], false);
        eq(seen.map((x) => x.type), ['confirm'], `${tag} 확인은 confirm 한 번(글자 적기·백업 없음)`);
        const first = seen[0].msg.split('\n')[0];
        ok(mode === 'all' ? first === `${title(what, mode)}: 지금 ${have}명의 ${it.label} 기록${what === 'car' ? '' : `(발표용 뽑기 화면에서 뽑은 ${it.label} 포함)`}을 지우고 전원(${n}명)을 새로 정해요. 되돌릴 수 없어요.`
          : first === `${title(what, mode)}: 안 뽑은 ${n}명을 자동으로 넣을까요?`, `${tag} 확인 첫 줄: ${first}`);
        ok(seen[0].msg.includes(`${it.label}만 바뀌고 다른 항목과 명단`) && !seen[0].msg.includes('마감('), `${tag} 확인에 "${it.label}만 바뀌고 다른 항목은 그대로"(마감 전이라 마감 줄 없음)`);
        if (what === 'car') ok(seen[0].msg.includes('운전자 1명은 차량이 정해져 있어 따로 정하지 않아요'), `${tag} 운전자 안내`);
        eq(writes(c0), [], `${tag}·취소 쓰기 요청 0건`);
        eq(diff(snap, await rows(db)), [], `${tag}·취소 DB 그대로`);
        // 확인
        const c1 = server.calls.length;
        seen = await press(page, d, it[mode], true);
        eq(seen.length, 1, `${tag}·확인 확인 상자 한 번만`);
        eq(writes(c1), [`admin_shuffle(${what},${mode})`], `${tag}·확인 쓰기 요청은 admin_shuffle 한 번`);
        const call = server.calls.slice(c1).find((c) => c.fn === 'admin_shuffle');
        eq([call.args.p_code === ADMIN_CODE, call.args.p_what, call.args.p_mode, call.status], [true, what, mode, 200], `${tag} 호출 인자`);
        const after = await rows(db);
        eq(diff(snap, after, it.cols), [], `${tag} 다른 항목(아침 메뉴·점심·자유시간 등)·명단은 그대로`);
        eq(await settings(db), conf, `${tag} 차량 목록·운전자 지정·일정표 그대로`);
        const guests = after.filter((r) => !(what === 'car' && Number(r.id) === 29));
        eq(guests.filter((r) => r[it.cols[0]] == null).length, 0, `${tag} 대상 전원이 정해짐`);
        if (what === 'car') eq(after.find((r) => Number(r.id) === 29).car, null, `${tag} 운전자는 손님 자리로 안 들어감`);
        if (mode === 'fill') eq(diff(snap.filter((r) => r[it.cols[0]] != null), after.filter((r) => snap.find((s) => s.id === r.id)[it.cols[0]] != null)), [], `${tag} 이미 정해진 ${have}명은 그대로`);
        const m = await text(page, it.msg);
        ok(m.startsWith(`${it.label}: ${mode === 'all' ? `${have}명의 기록을 지우고 ${n}명을 새로 정했어요` : `안 뽑은 ${n}명을 자동으로 넣었어요`}(`), `${tag} 결과 안내: ${m}`);
        if (what === 'car') ok(m.includes(`운전자라서 차량을 따로 안 정해요: ${who(29)}.`) && !m.includes('최종'), `${tag} 운전자 안내(이름·부서), 마감 전이라 "최종" 없음`);
        if (what === 'room') ok(m.includes('남녀 따로'), `${tag} 규칙 안내(남녀 따로)`);
        // 화면도 새로 받음
        const tile = { team: '팀', room: '방', car: '차량' }[what];
        await page.waitForFunction((t) => new RegExp(`${t} 29/29`).test(document.querySelector('#glanceSum').innerText.replace(/\s+/g, ' ')), tile, { timeout: 10000 }); // 차량은 손님 28 + 운전자 1
        ok(true, `${tag} 화면이 곧바로 새로 받아 "${tile} 29/29"`);
        await page.close();
      }
    }

    // ── 3. 마감 뒤(화면 시계를 마감 뒤로): 진행자는 그대로 쓸 수 있고, 탑승 차량은 결과가 최종이라는 안내 ──
    await fill(db);
    {
      const { page, d } = await openBoard({ clock: AFTER });
      await openCard(page, 'carCard');
      await openCard(page, 'teamCard');
      let seen = await press(page, d, '#teamAuto', false);
      ok(!seen[0].msg.includes('마감('), '[마감 뒤·팀] 팀은 마감과 상관없어 마감 줄 없음');
      seen = await press(page, d, '#carFill', false);
      ok(seen[0].msg.includes('⚠️ 마감(11/25(수) 15시)이 지나 참가자가 다시 뽑을 수 없어요. 여기서 새로 정해진 결과가 최종이에요(바꾸려면 진행자가 직접 옮겨야 해요).'), '[마감 뒤·차량 안 뽑은 사람만] 확인에 "결과가 최종" 안내');
      const c0 = server.calls.length;
      seen = await press(page, d, '#carAuto', true);
      ok(seen[0].msg.includes('여기서 새로 정해진 결과가 최종이에요'), '[마감 뒤·차량 전부 새로] 확인에 "결과가 최종" 안내');
      eq(writes(c0), ['admin_shuffle(car,all)'], '[마감 뒤·차량 전부 새로] 마감 뒤에도 호출됨');
      eq(filled(await rows(db), ['car']), 28, '[마감 뒤·차량 전부 새로] 손님 28명 모두 정해짐');
      ok((await text(page, '#carMsg')).includes('마감이 지나 참가자가 다시 뽑을 수 없으니 이 결과가 최종이에요. 바꾸려면 직접 옮기기를 켜서 고쳐 주세요.'), `[마감 뒤·차량] 결과 안내에도 "최종": ${await text(page, '#carMsg')}`);
      await page.close();
    }

    // ── 4. 건너뛴 사람: 성별 없는 사람(방) ──
    await fill(db, { noGender: true }); // id 29(견본고)는 성별 없음(차량 운전자이기도 함)
    {
      const { page, d } = await openBoard();
      await openCard(page, 'roomCard');
      const c0 = server.calls.length;
      let seen = await press(page, d, '#roomFill', true);
      ok(seen[0].msg.startsWith(`${title('room', 'fill')}: 안 뽑은 18명을 자동으로 넣을까요?`) && seen[0].msg.includes('성별이 없는 1명은 방을 정할 수 없어 빼고 정해요'), `[건너뜀·방] 확인에 대상 18명 + 성별 없는 1명 안내: ${seen[0].msg.split('\n').join(' / ')}`);
      eq(writes(c0), ['admin_shuffle(room,fill)'], '[건너뜀·방] admin_shuffle 한 번');
      const m = await text(page, '#roomMsg');
      ok(m.includes('안 뽑은 18명을 자동으로 넣었어요') && m.includes(`성별이 없어서 방을 못 정했어요: ${who(29)}.`), `[건너뜀·방] 결과에 누구인지(이름·부서)와 이유: ${m}`);
      eq((await rows(db)).find((r) => Number(r.id) === 29).room, null, '[건너뜀·방] 성별 없는 사람은 방 없음');
      // 0명: 남은 사람이 성별 없는 사람뿐 → 호출 없이 안내
      const c1 = server.calls.length;
      seen = await press(page, d, '#roomFill', true);
      eq(seen.length, 0, '[0명·방] 확인 상자 없이');
      eq(writes(c1), [], '[0명·방] 쓰기 요청 없음');
      ok((await text(page, '#roomMsg')).startsWith('넣을 사람이 없어요.') && (await text(page, '#roomMsg')).includes(`성별이 없어서 방을 못 정했어요: ${who(29)}`), `[0명·방] 안내: ${await text(page, '#roomMsg')}`);
      await page.close();
    }

    // ── 4-2. 방 전부 새로 섞기 확인: 성별이 없는데 방이 있는 사람은 방이 비워진다는 줄 ──
    await fill(db, { noGender: true });
    await db.query("update public.people set room = (select room from public.people where room is not null order by id limit 1) where id = 29");
    {
      const { page, d } = await openBoard();
      await openCard(page, 'roomCard');
      const c0 = server.calls.length;
      const seen = await press(page, d, '#roomAuto', false);
      ok(seen[0].msg.includes('성별이 없는 1명은 방을 정할 수 없어 빼고 정해요') && seen[0].msg.includes('그 중 지금 방이 있는 1명은 방이 비워져요.'), `[전부 새로·방] 성별 없는데 방 있는 1명은 방이 비워진다는 줄: ${seen[0].msg.split('\n').join(' / ')}`);
      eq(writes(c0), [], '[전부 새로·방] 취소하면 쓰기 요청 없음');
      // 방이 없는 성별 없는 사람이면 그 줄은 없음("안 뽑은 사람만"에서도 없음)
      await db.query('update public.people set room = null where id = 29');
      const seen2 = await press(page, d, '#roomAuto', false);
      ok(seen2[0].msg.includes('성별이 없는 1명은 방을 정할 수 없어') && !seen2[0].msg.includes('방이 비워져요'), '[전부 새로·방] 방이 없는 성별 없는 사람이면 "방이 비워져요" 줄 없음');
      await page.close();
    }

    // ── 4-3. 명단이 비어 있으면 "명단을 먼저 넣어 주세요"(다시 눌러 달라는 말 없음) ──
    await fill(db);
    {
      const { page, d } = await openBoard();
      await openCard(page, 'teamCard');
      await db.query('delete from public.people');
      const c0 = server.calls.length;
      const seen = await press(page, d, '#teamFill', true);
      eq(seen.length, 0, '[빈 명단·팀] 확인 상자 없이');
      const m = await text(page, '#teamMsg');
      ok(m.includes('명단을 먼저 넣어 주세요') && m.includes('명단이 비어 있어요') && !m.includes('다시 눌러 주세요'), `[빈 명단·팀] "다시 눌러" 대신 "명단을 먼저": ${m}`);
      eq(writes(c0), [], '[빈 명단·팀] 쓰기 요청 없음');
      await page.close();
    }

    // ── 5. 0명이면 호출 없이 안내(팀·차량) ──
    await fill(db);
    await db.query("update public.people set team = (array['red','blue','yellow','green'])[1 + id % 4], picked_at = now() where team is null");
    await db.query("update public.people set car = case when id % 2 = 0 then 'car1' else 'car2' end, car_at = now() where car is null and id <> 29");
    {
      const { page, d } = await openBoard();
      await openCard(page, 'teamCard');
      await openCard(page, 'carCard');
      const c0 = server.calls.length;
      let seen = await press(page, d, '#teamFill', true);
      eq(seen.length, 0, '[0명·팀] 확인 상자 없이');
      eq(await text(page, '#teamMsg'), '넣을 사람이 없어요. 모두 팀이 정해져 있어요.', '[0명·팀] 안내');
      seen = await press(page, d, '#carFill', true);
      eq(seen.length, 0, '[0명·차량] 확인 상자 없이');
      eq(await text(page, '#carMsg'), '넣을 사람이 없어요. 모두 차량이 정해져 있어요.', '[0명·차량] 안내(운전자는 세지 않음)');
      eq(writes(c0), [], '[0명] 쓰기 요청 없음');
      await page.close();
    }

    // ── 6. 진행 중에는 단추 여섯 개를 잠금(느린 응답 + 5초 자동 새로 받기와 겹침) ──
    await fill(db);
    {
      const { page, d } = await openBoard();
      for (const id of ['teamCard', 'roomCard', 'carCard']) await openCard(page, id);
      await page.route('**/rest/v1/rpc/admin_shuffle', async (route) => { await new Promise((r) => setTimeout(r, 6000)); return route.fallback(); });
      const c0 = server.calls.length;
      d.plan(true);
      await page.locator('#teamFill').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-shuffle]:disabled').length === 6, null, { timeout: 5000 });
      for (let i = 0; i < 300 && d.seen.length < 1; i++) await page.waitForTimeout(50); // 확인 상자를 지나 요청을 보낸 뒤(고정 대기 대신 기다림)
      await page.waitForTimeout(300);
      // 잠긴 동안 여러 번 눌러 봄(다른 항목 포함) — 막혀야 함
      await page.evaluate(() => { for (let i = 0; i < 5; i++) for (const b of document.querySelectorAll('[data-shuffle]')) b.click(); });
      const bs0 = server.calls.filter((c) => c.fn === 'board_state').length;
      await page.waitForTimeout(5200); // 그사이 5초 자동 새로 받기가 한 번 돎
      const disabled = await page.evaluate(() => document.querySelectorAll('[data-shuffle]:disabled').length);
      ok(server.calls.filter((c) => c.fn === 'board_state').length > bs0, '[잠금] 기다리는 동안 5초 자동 새로 받기가 돎');
      eq(disabled, 6, '[잠금] 자동 새로 받기가 돌아도 여섯 단추가 계속 잠김');
      await page.waitForFunction(() => !document.querySelector('[data-shuffle]:disabled'), null, { timeout: 15000 });
      eq(d.seen.length, 1, '[잠금] 확인 상자는 처음 한 번뿐');
      eq(writes(c0), ['admin_shuffle(team,fill)'], '[잠금] 여러 번 눌러도 요청은 한 번');
      ok((await text(page, '#teamMsg')).startsWith('팀: 안 뽑은 17명을 자동으로 넣었어요'), `[잠금] 끝나면 결과 안내: ${await text(page, '#teamMsg')}`);
      eq(filled(await rows(db), ['team']), 29, '[잠금] 끝나고 전원 팀');
      await page.unroute('**/rest/v1/rpc/admin_shuffle');
      await page.close();
    }

    // ── 7. 실패: 이유와 "아무것도 바뀌지 않았어요" → 다시 누르면 됨 ──
    await fill(db);
    {
      const snap = await rows(db);
      const { page, d } = await openBoard();
      await openCard(page, 'roomCard');
      await page.route('**/rest/v1/rpc/admin_shuffle', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '시험용 실패', code: 'P0001', details: null, hint: null }) }));
      await press(page, d, '#roomAuto', true);
      const m = await text(page, '#roomMsg');
      eq(m, '방 전부 새로 섞기를 하지 못했어요. 아무것도 바뀌지 않았어요. 다시 눌러 주세요. (이유: 시험용 실패)', '[실패] 칸 안내에 이유와 "아무것도 바뀌지 않았어요"');
      ok(await page.locator('#roomMsg').evaluate((e) => e.classList.contains('err')), '[실패] 안내가 오류 색');
      ok((await text(page, '#error')).includes('아무것도 바뀌지 않았어요'), '[실패] 화면 위 오류 줄에도');
      eq(diff(snap, await rows(db)), [], '[실패] DB 그대로');
      ok(await page.locator('#roomAuto').isEnabled(), '[실패] 단추 잠금이 풀림');
      await page.unroute('**/rest/v1/rpc/admin_shuffle');
      await press(page, d, '#roomAuto', true);
      ok((await text(page, '#roomMsg')).startsWith('방: 10명의 기록을 지우고 29명을 새로 정했어요'), `[실패 뒤 다시] 됨: ${await text(page, '#roomMsg')}`);
      ok(!(await page.locator('#roomMsg').evaluate((e) => e.classList.contains('err'))), '[실패 뒤 다시] 오류 색 풀림');
      // 보낸 뒤 답을 못 받음(서버에서는 끝남 + 연결 끊김): "아무것도 바뀌지 않았어요"라고 하지 않고 화면을 새로 받아 보게 함
      await fill(db);
      await page.route('**/rest/v1/rpc/admin_shuffle', async (route) => {
        await fetch(`${server.url}/rest/v1/rpc/admin_shuffle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() }); // 로컬 대리 서버에서 실제로 처리
        return route.abort('failed');
      });
      await openCard(page, 'teamCard');
      await press(page, d, '#teamFill', true);
      const um = await text(page, '#teamMsg');
      ok(um.startsWith('팀 자동 섞기 · 안 뽑은 사람만의 결과를 확인하지 못했어요. 화면을 새로 받았으니 바뀌었는지 보고') && !um.includes('아무것도 바뀌지 않았어요'), `[답 못 받음] "결과를 확인하지 못했어요"(안 바뀌었다고 하지 않음): ${um}`);
      eq(filled(await rows(db), ['team']), 29, '[답 못 받음] 서버에서는 섞기가 끝남');
      await page.waitForFunction(() => /팀 29\/29/.test(document.querySelector('#glanceSum').innerText.replace(/\s+/g, ' ')), null, { timeout: 10000 });
      ok(true, '[답 못 받음] 화면을 새로 받아 "팀 29/29"');
      await page.unroute('**/rest/v1/rpc/admin_shuffle');
      await page.close();
    }

    // ── 8. 함수 없는 예전 DB(admin_shuffle → 404 PGRST202): 방은 예전 방식으로 대신, 팀·차량은 안내만 ──
    server.missing.add('admin_shuffle');
    try {
      for (const mode of ['all', 'fill']) {
        await fill(db);
        const snap = await rows(db);
        const { page, d } = await openBoard();
        await openCard(page, 'roomCard');
        const c0 = server.calls.length;
        await press(page, d, mode === 'all' ? '#roomAuto' : '#roomFill', true);
        eq(writes(c0), [`admin_shuffle(room,${mode}):404`, 'admin_assign(room)'], `[예전 DB·방 ${mode}] admin_shuffle 404 → 예전 방식(admin_assign) 한 번`);
        const after = await rows(db);
        eq(diff(snap, after, ['room']), [], `[예전 DB·방 ${mode}] 방만 바뀜`);
        const count = (keys) => keys.map((k) => after.filter((r) => r.room === k).length);
        const men = count(['m1', 'm2', 'm3', 'm4', 'm5']), women = count(['f1', 'f2']);
        ok(after.every((r) => r.room && r.room[0] === (r.gender === '남' ? 'm' : 'f')) && Math.max(...men) - Math.min(...men) <= 1 && Math.max(...women) - Math.min(...women) <= 1, `[예전 DB·방 ${mode}] 전원 남녀 따로·인원 차이 1 이내: 남 ${men} 여 ${women}`);
        if (mode === 'fill') eq(diff(snap.filter((r) => r.room), after.filter((r) => snap.find((s) => s.id === r.id).room)), [], '[예전 DB·방 fill] 이미 방이 있던 10명은 그대로');
        const m = await text(page, '#roomMsg');
        ok(m.startsWith('예전 방식으로 나눴어요') && m.includes(mode === 'all' ? '10명의 기록을 지우고 29명을 새로 정했어요' : '안 뽑은 19명을 자동으로 넣었어요'), `[예전 DB·방 ${mode}] "예전 방식으로 나눴어요" 표시: ${m}`);
        await page.close();
      }
      await fill(db);
      const snap = await rows(db);
      const { page, d } = await openBoard();
      for (const id of ['teamCard', 'carCard']) await openCard(page, id);
      for (const [what, sel] of [['team', '#teamFill'], ['team', '#teamAuto'], ['car', '#carFill'], ['car', '#carAuto']]) {
        const c0 = server.calls.length;
        await press(page, d, sel, true);
        eq(writes(c0), [`admin_shuffle(${what},${sel.endsWith('Fill') ? 'fill' : 'all'}):404`], `[예전 DB·${sel}] 404 뒤 다른 쓰기 없음`);
        const m = await text(page, ITEM[what].msg);
        ok(m.includes('하지 못했어요. 아무것도 바뀌지 않았어요') && m.includes(OLD_DB), `[예전 DB·${sel}] 알기 쉬운 안내: ${m}`);
      }
      eq(diff(snap, await rows(db)), [], '[예전 DB·팀·차량] DB 그대로');
      await page.close();
    } finally {
      server.missing.delete('admin_shuffle');
    }

    // ── 9. 아침 메뉴 초기화: admin_clear('menu') 한 번으로 메뉴만 비움 · 예전 DB(그 항목 거절)에서는 예전 방식으로 대신 ──
    for (const old of [false, true]) {
      await fill(db);
      const snap = await rows(db);
      const { page, d } = await openBoard();
      await openCard(page, 'resetCard');
      if (old) await page.route('**/rest/v1/rpc/admin_clear', (route) => (route.request().postDataJSON().p_what === 'menu'
        ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '바꿀 수 없는 항목이에요.', code: 'P0001', details: null, hint: null }) })
        : route.fallback()));
      const c0 = server.calls.length;
      const n = d.seen.length;
      d.plan(true);
      await page.locator('#resetMenu').click();
      await page.waitForFunction(() => /마쳤어요|하지 못했어요/.test(document.querySelector('#resetMsg').textContent), null, { timeout: 15000 });
      eq(d.seen.length - n, 1, `[아침 메뉴 초기화${old ? '·예전 DB' : ''}] 확인 한 번`);
      // 예전 DB 흉내는 브라우저에서 막았으므로 서버 기록에는 admin_clear(menu) 가 없음
      eq(writes(c0), old ? ['admin_assign(menu)'] : ['admin_clear(menu)'], old ? '[아침 메뉴 초기화·예전 DB] admin_clear(menu) 거절 → 예전 방식 admin_assign(menu) 한 번' : '[아침 메뉴 초기화] admin_clear(menu) 한 번(읽고 쓰는 두 단계 없음)');
      const after = await rows(db);
      eq(filled(after, ['menu']), 0, `[아침 메뉴 초기화${old ? '·예전 DB' : ''}] 아침 메뉴 모두 비움`);
      eq(diff(snap, after, ['menu']), [], `[아침 메뉴 초기화${old ? '·예전 DB' : ''}] 팀 등 다른 항목은 그대로`);
      ok((await text(page, '#resetMsg')).startsWith('아침 메뉴 초기화를 마쳤어요'), `[아침 메뉴 초기화${old ? '·예전 DB' : ''}] 끝 문구`);
      await page.close();
    }

    // ── 9-2. 초기화하면 그 항목의 섞기 결과 문구("자동으로 넣었어요…")를 지움(팀·탑승 차량·전체) ──
    for (const [btn, cleared] of [['#resetTeam', ['team']], ['#resetCar', ['car']], ['#resetEvery', ['team', 'car', 'room']]]) {
      await fill(db);
      const { page, d } = await openBoard();
      for (const id of ['teamCard', 'roomCard', 'carCard', 'resetCard']) await openCard(page, id);
      await press(page, d, '#teamFill', true);
      await press(page, d, '#carFill', true);
      await press(page, d, '#roomFill', true);
      for (const w of ['team', 'car', 'room']) ok((await text(page, ITEM[w].msg)).includes('자동으로 넣었어요'), `[초기화 문구·${btn}] 먼저 ${ITEM[w].label} 결과 문구가 있음`);
      d.plan(true);
      await page.locator(btn).click();
      await page.waitForFunction(() => /마쳤어요|하지 못했어요/.test(document.querySelector('#resetMsg').textContent), null, { timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('#resetCard button:disabled'), null, { timeout: 15000 });
      for (const w of ['team', 'car', 'room']) {
        const m = await text(page, ITEM[w].msg), msgCls = await page.locator(ITEM[w].msg).evaluate((e) => e.classList.contains('err'));
        if (cleared.includes(w)) ok(m === '' && !msgCls, `[초기화 문구·${btn}] ${ITEM[w].label} 결과 문구 지워짐`);
        else ok(m.includes('자동으로 넣었어요'), `[초기화 문구·${btn}] 비우지 않은 ${ITEM[w].label}의 문구는 그대로`);
      }
      await page.close();
    }

    // ── 10. 390px·1280px·프로젝터 보기 ──
    await fill(db);
    {
      const { page } = await openBoard({ width: 390 });
      for (const id of ['teamCard', 'roomCard', 'carCard']) await openCard(page, id);
      await page.waitForTimeout(300);
      const g = await page.evaluate(() => ({
        btn: [...document.querySelectorAll('[data-shuffle]')].map((b) => { const r = b.getBoundingClientRect(); return { id: b.id, h: Math.round(r.height * 10) / 10, l: r.left, r: r.right, over: b.scrollWidth > b.clientWidth + 1 }; }),
        doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
      }));
      ok(g.btn.every((b) => b.h >= 39.5), `[390px] 자동 섞기 단추 높이 40px 이상: ${g.btn.map((b) => `${b.id} ${b.h}`).join(', ')}`);
      ok(g.btn.every((b) => b.l >= 0 && b.r <= 390 && !b.over), `[390px] 단추가 화면 밖으로 안 나가고 글자가 단추 밖으로 안 넘침: ${g.btn.map((b) => `${b.id} ${Math.round(b.l)}~${Math.round(b.r)}`).join(', ')}`);
      ok(g.doc[0] <= g.doc[1], `[390px] 페이지가 가로로 안 넘침(${g.doc[0]} ≤ ${g.doc[1]})`);
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/shuffle_390.png`, fullPage: true }); // 눈으로 볼 때: SHOT_DIR=폴더
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(200);
      const wide = await page.evaluate(() => [...document.querySelectorAll('[data-shuffle]')].map((b) => Math.round(b.getBoundingClientRect().height)));
      ok(wide.every((h) => h === 36), `[1280px] 단추는 다른 작은 단추와 같은 36px: ${wide.join(',')}`);
      const sameRow = await page.evaluate(() => ['team', 'room', 'car'].every((w) => { const [a, b] = document.querySelectorAll(`[data-shuffle="${w}"]`); return Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 2; }));
      ok(sameRow, '[1280px] 각 칸의 두 단추가 한 줄에 나란히');
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/shuffle_1280.png`, fullPage: true });
      await page.close();
      const tv = await openBoard({ url: '?tv=1' });
      await tv.page.locator('#columns .col').first().waitFor({ timeout: 10000 });
      await tv.page.waitForTimeout(500);
      eq(await tv.page.locator('[data-shuffle]:visible, #teamMsg:visible').count(), 0, '[프로젝터 보기] 자동 섞기 단추·안내는 안 보임');
      if (process.env.SHOT_DIR) await tv.page.screenshot({ path: `${process.env.SHOT_DIR}/shuffle_tv.png`, fullPage: true });
      await tv.page.close();
    }

    eq(errors, [], '페이지 오류 없음');
    env.guard.assertClean();
    console.log(`  운영 주소로 나간 요청 0건(로컬로 돌린 supabase 요청 ${env.guard.proxied.length}건)`);
    return { ok: true, pass };
  } finally {
    await env.close();
    await server.close();
    await db.end();
  }
}
