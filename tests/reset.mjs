// 관리자 페이지(board.html) 초기화 칸 시험: 전체 초기화 · 항목별 초기화 일곱 개(팀·방·아침 메뉴·점심·자유시간·탑승 차량 + 팀 점수) · 확인 한 번(백업 단계 없음) · 마감 문구 · 참가자 화면 · 중간 실패 뒤 이어서.
// 사용: node run.mjs reset   (DB 올리기 → 시험 → DB 끄기). 운영 DB 에는 닿지 않음(helpers.mjs 의 guardNetwork).
// 견본 이름은 seed.mjs 의 지어낸 이름('견본○'), 관리자 비밀번호는 시험용 값.
import assert from 'node:assert/strict';
import { ADMIN_CODE, connect } from './db.mjs';
import { resetRoster, roster } from './seed.mjs';
import { startServer } from './server.mjs';
import { openTestBrowser, guardNetwork } from './helpers.mjs';

// 항목 → DB 칸(그 항목을 비우면 이 칸만 바뀌어야 함)
const ITEM_COLS = {
  team: ['team', 'picked_at'], room: ['room'], menu: ['menu'], lunch: ['lunch'], activity: ['activity'], car: ['car', 'car_at'],
};
const ITEMS = Object.keys(ITEM_COLS);
const ALL_COLS = Object.values(ITEM_COLS).flat();
// 일곱째 항목 '점수'는 사람 칸이 아니라 team_scores 표(점수 0이 아닌 팀 수가 확인 문구에 '점수 N팀'으로 나옴)
const SCORES = { red: 120, blue: -30, yellow: 0, green: 5 }; // fill() 이 채우는 점수 → 0이 아닌 팀 3개
const LABEL = { team: '팀', room: '방', menu: '아침 메뉴', lunch: '점심', activity: '자유시간', car: '탑승 차량', score: '점수' };
const BTN = { team: '#resetTeam', room: '#resetRoom', menu: '#resetMenu', lunch: '#resetLunch', activity: '#resetAct', car: '#resetCar', score: '#resetScore' };
const CARS = [{ id: 'car1', name: '1호차', label: '견본 문구', driver: 29 }, { id: 'car2', name: '2호차', label: '' }]; // 운전자: 견본고(id 29)
const SCHEDULE = '12/17(목)\n10:00 견본 일정';
const BEFORE = '2026-11-24T10:00:00+09:00'; // 마감 전(화면 시계)
const AFTER = '2026-11-26T10:00:00+09:00';  // 마감 뒤(화면 시계)

// 일곱 항목을 모두 채운 상태: seed --picked(팀·조식 12명, 방 10명 중 성별 있는 사람, 점심 8명, 자유시간 6명) + 차량 목록·운전자 + 차량 손님 5명 + 일정표 + 팀 점수(빨강 120·파랑 −30·초록 5)
async function fill(db) {
  await resetRoster(db, { picked: true });
  await db.query('select public.admin_set_cars($1, $2::jsonb)', [ADMIN_CODE, JSON.stringify(CARS)]);
  await db.query("update public.people set car = case when id % 2 = 0 then 'car1' else 'car2' end, car_at = now() - (10 - id) * interval '1 second' where id <= 5");
  await db.query("insert into public.config (key, value) values ('schedule', $1) on conflict (key) do update set value = excluded.value", [SCHEDULE]);
  await db.query('update public.team_scores set score = case team when $1 then $2::bigint when $3 then $4::bigint when $5 then $6::bigint else $7::bigint end, updated_at = now()', ['red', SCORES.red, 'blue', SCORES.blue, 'green', SCORES.green, SCORES.yellow]);
}
const scoresOf = async (db) => Object.fromEntries((await db.query('select team, score from public.team_scores order by team')).rows.map((r) => [r.team, Number(r.score)]));
const NONZERO = Object.values(SCORES).filter((v) => v !== 0).length; // 확인 문구의 '점수 N팀'
const rows = async (db) => (await db.query(
  `select id, dept, name, title, gender, is_exec, team, picked_at::text, menu, room, activity, lunch, car, car_at::text from public.people order by id`)).rows;
const settings = async (db) => Object.fromEntries((await db.query(
  `select key, value from public.config where key in ('cars', 'schedule', 'admin_code') order by key`)).rows.map((r) => [r.key, r.value]));
const filled = (rs, cols) => rs.filter((r) => cols.some((c) => r[c] != null)).length;
// 두 명단의 차이(ignore 칸은 보지 않음). 같으면 []
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

// 확인 상자 처리: 오는 순서대로 plan(true = 확인, false = 취소)을 따르고, 계획이 없으면 취소. 모든 상자를 seen 에 적음
function dialogs(page) {
  const seen = [], plan = [];
  page.on('dialog', async (d) => {
    seen.push({ type: d.type(), msg: d.message() });
    if (plan.shift()) await d.accept(); else await d.dismiss();
  });
  return { seen, plan: (...a) => plan.push(...a) };
}

export async function resetTests() {
  const db = await connect();
  const server = await startServer({ port: 0 });
  const env = await openTestBrowser(server.url);
  let pass = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log('  통과: ' + msg); };
  const eq = (a, b, msg) => { assert.deepEqual(a, b, `${msg}\n    기대: ${JSON.stringify(b)}\n    실제: ${JSON.stringify(a)}`); pass++; console.log('  통과: ' + msg); };
  const errors = [];
  const fnCalls = (from) => server.calls.slice(from).filter((c) => /^admin_|^board_state$/.test(c.fn) && c.fn !== 'board_state');

  // 관리자 화면 열기(비밀번호는 저장된 것으로). clock: 화면 시계를 그 시각으로 고정
  async function openBoard(clock = BEFORE) {
    const page = await env.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    if (clock) await page.clock.setFixedTime(new Date(clock));
    // 칸 열림 기억은 이 탭을 처음 열 때만 지움(앞 시험에서 연 초기화 칸이 열린 채로 남아 아래 제목 줄 누르기가 도리어 접지 않게)
    await page.addInitScript((c) => { try { localStorage.setItem('team-picker-admin', JSON.stringify(c)); if (!sessionStorage.getItem('fresh')) { localStorage.removeItem('team-picker-board-open'); sessionStorage.setItem('fresh', '1'); } } catch {} }, ADMIN_CODE);
    const d = dialogs(page);
    const downloads = [];
    page.on('download', (x) => downloads.push(x.suggestedFilename()));
    await page.goto(`${server.url}/board.html`);
    await page.locator('#glanceBody tr').nth(28).waitFor({ timeout: 10000 });
    await page.locator('#resetCard > summary').click();
    return { page, d, downloads };
  }
  // 단추를 누르고 결과 문구가 나올 때까지 기다림(확인을 취소했으면 문구가 비어 있으므로 confirm 상자가 뜬 뒤 잠깐 기다림)
  async function press(page, d, sel, accept) {
    const n = d.seen.length;
    d.plan(accept);
    await page.locator(sel).click();
    await page.waitForFunction(() => !document.querySelector('#resetCard button:disabled'), null, { timeout: 15000 });
    if (accept) await page.waitForFunction(() => /마쳤어요|멈췄어요|하지 못했어요/.test(document.querySelector('#resetMsg').textContent), null, { timeout: 15000 });
    else await page.waitForTimeout(300);
    return d.seen.slice(n);
  }

  try {
    // ── 0. 화면 구성: 이름·자리·없어진 단추 ──
    await fill(db);
    {
      const { page } = await openBoard();
      const names = await page.locator('#resetCard .reset-items button').allInnerTexts();
      eq(names, ['팀 초기화', '방 초기화', '아침 메뉴 초기화', '점심 초기화', '자유시간 초기화', '탑승 차량 초기화', '점수 초기화'], '항목별 초기화 일곱 개가 초기화 칸 한곳에 "○○ 초기화" 이름으로 있음(맨 끝이 점수 초기화)');
      eq((await page.locator('#resetEvery').innerText()).trim(), '전체 초기화', '전체 초기화 단추');
      eq(await page.locator('#resetAll, #roomClear, #actClear, #carClear').count(), 0, '예전 단추(전체 다시 뽑기·객실 모두 비우기·고른 것 모두 지우기·차량 모두 비우기)는 없음');
      eq(await page.locator('#removeAll').count(), 1, '명단 전체 삭제 단추는 그대로 있음');
      eq(await page.locator('#exportBtn').count(), 1, '엑셀 파일로 받기(백업) 단추는 그대로 있음');
      await page.close();
    }

    // ── 1. 전체 초기화: 취소하면 그대로, 확인하면 일곱 항목(팀·방·아침 메뉴·점심·자유시간·탑승 차량·점수) 모두 비움(설정·명단·일정표는 그대로) ──
    await fill(db);
    {
      const snap = await rows(db), conf = await settings(db);
      const cnt = ITEMS.map((k) => filled(snap, ITEM_COLS[k]));
      ok(cnt.every((x) => x > 0) && NONZERO === 3, `준비: 일곱 항목이 모두 채워짐(${ITEMS.map((k, i) => `${LABEL[k]} ${cnt[i]}`).join('·')}·점수 ${NONZERO}팀)`);
      eq(await scoresOf(db), SCORES, '준비: 팀 점수 빨강 120·파랑 −30·노랑 0·초록 5');
      const { page, d, downloads } = await openBoard(BEFORE);
      const c0 = server.calls.length;
      let seen = await press(page, d, '#resetEvery', false);
      eq(seen.map((x) => x.type), ['confirm'], '[전체·취소] 확인 상자는 confirm 한 번(글자 적기·prompt 없음)');
      const m = seen[0].msg;
      ok(m.startsWith(`전체 초기화: ${ITEMS.map((k, i) => `${LABEL[k]} ${cnt[i]}명`).join(' · ')} · 점수 ${NONZERO}팀의 기록을 지울까요?`), `[전체] 확인 문구 첫 줄에 항목별 인원과 점수 팀 수: ${m.split('\n')[0]}`);
      ok(m.includes('마감(11/25(수) 15시) 전까지 참가자가 다시 고르거나 뽑을 수 있어요') && !m.includes('직접 넣어야'), '[전체·마감 전] "마감 전까지 다시 고를 수 있어요"(직접 넣으라는 말 없음)');
      ok(m.includes('명단·일정표·차량 목록(운전자 지정 포함)은 그대로'), '[전체] 남는 것 안내');
      eq(diff(snap, await rows(db)), [], '[전체·취소] DB 그대로');
      eq(await scoresOf(db), SCORES, '[전체·취소] 팀 점수도 그대로');
      eq(fnCalls(c0).length, 0, '[전체·취소] 쓰기 요청 없음');
      ok(await page.locator('#backupBox').isHidden(), '[전체·취소] 백업 상자 안 뜸');

      const c1 = server.calls.length;
      seen = await press(page, d, '#resetEvery', true);
      eq(seen.map((x) => x.type), ['confirm'], '[전체·확인] 확인 상자 한 번만');
      ok(await page.locator('#backupBox').isHidden(), '[전체·확인] 백업 상자 안 뜸');
      eq(downloads, [], '[전체·확인] 백업 파일 받기 없음');
      const after = await rows(db);
      eq(ITEMS.map((k) => filled(after, ITEM_COLS[k])), [0, 0, 0, 0, 0, 0], '[전체·확인] 사람 칸 여섯 항목(팀·방·아침·점심·자유시간·탑승 차량) 모두 비움');
      eq(await scoresOf(db), { red: 0, blue: 0, yellow: 0, green: 0 }, '[전체·확인] 팀 점수 네 팀 모두 0점');
      eq(diff(snap, after, ALL_COLS), [], '[전체·확인] 명단(부서·이름·직급·성별)은 그대로');
      eq(await settings(db), conf, '[전체·확인] 일정표·차량 목록·운전자 지정·관리자 비밀번호 그대로');
      eq(fnCalls(c1).map((c) => c.fn + (c.args.p_what ? `(${c.args.p_what})` : '')), ['admin_reset_all', 'admin_clear(room)', 'admin_clear(lunch)', 'admin_clear(activity)', 'admin_clear_cars', 'admin_clear(score)'], '[전체·확인] 부른 함수(차례대로, 점수는 맨 끝에 admin_clear(score) 한 번)');
      ok(/전체 초기화를 마쳤어요\(팀·방·아침 메뉴·점심·자유시간·탑승 차량·점수 비움\)/.test(await page.locator('#resetMsg').innerText()), '[전체·확인] 끝 문구');
      // 화면도 비워짐
      await page.waitForFunction(() => /방 0\/29/.test(document.querySelector('#glanceSum').innerText.replace(/\s+/g, ' ')), null, { timeout: 10000 });
      ok(/^1\/29명 정해짐/.test(await page.locator('#carCount').innerText()), `[전체·확인] 탑승 차량 칸 제목도 비워짐(손님은 0명, 운전자 1명만 정해진 것으로 셈): ${await page.locator('#carCount').innerText()}`);
      await page.close();
    }

    // ── 2. 항목별 초기화 여섯 개(사람 칸): 그 항목만 비우고 나머지 다섯과 팀 점수는 그대로 ──
    for (const k of ITEMS) {
      await fill(db);
      const snap = await rows(db), conf = await settings(db);
      const { page, d } = await openBoard(BEFORE);
      // 취소 먼저
      const c0 = server.calls.length;
      let seen = await press(page, d, BTN[k], false);
      eq(diff(snap, await rows(db)), [], `[${LABEL[k]}·취소] DB 그대로`);
      eq(await scoresOf(db), SCORES, `[${LABEL[k]}·취소] 팀 점수도 그대로`);
      eq(fnCalls(c0).length, 0, `[${LABEL[k]}·취소] 쓰기 요청 없음`);
      const n = filled(snap, ITEM_COLS[k]);
      ok(seen.length === 1 && seen[0].type === 'confirm' && seen[0].msg.startsWith(`${LABEL[k]} 초기화: ${LABEL[k]} ${n}명의 기록을 지울까요?`), `[${LABEL[k]}] 확인 한 번, 첫 줄: ${seen[0] && seen[0].msg.split('\n')[0]}`);
      ok(k === 'car'
        ? seen[0].msg.includes('다른 항목과 명단·일정표·차량 목록(운전자 지정 포함)은 그대로 남아요.')
        : seen[0].msg.includes('다른 항목과 명단·일정표는 그대로 남아요.') && !seen[0].msg.includes('일정표은'), `[${LABEL[k]}] 남는 것 안내의 조사가 맞음`);
      // 확인
      seen = await press(page, d, BTN[k], true);
      eq(seen.length, 1, `[${LABEL[k]}·확인] 확인 상자 한 번만`);
      ok(await page.locator('#backupBox').isHidden(), `[${LABEL[k]}·확인] 백업 상자 안 뜸`);
      const after = await rows(db);
      eq(filled(after, ITEM_COLS[k]), 0, `[${LABEL[k]}·확인] ${LABEL[k]} 모두 비움(${n}명 → 0명)`);
      eq(diff(snap, after, ITEM_COLS[k]), [], `[${LABEL[k]}·확인] 다른 다섯 항목과 명단은 그대로`);
      eq(await scoresOf(db), SCORES, `[${LABEL[k]}·확인] 팀 점수는 그대로(점수는 점수 초기화로만 비워짐)`);
      eq(await settings(db), conf, `[${LABEL[k]}·확인] 일정표·차량 목록·운전자 지정 그대로`);
      ok((await page.locator('#resetMsg').innerText()).startsWith(`${LABEL[k]} 초기화를 마쳤어요`), `[${LABEL[k]}·확인] 끝 문구`);
      await page.close();
    }

    // ── 2b. 점수 초기화: 취소하면 점수 그대로, 확인하면 admin_clear(score) 한 번·점수만 0 · 팀·방·아침 메뉴·점심·자유시간·차량·명단·일정표는 그대로 · confirm 한 번 ──
    await fill(db);
    {
      const snap = await rows(db), conf = await settings(db);
      const { page, d, downloads } = await openBoard(BEFORE);
      ok(/^점수 초기화$/.test((await page.locator('#resetScore').innerText()).trim()) && await page.locator('#resetCard .reset-items #resetScore').count() === 1, '[점수] 초기화 칸 항목별 단추에 "점수 초기화"');
      const c0 = server.calls.length;
      let seen = await press(page, d, '#resetScore', false);
      eq(seen.map((x) => x.type), ['confirm'], '[점수·취소] 확인 상자는 confirm 한 번');
      ok(seen[0].msg.startsWith(`점수 초기화: 점수 ${NONZERO}팀의 기록을 지울까요?`), `[점수] 확인 문구 첫 줄에 점수가 0이 아닌 팀 수: ${seen[0].msg.split('\n')[0]}`);
      ok(seen[0].msg.includes('다른 항목과 명단·일정표는 그대로 남아요.') && !seen[0].msg.includes('직접 넣어야') && !seen[0].msg.includes('마감'), '[점수] 남는 것 안내(마감 문장은 없음)');
      eq(await scoresOf(db), SCORES, '[점수·취소] 점수 그대로');
      eq(diff(snap, await rows(db)), [], '[점수·취소] 사람 DB 그대로');
      eq(fnCalls(c0).length, 0, '[점수·취소] 쓰기 요청 없음');

      const c1 = server.calls.length;
      seen = await press(page, d, '#resetScore', true);
      eq(seen.map((x) => x.type), ['confirm'], '[점수·확인] 확인 상자 한 번만(글자 적기·prompt 없음)');
      ok(await page.locator('#backupBox').isHidden(), '[점수·확인] 백업 상자 안 뜸');
      eq(downloads, [], '[점수·확인] 백업 파일 받기 없음');
      eq(fnCalls(c1).map((c) => c.fn + (c.args.p_what ? `(${c.args.p_what})` : '')), ['admin_clear(score)'], '[점수·확인] 부른 함수는 admin_clear(score) 한 번뿐');
      eq(await scoresOf(db), { red: 0, blue: 0, yellow: 0, green: 0 }, '[점수·확인] 네 팀 점수 모두 0');
      eq(diff(snap, await rows(db)), [], '[점수·확인] 팀·방·아침 메뉴·점심·자유시간·탑승 차량·명단 모두 그대로');
      eq(await settings(db), conf, '[점수·확인] 일정표·차량 목록·운전자 지정·관리자 비밀번호 그대로');
      ok((await page.locator('#resetMsg').innerText()).startsWith('점수 초기화를 마쳤어요(점수 비움)'), '[점수·확인] 끝 문구');
      await page.waitForFunction(() => /^빨강 0 · 파랑 0 · 노랑 0 · 초록 0$/.test(document.querySelector('#scoreCount').textContent.trim()), null, { timeout: 10000 });
      ok(true, '[점수·확인] 팀 점수 칸 제목 줄도 0점으로 바뀜');
      // 이미 0점이면 점수 0팀: 다시 눌러도 오류 없이 지나감
      seen = await press(page, d, '#resetScore', true);
      ok(seen[0].msg.startsWith('점수 초기화: 점수 0팀의'), `[점수·이미 0점] 확인 문구: ${seen[0].msg.split('\n')[0]}`);
      ok(/점수 초기화를 마쳤어요/.test(await page.locator('#resetMsg').innerText()), '[점수·이미 0점] 오류 없이 끝');
      await page.close();
    }

    // ── 3. 마감 뒤 확인 문구(화면 시계를 마감 뒤로) + 문구 만드는 함수 단위 확인 ──
    await fill(db);
    {
      const { page, d } = await openBoard(AFTER);
      let seen = await press(page, d, '#resetEvery', false);
      const m = seen[0].msg;
      ok(m.includes('⚠️ 마감(11/25(수) 15시)이 지나 참가자가 다시 고르거나 뽑을 수 없어요(아침 메뉴·점심·자유시간·탑승 차량). 지운 뒤에는 진행자가 직접 넣어야 해요.'), '[마감 뒤·전체] 진행자가 직접 넣어야 한다는 문장');
      ok(!m.includes('전까지 참가자가 다시'), '[마감 뒤·전체] "마감 전까지 다시 고를 수 있어요"는 없음');
      seen = await press(page, d, '#resetCar', false);
      ok(seen[0].msg.includes('직접 넣어야') && seen[0].msg.includes('(탑승 차량)'), '[마감 뒤·탑승 차량] 직접 넣어야 한다는 문장');
      seen = await press(page, d, '#resetTeam', false);
      ok(!seen[0].msg.includes('직접 넣어야') && seen[0].msg.includes('팀은 마감과 상관없이'), '[마감 뒤·팀] 팀은 마감 문장 없이 "마감과 상관없이 다시 정할 수 있어요"');
      const notes = await page.evaluate(([a, b]) => ({
        after: resetNote(['menu'], Date.parse(a)), before: resetNote(['menu'], Date.parse(b)),
        edge: resetNote(['lunch'], CHOICE_DEADLINE), edgeBefore: resetNote(['lunch'], CHOICE_DEADLINE - 1), room: resetNote(['room'], Date.parse(a)),
      }), [AFTER, BEFORE]);
      ok(/직접 넣어야/.test(notes.after[0]) && /전까지 참가자가 다시/.test(notes.before[0]), '[단위] resetNote: 마감 뒤/전 문장이 다름');
      ok(/직접 넣어야/.test(notes.edge[0]) && /전까지/.test(notes.edgeBefore[0]), '[단위] resetNote: 마감 시각 정각부터 마감 뒤 문장(common.js 의 CHOICE_DEADLINE 기준)');
      eq(notes.room, ['방은 마감과 상관없이 발표용 뽑기 화면이나 이 화면에서 다시 정할 수 있어요.'], '[단위] resetNote: 방은 마감 문장 없음');
      // 마감 뒤에 실제로 지우면 끝 문구에도 알림
      seen = await press(page, d, '#resetLunch', true);
      ok(/점심 초기화를 마쳤어요\(점심 비움\)\. 마감이 지나 참가자가 다시 고를 수 없으니 진행자가 직접 넣어 주세요\./.test(await page.locator('#resetMsg').innerText()), '[마감 뒤·점심] 끝 문구에 직접 넣어 달라는 말');
      await page.close();
    }

    // ── 4. 초기화 뒤 참가자 화면이 "아직 안 골랐어요/안 뽑았어요"로 돌아감 ──
    await fill(db);
    {
      const me = roster()[0]; // 견본가(id 1): 팀·방·아침·점심·자유시간·차량이 모두 있음
      const pctx = await env.browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ko-KR' });
      const pguard = await guardNetwork(pctx, server.url);
      const login = async () => {
        const idx = await pctx.newPage();
        idx.on('pageerror', (e) => errors.push(e.message));
        await idx.goto(`${server.url}/index.html`);
        if (await idx.locator('#goMenu').isHidden()) {
          await idx.locator('#dept option', { hasText: me.dept }).waitFor({ state: 'attached', timeout: 10000 });
          await idx.locator('#dept').selectOption({ label: me.dept });
          await idx.locator('#name').fill(me.name);
          await idx.locator('#loginBtn').click();
        }
        await idx.locator('#goMenu').waitFor({ state: 'visible', timeout: 10000 });
        await idx.waitForFunction(() => document.querySelector('#stCar').textContent.trim() !== '' || document.querySelector('#goCar').hidden, null, { timeout: 10000 });
        return idx;
      };
      const st = (idx) => idx.evaluate(() => Object.fromEntries(['Menu', 'Lunch', 'Act', 'Car'].map((k) => [k, document.querySelector(`#st${k}`).textContent.replace(/\s+/g, ' ').trim()])));
      let idx = await login();
      const was = await st(idx);
      ok(!/아직 안/.test(Object.values(was).join('|')), `[참가자·전] 모두 고른 상태: ${JSON.stringify(was)}`);
      await idx.close();

      const { page, d } = await openBoard(BEFORE);
      await press(page, d, '#resetEvery', true);
      await page.close();

      idx = await login();
      const now = await st(idx);
      const closed = Date.now() >= Date.parse('2026-11-25T15:00:00+09:00'); // 서버(choices_closed)는 실제 시계를 씀
      if (!closed) {
        ok(/아직 안 골랐어요/.test(now.Menu) && /아직 안 골랐어요/.test(now.Lunch) && /아직 안 골랐어요/.test(now.Act), `[참가자·후] 아침·점심·자유시간 "아직 안 골랐어요": ${JSON.stringify(now)}`);
        ok(/아직 안 뽑았어요/.test(now.Car), `[참가자·후] 탑승 차량 "아직 안 뽑았어요": ${now.Car}`);
      } else {
        ok(/마감됐어요/.test(now.Menu + now.Lunch + now.Act + now.Car), `[참가자·후] (실제 시계가 마감 뒤) 마감 안내: ${JSON.stringify(now)}`);
      }
      const me2 = await idx.evaluate(async (m) => (await db.rpc('login', { p_dept: m.dept, p_name: m.name })).data, me);
      eq([me2.team ?? null, me2.room ?? null, me2.menu ?? null, me2.lunch ?? null, me2.activity ?? null], [null, null, null, null, null], '[참가자·후] login() 응답의 팀·방·아침·점심·자유시간이 비어 있음(방·팀 단추는 참가자 메인에서 숨김이라 응답으로 확인)');
      await idx.close();
      pguard.assertClean();
      await pctx.close();
    }

    // ── 5. 중간 실패 → 무엇이 비워졌고 남았는지 알림 → 다시 누르면 이어서 ──
    await fill(db);
    {
      const snap = await rows(db);
      const { page, d } = await openBoard(BEFORE);
      let failed = 0;
      await page.route('**/rest/v1/rpc/admin_clear', async (route) => {
        const body = route.request().postDataJSON();
        if (body && body.p_what === 'lunch' && failed === 0) {
          failed++;
          return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '시험용 실패', code: 'P0001', details: null, hint: null }) });
        }
        return route.fallback(); // 나머지는 context 의 대리(로컬 서버)로
      });
      await press(page, d, '#resetEvery', true);
      const msg = await page.locator('#resetMsg').innerText();
      ok(msg.includes('전체 초기화가 중간에 멈췄어요. 비운 것: 팀·방·아침 메뉴 / 아직 남은 것: 점심·자유시간·탑승 차량·점수. 다시 누르면 이어서 지워요'), `[중간 실패] 비운 것·남은 것 알림: ${msg}`);
      ok(msg.includes('시험용 실패'), '[중간 실패] 이유도 보임');
      ok((await page.locator('#error').innerText()).includes('중간에 멈췄어요'), '[중간 실패] 화면 위 오류 줄에도 보임');
      const mid = await rows(db);
      const left = ITEMS.map((k) => (['lunch', 'activity', 'car'].includes(k) ? filled(snap, ITEM_COLS[k]) : 0));
      eq(ITEMS.map((k) => filled(mid, ITEM_COLS[k])), left, '[중간 실패] DB: 팀·방·아침은 비고 점심·자유시간·차량은 남음');
      eq(await scoresOf(db), SCORES, '[중간 실패] 점수는 아직 못 비운 단계라 그대로');
      const seen = await press(page, d, '#resetEvery', true);
      ok(seen[0].msg.startsWith(`전체 초기화: ${ITEMS.map((k, i) => `${LABEL[k]} ${left[i]}명`).join(' · ')} · 점수 ${NONZERO}팀의`), `[다시 누름] 확인 문구에 남은 것만 인원이 있고 점수는 아직 ${NONZERO}팀: ${seen[0].msg.split('\n')[0]}`);
      const after = await rows(db);
      eq(ITEMS.map((k) => filled(after, ITEM_COLS[k])), [0, 0, 0, 0, 0, 0], '[다시 누름] 이미 빈 것은 오류 없이 지나가고 나머지도 모두 비움');
      eq(diff(snap, after, ALL_COLS), [], '[다시 누름] 명단 그대로');
      eq(await scoresOf(db), { red: 0, blue: 0, yellow: 0, green: 0 }, '[다시 누름] 점수도 0');
      ok(/전체 초기화를 마쳤어요/.test(await page.locator('#resetMsg').innerText()), '[다시 누름] 끝 문구');
      // 항목 하나짜리가 실패하면 "하지 못했어요"
      await fill(db);
      await page.unroute('**/rest/v1/rpc/admin_clear');
      await page.route('**/rest/v1/rpc/admin_clear_cars', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '시험용 실패', code: 'P0001', details: null, hint: null }) }));
      await press(page, d, '#resetCar', true);
      ok(/탑승 차량 초기화를 하지 못했어요/.test(await page.locator('#resetMsg').innerText()), '[항목 실패] "하지 못했어요" 알림');
      eq(filled(await rows(db), ITEM_COLS.car), 5, '[항목 실패] 차량 그대로');
      await page.unroute('**/rest/v1/rpc/admin_clear_cars');
      await press(page, d, '#resetCar', true);
      eq(filled(await rows(db), ITEM_COLS.car), 0, '[항목 실패 뒤 다시] 차량 비움');
      // 점수 단계만 실패: 전체 초기화가 "비운 것 … / 아직 남은 것: 점수"로 알리고, 점수는 그대로, 다시 누르면 점수만 이어서 비움
      await fill(db);
      await page.route('**/rest/v1/rpc/admin_clear', async (route) => {
        const body = route.request().postDataJSON();
        if (body && body.p_what === 'score') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '시험용 점수 실패', code: 'P0001', details: null, hint: null }) });
        return route.fallback();
      });
      await press(page, d, '#resetEvery', true);
      const m2 = await page.locator('#resetMsg').innerText();
      ok(m2.includes('비운 것: 팀·방·아침 메뉴·점심·자유시간·탑승 차량 / 아직 남은 것: 점수') && m2.includes('시험용 점수 실패'), `[점수 단계 실패] 비운 것·남은 것(점수) 알림: ${m2}`);
      eq(await scoresOf(db), SCORES, '[점수 단계 실패] 점수 그대로');
      const mid2 = await rows(db);
      eq(ITEMS.map((k) => filled(mid2, ITEM_COLS[k])), [0, 0, 0, 0, 0, 0], '[점수 단계 실패] 사람 칸 여섯 항목은 이미 비워짐');
      await page.unroute('**/rest/v1/rpc/admin_clear');
      const seen2 = await press(page, d, '#resetEvery', true);
      ok(seen2[0].msg.startsWith(`전체 초기화: ${ITEMS.map((k) => `${LABEL[k]} 0명`).join(' · ')} · 점수 ${NONZERO}팀의`), `[점수 단계 실패 뒤 다시] 점수만 남은 확인 문구: ${seen2[0].msg.split('\n')[0]}`);
      eq(await scoresOf(db), { red: 0, blue: 0, yellow: 0, green: 0 }, '[점수 단계 실패 뒤 다시] 점수 비움');
      await page.close();
    }

    // ── 6. 점수 함수가 없는 예전 DB(score_state 404): 점수 초기화는 안내만 하고, 전체 초기화는 점수 단계를 그냥 지나감 ──
    await fill(db);
    {
      server.missing.add('score_state');
      try {
        const { page, d } = await openBoard(BEFORE);
        await page.waitForTimeout(600);
        const c0 = server.calls.length;
        await press(page, d, '#resetScore', true);
        const m = await page.locator('#resetMsg').innerText();
        ok(/점수 초기화를 하지 못했어요/.test(m) && /DB가 아직 새 버전이 아니라 점수를 비우지 못했어요/.test(m), `[예전 DB] 점수 초기화는 새 버전이 아니라는 안내: ${m}`);
        eq(fnCalls(c0).filter((c) => c.args.p_what === 'score').length, 0, '[예전 DB] admin_clear(score) 를 부르지 않음');
        eq(await scoresOf(db), SCORES, '[예전 DB] 점수 그대로');
        const c1 = server.calls.length;
        const seen = await press(page, d, '#resetEvery', true);
        ok(/점수\(확인 못 함\)/.test(seen[0].msg), `[예전 DB] 전체 초기화 확인 문구: ${seen[0].msg.split('\n')[0]}`);
        eq(fnCalls(c1).map((c) => c.fn + (c.args.p_what ? `(${c.args.p_what})` : '')), ['admin_reset_all', 'admin_clear(room)', 'admin_clear(lunch)', 'admin_clear(activity)', 'admin_clear_cars'], '[예전 DB] 전체 초기화는 점수 단계를 지나가고 나머지 다섯 단계만 부름');
        { const m = await page.locator('#resetMsg').innerText(); ok(/^전체 초기화를 마쳤어요\(팀·방·아침 메뉴·점심·자유시간·탑승 차량 비움 · 점수 단계는 DB가 아직 새 버전이 아니라 건너뜀\)/.test(m) && !/점수 비움/.test(m), `[예전 DB] 전체 초기화가 오류 없이 끝나고, 점수는 비웠다고 하지 않고 건너뛰었다고 사실대로 알림: ${m}`); }
        eq(await scoresOf(db), SCORES, '[예전 DB] 점수는 건드리지 않음(비울 함수가 없음)');
        await page.close();
      } finally { server.missing.delete('score_state'); }
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
