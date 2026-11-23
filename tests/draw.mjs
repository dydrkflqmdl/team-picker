// 발표용 뽑기 화면(draw.html) 통합 시험.  실행: cd tests && node run.mjs draw [시나리오 번호 ...]   (예: node run.mjs draw 1 5)
//   npm run test:draw  도 같음.  캡처 폴더: 환경변수 DRAW_SHOTS (기본 tests/.out/draw-shots)
// 운영 DB 에는 닿지 않는다: 모든 browser context 에 guardNetwork 를 걸고, 시나리오 끝마다 막힌 외부 요청이 0건인지 확인한다.
// 각 시나리오는 끝난 뒤 로컬 postgres 를 직접 조회해(pg) 결과를 검증한다.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_CODE, connect } from './db.mjs';
import { resetRoster } from './seed.mjs';
import { startServer } from './server.mjs';
import { guardNetwork, launchBrowser } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.DRAW_SHOTS || join(HERE, '.out', 'draw-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEAM_ORDER = ['red', 'blue', 'yellow', 'green'];
const TEAM_KO = { red: '빨강', blue: '파랑', yellow: '노랑', green: '초록' };
const ROOM_ORDER = ['m1', 'm2', 'm3', 'm4', 'm5', 'f1', 'f2'];

export async function drawTests(only = []) {
  mkdirSync(SHOTS, { recursive: true });
  const db = await connect();
  const server = await startServer({ port: 0 });
  const browser = await launchBrowser();
  const results = [];
  const layoutFindings = [];
  const shotFiles = [];
  let cur = null; // 지금 돌고 있는 시나리오(context 정리·가드 확인용)

  // ── 도우미 ──────────────────────────────────────────
  const rows = async () => (await db.query('select * from people order by id')).rows.map((r) => ({ ...r, id: Number(r.id) })); // bigint 는 문자열로 와서 숫자로
  const calls = (fn) => server.calls.filter((c) => c.fn === fn);
  const resetCalls = () => { server.calls.length = 0; };
  const counts = (rs, col, keys) => Object.fromEntries(keys.map((k) => [k, rs.filter((r) => r[col] === k).length]));
  const spread = (c) => { const v = Object.values(c); return Math.max(...v) - Math.min(...v); };
  const mapOf = (rs, col) => { const m = {}; for (const r of rs) if (r[col]) (m[r[col]] ||= []).push(r.name); for (const k in m) m[k].sort(); return Object.fromEntries(Object.entries(m).sort()); };
  const diffRows = (a, b, { ignore = [], ids } = {}) => { // 두 시점 사이 달라진 칸 목록
    const out = [];
    const bm = new Map(b.map((r) => [r.id, r]));
    for (const r of a) {
      if (ids && !ids.includes(r.id)) continue;
      const n = bm.get(r.id);
      if (!n) { out.push(`id ${r.id} 사라짐`); continue; }
      for (const k of Object.keys(r)) if (!ignore.includes(k) && JSON.stringify(r[k]) !== JSON.stringify(n[k])) out.push(`id ${r.id}(${r.name}).${k}: ${JSON.stringify(r[k])} → ${JSON.stringify(n[k])}`);
    }
    return out;
  };

  async function scenario(num, name, fn) {
    if (only.length && !only.includes(String(num))) return;
    const t0 = Date.now();
    const s = { num, name, checks: 0, fails: [], notes: [], guards: [], errors: [], ctxs: [] };
    s.ok = (c, msg) => { s.checks++; if (!c) s.fails.push(msg); return !!c; };
    s.eq = (a, b, msg) => s.ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: 실제 ${JSON.stringify(a)} / 기대 ${JSON.stringify(b)}`);
    s.note = (m) => s.notes.push(m);
    cur = s;
    process.stdout.write(`[${num}] ${name} ... `);
    try { await fn(s); } catch (e) { s.fails.push('예외: ' + String(e.stack || e).split('\n').slice(0, 5).join(' | ')); }
    for (const g of s.guards) s.ok(g.blocked.length === 0, `허용 안 된 외부 요청: ${g.blocked.join(', ')}`); // 운영 DB 등 외부 접근 0건
    s.ok(s.errors.length === 0, `페이지 오류(pageerror): ${s.errors.join(' | ')}`);
    for (const c of s.ctxs) await c.close().catch(() => {});
    const ok = s.fails.length === 0;
    results.push({ num, name, ok, checks: s.checks, fails: s.fails, notes: s.notes, ms: Date.now() - t0 });
    console.log(`${ok ? '통과' : '실패'} (${s.checks}개 확인, ${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    for (const f of s.fails) console.log('    ✗ ' + f);
    for (const n of s.notes) console.log('    · ' + n);
    cur = null;
  }

  /** 새 context(+가드). code:true 면 관리자 비밀번호를 localStorage 에 미리 넣어 둔다(board.html 에 들어간 적이 있는 기기 흉내). */
  async function newCtx(o = {}) {
    const { code, trace, ...rest } = o;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ko-KR', ...rest });
    const g = await guardNetwork(ctx, server.url);
    cur.guards.push(g);
    cur.ctxs.push(ctx);
    ctx.on('page', (p) => p.on('pageerror', (e) => cur.errors.push(e.message)));
    if (code) await ctx.addInitScript((c) => { try { localStorage.setItem('team-picker-admin', JSON.stringify(c)); } catch {} }, ADMIN_CODE);
    if (trace) await ctx.addInitScript(() => { // groupIndex 가 바뀐 순서를 4ms 마다 기록(팀 건너뛰기·되돌아감 확인)
      window.__trace = []; let last = null;
      setInterval(() => { const d = window.__draw; if (!d) return; const k = `${d.view}|${d.groupIndex}`; if (k !== last) { last = k; window.__trace.push({ v: d.view, g: d.groupIndex, ph: d.phase }); } }, 4);
    });
    const page = await ctx.newPage();
    return { ctx, page, guard: g };
  }
  const st = (page) => page.evaluate(() => { const d = window.__draw; return d ? JSON.parse(JSON.stringify(d)) : null; });
  const wait = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout, polling: 30 });
  const waitView = (page, v, t) => wait(page, (x) => window.__draw && window.__draw.view === x && !window.__draw.busy, v, t);
  const waitReady = (page, t) => wait(page, () => { const d = window.__draw; return d && !d.busy && d.phase === 'ready'; }, null, t);
  const waitFinale = (page, t) => wait(page, () => { const d = window.__draw; return d && d.view === 'finale' && !d.busy; }, null, t);
  const waitErr = (page, t) => wait(page, () => { const d = window.__draw; return d && d.phase === 'error' && !d.busy; }, null, t);
  const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
  const text = async (page, id) => (await tid(page, id).innerText()).replace(/\s+/g, ' ').trim();
  const visible = (page, id) => tid(page, id).isVisible();

  async function openLive(page, query = '') { await page.goto(`${server.url}/draw.html${query}`); await waitView(page, 'menu'); }
  async function chooseKind(page, kind) { await page.keyboard.press(kind === 'team' ? 'Digit1' : 'Digit2'); await waitView(page, 'intro'); }
  async function startBtn(page) { // 시작 화면의 주 단추(시작하기/그대로 두고…/결과 보기 등)
    const b = page.locator('#introActs .primary').first();
    await b.click();
    await waitView(page, 'play');
  }
  /** 끝(마지막 장면)까지 한 키로 한 번씩 누름. 눌린 횟수와 마다 공개된 팀(방)을 돌려줌 */
  async function playAll(page, { key = 'Space', max = 80 } = {}) {
    let presses = 0; const seq = []; const revealed = [];
    for (;;) {
      await wait(page, () => { const d = window.__draw; return d && !d.busy && (d.view === 'finale' || d.phase === 'ready' || d.phase === 'error'); });
      const d = await st(page);
      if (d.view === 'finale') return { presses, seq, revealed, d };
      if (d.phase === 'error') throw new Error(`진행 중 오류 상태: ${d.error}`);
      if (d.last && d.last.group) { seq.push(d.last.group); revealed.push(d.revealed); }
      if (presses >= max) throw new Error('너무 많이 눌러도 안 끝남');
      await page.keyboard.press(key); presses++;
    }
  }
  const finaleMap = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="draw-finale-board"] section[data-testid^="draw-group-"]')]
    .map((sec) => [sec.dataset.testid.replace('draw-group-', ''), [...sec.querySelectorAll('li .nm')].map((x) => x.textContent).sort()]).filter(([, v]) => v.length).sort()));

  // ══ 1. 처음부터 끝까지(팀) ═══════════════════════════
  await scenario(1, '처음부터 끝까지(팀, 빈 명단, 한 팀씩)', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    await openLive(page);
    s.eq((await st(page)).mode, 'live', '모드');
    await chooseKind(page, 'team');
    s.ok(/전체 29명/.test(await text(page, 'draw-intro-summary')) && /아직 아무도/.test(await text(page, 'draw-intro-summary')), `시작 화면 요약: ${await text(page, 'draw-intro-summary')}`);
    s.ok(await visible(page, 'draw-start'), '시작하기 단추');
    s.eq((await rows()).filter((r) => r.team).length, 0, '시작 전 DB 팀 수');
    await startBtn(page);
    const { presses, seq, revealed, d } = await playAll(page);
    s.eq(presses, 5, '누른 횟수(팀 4 + 1)');
    s.eq(seq, TEAM_ORDER, '공개 순서');
    const rs = await rows();
    const c = counts(rs, 'team', TEAM_ORDER);
    s.eq(rs.filter((r) => r.team).length, 29, 'DB 팀이 정해진 사람');
    s.ok(spread(c) <= 1, `팀 인원 차이 ≤1: ${JSON.stringify(c)}`);
    s.eq(Object.values(c).sort(), [7, 7, 7, 8], '인원 분포(7·7·7·8)');
    let cum = 0; const exp = TEAM_ORDER.map((k) => (cum += c[k]));
    s.eq(revealed, exp, '공개 때마다 결과판 누적 인원');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '마지막 장면 이름 = DB 결과');
    s.eq(d.calls.pick, 29, '화면이 보낸 pick 수');
    s.eq(calls('pick').length, 29, '서버가 받은 pick 수');
    s.eq(new Set(calls('pick').map((x) => x.args.p_name)).size, 29, 'pick 받은 사람 수(중복 없음)');
    s.eq(calls('pick_room').length + calls('admin_reset').length + calls('admin_clear').length, 0, '다른 쓰기 요청');
    s.ok(await visible(page, 'draw-next-kind'), '② 방 배정 뽑기로 → 단추');
    s.note(`분포 ${JSON.stringify(c)}`);
  });

  // ══ 2. 처음부터 끝까지(방) ═══════════════════════════
  await scenario(2, '처음부터 끝까지(방) + 성별 없는 사람', async (s) => {
    // 2-a 성별 모두 있음
    await resetRoster(db); resetCalls();
    let { page } = await newCtx({ code: true });
    await openLive(page); await chooseKind(page, 'room');
    s.ok(!(await visible(page, 'draw-nogender')), '성별 없는 사람이 없으면 안내 안 보임');
    await startBtn(page);
    let r = await playAll(page);
    s.eq(r.presses, 8, '누른 횟수(방 7 + 1)');
    s.eq(r.seq, ROOM_ORDER, '공개 순서(남 1~5, 여 1~2)');
    let rs = await rows();
    s.eq(rs.filter((x) => x.room).length, 29, 'DB 방 배정 수');
    s.eq(rs.filter((x) => x.room && x.room[0] !== (x.gender === '남' ? 'm' : 'f')).length, 0, '성별 섞인 방');
    const men = counts(rs, 'room', ['m1', 'm2', 'm3', 'm4', 'm5']); const women = counts(rs, 'room', ['f1', 'f2']);
    s.ok(spread(men) <= 1 && spread(women) <= 1, `성별 안 방 인원 차이 ≤1: 남 ${JSON.stringify(men)} 여 ${JSON.stringify(women)}`);
    s.eq(Object.values(men).reduce((a, b) => a + b, 0), 20, '남자 방 합');
    s.eq(Object.values(women).reduce((a, b) => a + b, 0), 9, '여자 방 합');
    s.eq(await finaleMap(page), mapOf(rs, 'room'), '마지막 장면 이름 = DB 결과');
    s.eq(calls('pick_room').length, 29, 'pick_room 수');
    s.note(`남 ${JSON.stringify(men)} 여 ${JSON.stringify(women)}`);
    // 2-b 성별 없는 1명
    await resetRoster(db, { noGender: true }); resetCalls();
    ({ page } = await newCtx({ code: true }));
    await openLive(page); await chooseKind(page, 'room');
    const ng = await text(page, 'draw-nogender');
    s.ok(await visible(page, 'draw-nogender') && /1명/.test(ng) && /견본고/.test(ng), `성별 없는 사람 안내: ${ng}`);
    s.ok(/방을 뽑을 수 있는 사람 28명/.test(await text(page, 'draw-intro-summary')), `요약: ${await text(page, 'draw-intro-summary')}`);
    await startBtn(page);
    r = await playAll(page);
    s.eq(r.presses, 8, '누른 횟수(성별 없는 사람 건너뜀)');
    rs = await rows();
    s.eq(rs.filter((x) => x.room).length, 28, '방 배정 수(28)');
    s.eq(rs.find((x) => x.name === '견본고').room, null, '성별 없는 사람 방 그대로 없음');
    s.eq(calls('pick_room').length, 28, 'pick_room 수(성별 없는 사람 요청 안 함)');
    s.ok(/성별이 없어 못 뽑은 사람 1명/.test(await text(page, 'draw-finale-note')), '마지막 장면 안내');
    const men2 = counts(rs, 'room', ['m1', 'm2', 'm3', 'm4', 'm5']);
    s.ok(spread(men2) <= 1, `남자 방 차이 ≤1 (19명): ${JSON.stringify(men2)}`);
  });

  // ══ 3. 중간 새로 고침 ═════════════════════════════════
  await scenario(3, '중간 새로 고침(저장 도중 / 공개 도중 / 다른 브라우저)', async (s) => {
    // 3-a 저장 도중
    await resetRoster(db); resetCalls();
    const a = await newCtx({ code: true });
    await a.page.route(/\/rpc\/pick$/, async (r) => { await sleep(120); r.fallback(); }); // 저장이 천천히 되게(중간에 끊기 쉽게)
    await openLive(a.page); await chooseKind(a.page, 'team');
    await a.page.locator('#introActs .primary').first().click(); await waitView(a.page, 'play');
    await a.page.keyboard.press('Space'); // 뽑기 시작(저장 시작)
    for (let i = 0; i < 400; i++) { const n = (await rows()).filter((r) => r.team).length; if (n >= 9) break; await sleep(25); }
    await a.page.reload();
    await sleep(700); // 끊긴 요청이 서버에서 끝나길 기다림
    const snap = await rows();
    const n1 = snap.filter((r) => r.team).length;
    s.ok(n1 >= 9 && n1 < 29, `저장 도중에 끊김(저장된 ${n1}명)`);
    await waitView(a.page, 'menu');
    s.ok(/뽑음 \d+ \/ 29명/.test(await text(a.page, 'draw-menu-team-status')), `첫 화면 상태: ${await text(a.page, 'draw-menu-team-status')}`);
    await chooseKind(a.page, 'team');
    s.ok(new RegExp(`이미\\s*${n1}명`).test(await text(a.page, 'draw-intro-summary')), `시작 화면 '이미 ${n1}명': ${await text(a.page, 'draw-intro-summary')}`);
    s.ok(new RegExp(`남은 ${29 - n1}명만`).test(await text(a.page, 'draw-keep')), `그대로 두고 단추: ${await text(a.page, 'draw-keep')}`);
    await tid(a.page, 'draw-keep').click(); await waitView(a.page, 'play');
    const r = await playAll(a.page);
    const rs = await rows();
    s.eq(diffRows(snap.filter((x) => x.team), rs, { ids: snap.filter((x) => x.team).map((x) => x.id) }), [], '이미 저장된 사람 결과 불변');
    s.eq(rs.filter((x) => x.team).length, 29, '최종 29명 모두 팀');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `최종 팀 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(r.d.calls.pick, 29 - n1, '이어서 한 pick 수(남은 사람만)');
    s.eq(r.presses, 5, '이어서 누른 횟수');
    s.eq(await finaleMap(a.page), mapOf(rs, 'team'), '마지막 장면 = DB');
    s.note(`저장 ${n1}명에서 끊김 → 남은 ${29 - n1}명만 이어서`);

    // 3-b 공개 도중
    await resetRoster(db); resetCalls();
    const b = await newCtx({ code: true });
    await openLive(b.page); await chooseKind(b.page, 'team'); await startBtn(b.page);
    await waitReady(b.page);
    await b.page.keyboard.press('Space'); await wait(b.page, () => window.__draw.last && window.__draw.last.group === 'red' && !window.__draw.busy); // 저장 + 첫 팀(빨강)
    await b.page.keyboard.press('Space'); await wait(b.page, () => window.__draw.last && window.__draw.last.group === 'blue' && !window.__draw.busy); // 2번째 팀(파랑)까지 공개
    let d = await st(b.page);
    s.eq(d.last.group, 'blue', '2번째 공개 팀');
    s.eq(d.savedRevealIndex, 1, '기억된 공개 위치');
    const ls = await b.page.evaluate(() => JSON.parse(localStorage.getItem('draw-reveal-team')));
    s.eq(ls && ls.idx, 1, 'localStorage draw-reveal-team.idx');
    const before = await rows();
    await b.page.reload(); await waitView(b.page, 'menu');
    await chooseKind(b.page, 'team');
    s.ok(await visible(b.page, 'draw-resume'), '이어서 공개 단추');
    s.ok(/노랑/.test(await text(b.page, 'draw-resume')), `이어서 공개 단추 글: ${await text(b.page, 'draw-resume')}`);
    s.ok(await visible(b.page, 'draw-reveal-again') && await visible(b.page, 'draw-to-finale'), '처음부터 다시·마지막 장면 단추');
    s.eq(diffRows(before, await rows()), [], '새로 고침으로 DB 불변');
    await tid(b.page, 'draw-resume').click(); await waitView(b.page, 'play');
    d = await st(b.page);
    const cT = counts(before, 'team', TEAM_ORDER);
    s.eq(d.revealed, cT.red + cT.blue, '이어서 시작할 때 결과판(빨강+파랑)');
    s.eq(d.groupIndex, 1, '이어서 공개 위치');
    await b.page.keyboard.press('Space'); await waitReady(b.page);
    s.eq(await text(b.page, 'draw-group-title'), '노랑 팀', '다음에 공개된 팀');
    const r2 = await playAll(b.page);
    s.eq(r2.presses, 2, '남은 팀(초록) + 마지막 장면');
    s.eq(r2.d.calls.pick, 0, '이어서 공개는 pick 요청 없음');
    // 마지막 장면까지 간 뒤 새로 고침 → 이어서 공개가 아니라 처음부터
    await b.page.reload(); await waitView(b.page, 'menu'); await chooseKind(b.page, 'team');
    s.ok(!(await visible(b.page, 'draw-resume')) && await visible(b.page, 'draw-show-result'), '끝까지 본 뒤에는 이어서 공개 대신 처음부터 공개');
    s.ok(/빨강/.test(await text(b.page, 'draw-show-result')), `단추 글: ${await text(b.page, 'draw-show-result')}`);

    // 3-c 다른 브라우저(기억 없음) → 첫 팀부터
    const c = await newCtx({ code: true });
    await openLive(c.page); await chooseKind(c.page, 'team');
    s.ok(!(await visible(c.page, 'draw-resume')) && await visible(c.page, 'draw-show-result'), '다른 브라우저는 이어서 공개 없음, 첫 팀부터');
    await tid(c.page, 'draw-show-result').click(); await waitView(c.page, 'play');
    s.eq((await st(c.page)).revealed, 0, '처음부터 공개: 결과판 비어 있음');
    const r3 = await playAll(c.page);
    s.eq(r3.presses, 5, '처음부터 공개 누른 횟수');
    s.eq(r3.d.calls.pick, 0, '재공개는 pick 요청 없음');
  });

  // ══ 4. 연타 ══════════════════════════════════════════
  // 키를 쉬지 않고 눌러 대고(스페이스·Enter·→·PageDown·단추 번갈아), 같은 사람에게 중복 요청이 가는지·팀을 건너뛰는지 본다
  async function mash(page, { until, maxMs = 90000, extra = 0 }) {
    const keys = ['Space', 'Enter', 'ArrowRight', 'PageDown'];
    const t0 = Date.now(); let n = 0;
    while (Date.now() - t0 < maxMs) {
      if (n % 5 === 4) await page.evaluate(() => document.querySelector('[data-testid="draw-next"]').click()); // DOM 클릭(좌표 클릭은 4.6 에서 따로)
      else await page.keyboard.press(keys[n % 4]);
      n++;
      if (n % 20 === 0 && await page.evaluate(until)) break;
      if (process.env.DRAW_DEBUG && n % 1500 === 0) console.log('   mash', n, Date.now() - t0, JSON.stringify(await st(page)).slice(0, 200));
    }
    for (let i = 0; i < extra; i++) await page.keyboard.press(keys[i % 4]);
    return n;
  }
  const traceOf = (page) => page.evaluate(() => window.__trace);
  const dedup = (a) => a.filter((x, i) => i === 0 || x !== a[i - 1]);

  await scenario(4, '연타(키·단추 수십 번, 모두 공개 연타)', async (s) => {
    // 4-a 팀, 한 팀씩
    await resetRoster(db); resetCalls();
    let { page } = await newCtx({ code: true, trace: true });
    await openLive(page); await chooseKind(page, 'team'); await startBtn(page);
    let n = await mash(page, { until: () => window.__draw.view === 'finale', extra: 30 });
    await waitFinale(page);
    let tr = await traceOf(page);
    const gseq = dedup(tr.filter((t) => t.v === 'play' || t.v === 'finale').map((t) => t.g));
    s.eq(gseq, [-1, 0, 1, 2, 3], `팀 공개 순서(건너뜀·되돌아감 없음, 연타 ${n}번)`);
    let rs = await rows();
    s.eq(rs.filter((r) => r.team).length, 29, '[팀] DB 전원 팀');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[팀] 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(calls('pick').length, 29, '[팀] 서버가 받은 pick 수');
    s.eq(new Set(calls('pick').map((x) => x.args.p_name)).size, 29, '[팀] 같은 사람에게 중복 pick 없음');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[팀] 마지막 장면 = DB');
    s.eq((await st(page)).view, 'finale', '[팀] 마지막 장면에서 연타해도 머무름');

    // 4-b 방, 한 방씩 (성별 없는 사람 포함)
    await resetRoster(db, { noGender: true }); resetCalls();
    ({ page } = await newCtx({ code: true, trace: true }));
    await openLive(page); await chooseKind(page, 'room'); await startBtn(page);
    n = await mash(page, { until: () => window.__draw.view === 'finale', extra: 30 });
    await waitFinale(page);
    tr = await traceOf(page);
    s.eq(dedup(tr.filter((t) => t.v === 'play' || t.v === 'finale').map((t) => t.g)), [-1, 0, 1, 2, 3, 4, 5, 6], `방 공개 순서(연타 ${n}번)`);
    rs = await rows();
    s.eq(rs.filter((r) => r.room).length, 28, '[방] DB 28명');
    s.eq(rs.filter((r) => r.room && r.room[0] !== (r.gender === '남' ? 'm' : 'f')).length, 0, '[방] 성별 섞임');
    s.eq(calls('pick_room').length, 28, '[방] pick_room 수');
    s.eq(new Set(calls('pick_room').map((x) => x.args.p_name)).size, 28, '[방] 중복 요청 없음');

    // 4-c 한 팀씩에서 '남은 팀 모두 공개' 연타 + 확인 상자 연타
    await resetRoster(db); resetCalls();
    ({ page } = await newCtx({ code: true }));
    await openLive(page); await chooseKind(page, 'team'); await startBtn(page);
    await page.keyboard.press('Space'); await waitReady(page); // 저장 + 첫 팀 공개
    s.ok(/남은 팀 모두 공개/.test(await text(page, 'draw-all')), `단추 글: ${await text(page, 'draw-all')}`);
    await page.evaluate(() => { for (let i = 0; i < 15; i++) document.querySelector('[data-testid="draw-all"]').click(); }); // 한 틱에 15번
    await wait(page, () => window.__draw.dialog === 'all');
    for (let i = 0; i < 20; i++) { await page.keyboard.press('ArrowRight'); await page.keyboard.press('PageDown'); } // 상자가 열린 동안 진행 키(리모컨 키)는 무시
    s.eq((await st(page)).dialog, 'all', '상자가 열린 동안 →·PageDown 으로 진행되지 않음');
    s.eq((await st(page)).groupIndex, 0, '상자가 열린 동안 팀이 넘어가지 않음');
    await sleep(600); // 상자가 열린 직후 0.5초는 키보드식 클릭(detail 0)을 무시함
    await page.evaluate(() => { for (let i = 0; i < 15; i++) document.querySelector('[data-testid="draw-dialog-ok"]').click(); });
    for (let i = 0; i < 25; i++) await page.keyboard.press('Space');
    await waitFinale(page);
    rs = await rows();
    s.eq(rs.filter((r) => r.team).length, 29, '[모두 공개 연타] DB 전원 팀');
    s.eq(calls('pick').length, 29, '[모두 공개 연타] pick 수(저장은 첫 누름에 끝남)');
    s.eq((await st(page)).revealed, 29, '[모두 공개 연타] 공개 29명');

    // 4-d 한 명씩: 연타 + '남은 n명 모두 공개' 연타(저장·공개 중 중복 요청 없는지)
    await resetRoster(db); resetCalls();
    ({ page } = await newCtx({ code: true }));
    await openLive(page, '?unit=person'); await chooseKind(page, 'team'); await startBtn(page);
    n = await mash(page, { until: () => window.__draw.revealed >= 3, maxMs: 40000 });
    await wait(page, () => window.__draw.phase === 'ready' && !window.__draw.busy);
    let d = await st(page);
    s.ok(d.revealed >= 3, `한 명씩: 연타 ${n}번으로 공개 ${d.revealed}명`);
    s.ok(d.calls.pick <= d.revealed + 1, `한 명씩: pick ${d.calls.pick}번 ≤ 공개 ${d.revealed}+1(진행 중)`);
    s.ok(d.revealed <= n, '공개가 눌러 댄 횟수를 넘지 않음');
    await page.evaluate(() => { for (let i = 0; i < 12; i++) { document.querySelector('[data-testid="draw-all"]').click(); } });
    await wait(page, () => window.__draw.dialog === 'all');
    await sleep(600);
    await page.evaluate(() => { for (let i = 0; i < 12; i++) document.querySelector('[data-testid="draw-dialog-ok"]').click(); });
    for (let i = 0; i < 20; i++) await page.keyboard.press('Space');
    await waitFinale(page);
    rs = await rows();
    s.eq(rs.filter((r) => r.team).length, 29, '[한 명씩] DB 전원 팀');
    s.eq(calls('pick').length, 29, '[한 명씩] 서버가 받은 pick 수');
    s.eq(new Set(calls('pick').map((x) => x.args.p_name)).size, 29, '[한 명씩] 같은 사람에게 중복 pick 없음');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[한 명씩] 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[한 명씩] 마지막 장면 = DB');
  });

  // (4-e 는 4 안에서) ─ 확인 상자에서 스페이스/Enter 가 하는 일을 관찰만 한다(정상 여부는 보고에서 판단)
  await scenario(4.5, '확인 상자가 열린 상태에서 스페이스·Enter(관찰)', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    await openLive(page); await chooseKind(page, 'team'); await startBtn(page);
    await page.keyboard.press('Space'); await waitReady(page);
    await tid(page, 'draw-all').click(); await wait(page, () => window.__draw.dialog === 'all');
    const f = await page.evaluate(() => document.activeElement && document.activeElement.id);
    s.eq(f, 'dlgCancel', '상자가 열리면 초점은 취소');
    await page.keyboard.press('Space'); await page.keyboard.press('Enter'); // 열린 직후(0.5초 안)의 키
    await sleep(100);
    let d = await st(page);
    s.eq(d.dialog, 'all', '열린 직후 스페이스·Enter 는 상자를 닫지 않음');
    s.eq(d.groupIndex, 0, '열린 직후 스페이스·Enter 로 모두 공개가 확정되지 않음');
    await sleep(600);
    await page.keyboard.press('Space'); // 0.5초 뒤: 초점이 있는 '취소'를 누른 셈
    await sleep(200);
    d = await st(page);
    s.eq(d.dialog, null, '0.5초 뒤 스페이스는 초점이 있는 취소를 누름(상자 닫힘)');
    s.eq(d.groupIndex, 0, '취소 뒤에도 공개 위치 그대로(확정 안 됨)');
    s.eq(d.phase, 'ready', '취소 뒤 진행 가능 상태');
    await page.keyboard.press('Space'); await waitReady(page); // 상자가 닫힌 뒤 초점은 '다음' 단추 → 스페이스가 한 번만 눌림
    s.eq((await st(page)).groupIndex, 1, '상자를 닫은 뒤 스페이스 한 번 = 다음 팀 1개(두 칸 건너뛰지 않음)');
  });

  // 마우스로 '마지막 장면 보기'를 두 번 빠르게 누르면: 마지막 장면의 '② 방 배정 뽑기로 →' 단추가 같은 자리에 나온다(관찰)
  await scenario(4.6, '마우스 더블클릭(마지막 장면 보기 단추 자리와 마지막 장면 단추 자리)', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    await openLive(page); await chooseKind(page, 'team'); await startBtn(page);
    const toLast = async () => { // 마지막 장면 보기 단추가 나올 때까지 진행
      for (let i = 0; i < 8 && !/마지막 장면/.test(await text(page, 'draw-next')); i++) { await page.keyboard.press('Space'); await waitReady(page); }
    };
    await toLast();
    s.ok(/마지막 장면/.test(await text(page, 'draw-next')), `다음 단추 글: ${await text(page, 'draw-next')}`);
    const box = await tid(page, 'draw-next').boundingBox();
    const x = box.x + box.width / 2; const y = box.y + box.height / 2;
    const out = [];
    for (const gap of [60, 400]) {
      await page.reload(); await waitView(page, 'menu'); await chooseKind(page, 'team');
      await page.locator('#introActs .primary').first().click(); await waitView(page, 'play'); // 이어서 공개 또는 처음부터 공개
      await toLast();
      await page.mouse.click(x, y); await sleep(gap); await page.mouse.click(x, y);
      await sleep(900);
      const d = await st(page);
      out.push(`${gap}ms 간격 두 번 클릭 → view=${d.view} kind=${d.kind}`);
    }
    s.note(out.join(' / '));
  });

  // ══ 5. 이미 뽑은 사람 섞임 ═══════════════════════════
  await scenario(5, '이미 뽑은 사람 섞임(그대로 두기 / 모두 비우기, 팀·방)', async (s) => {
    // 5-a 팀: 그대로 두고
    await resetRoster(db, { picked: true }); resetCalls();
    let snap = await rows();
    let { page } = await newCtx({ code: true });
    await openLive(page); await chooseKind(page, 'team');
    const nDone = snap.filter((r) => r.team).length;
    s.eq(nDone, 12, '(준비) DB 이미 뽑은 팀');
    s.ok(new RegExp(`이미\\s*${nDone}명`).test(await text(page, 'draw-intro-summary')), `'이미 ${nDone}명' = DB: ${await text(page, 'draw-intro-summary')}`);
    s.ok(/남은 17명만/.test(await text(page, 'draw-keep')), `그대로 두고 단추: ${await text(page, 'draw-keep')}`);
    s.ok(await visible(page, 'draw-clear'), '모두 비우고 처음부터 단추');
    await tid(page, 'draw-keep').click(); await waitView(page, 'play');
    s.eq((await st(page)).revealed, 0, '한 팀씩: 이미 뽑은 사람도 공개 전에는 결과판에 안 보임');
    let r = await playAll(page);
    let rs = await rows();
    s.eq(diffRows(snap, rs, { ids: snap.filter((x) => x.team).map((x) => x.id) }), [], '[팀·그대로] 이미 뽑은 12명 모든 칸 불변');
    s.eq(diffRows(snap, rs, { ids: snap.filter((x) => !x.team).map((x) => x.id), ignore: ['team', 'picked_at'] }), [], '[팀·그대로] 나머지 사람의 다른 칸 불변');
    s.eq(rs.filter((x) => x.team).length, 29, '[팀·그대로] 최종 전원 팀');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[팀·그대로] 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(r.d.calls.pick, 17, '[팀·그대로] pick 수(남은 사람만)');
    s.eq(r.presses, 5, '[팀·그대로] 누른 횟수');
    s.eq(r.seq, TEAM_ORDER, '[팀·그대로] 공개 순서');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[팀·그대로] 마지막 장면 = DB');

    // 5-b 팀: 모두 비우기(취소 → 확인)
    await resetRoster(db, { picked: true }); resetCalls();
    snap = await rows();
    ({ page } = await newCtx({ code: true }));
    await openLive(page); await chooseKind(page, 'team');
    await tid(page, 'draw-clear').click();
    await wait(page, () => window.__draw.dialog === 'clear');
    s.ok(await visible(page, 'draw-dialog'), '확인 상자 보임');
    const dt = await text(page, 'draw-dialog-title'); const body = await page.locator('#dlgBody').innerText();
    s.ok(/팀/.test(dt) && /12명/.test(body) && /조식/.test(body), `확인 상자 글: ${dt} / ${body}`);
    for (let i = 0; i < 10; i++) { await page.keyboard.press('ArrowRight'); await page.keyboard.press('PageDown'); await page.keyboard.press('KeyF'); }
    s.eq((await st(page)).dialog, 'clear', '[팀·비우기] →·PageDown 으로는 상자가 안 닫히고 진행도 안 됨');
    await page.keyboard.press('Escape');
    await wait(page, () => window.__draw.dialog === null);
    s.eq(diffRows(snap, await rows()), [], '[팀·비우기] Esc/취소: DB 불변');
    s.eq((await st(page)).view, 'intro', '[팀·비우기] 취소하면 시작 화면 그대로');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    await tid(page, 'draw-dialog-cancel').click(); await wait(page, () => window.__draw.dialog === null);
    s.eq(diffRows(snap, await rows()), [], '[팀·비우기] 취소 단추: DB 불변');
    s.eq(calls('admin_reset').length, 0, '[팀·비우기] 취소 뒤 admin_reset 요청 없음');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    await tid(page, 'draw-dialog-ok').click(); await waitView(page, 'play');
    rs = await rows();
    s.eq(rs.filter((x) => x.team || x.picked_at).length, 0, '[팀·비우기] 팀·뽑은 시각 모두 비움');
    s.eq(diffRows(snap, rs, { ignore: ['team', 'picked_at'] }), [], '[팀·비우기] 조식·점심·방·자유시간 등 다른 칸 불변');
    s.eq(calls('admin_reset').length, 1, '[팀·비우기] admin_reset 1번');
    s.eq(calls('admin_reset')[0].args.p_id, null, '[팀·비우기] 전원 대상(p_id null)');
    s.eq(calls('admin_clear').length, 0, '[팀·비우기] admin_clear 안 부름');
    r = await playAll(page);
    rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 29, '[팀·비우기] 다시 뽑아 전원 팀');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[팀·비우기] 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(diffRows(snap, rs, { ignore: ['team', 'picked_at'] }), [], '[팀·비우기] 다시 뽑은 뒤에도 다른 칸 불변');
    s.eq(r.d.calls.pick, 29, '[팀·비우기] 다시 29명 pick');

    // 5-c 방: 그대로 두고
    await resetRoster(db, { picked: true }); resetCalls();
    snap = await rows();
    const roomDone = snap.filter((x) => x.room).length;
    ({ page } = await newCtx({ code: true }));
    await openLive(page); await chooseKind(page, 'room');
    s.ok(new RegExp(`이미\\s*${roomDone}명`).test(await text(page, 'draw-intro-summary')), `[방] '이미 ${roomDone}명' = DB: ${await text(page, 'draw-intro-summary')}`);
    await tid(page, 'draw-keep').click(); await waitView(page, 'play');
    r = await playAll(page);
    rs = await rows();
    s.eq(diffRows(snap, rs, { ids: snap.filter((x) => x.room).map((x) => x.id) }), [], '[방·그대로] 이미 방 있는 사람 모든 칸 불변');
    s.eq(diffRows(snap, rs, { ignore: ['room'] }), [], '[방·그대로] 다른 칸(팀·조식·점심·자유시간) 불변');
    s.eq(rs.filter((x) => x.room).length, 29, '[방·그대로] 최종 전원 방');
    s.eq(rs.filter((x) => x.room[0] !== (x.gender === '남' ? 'm' : 'f')).length, 0, '[방·그대로] 성별 섞임');
    s.eq(r.d.calls.pick_room, 29 - roomDone, '[방·그대로] pick_room 수');
    s.note(`[방·그대로] 미리 채운 방이 한쪽으로 치우쳐 있어 최종 인원: 남 ${JSON.stringify(counts(rs, 'room', ['m1', 'm2', 'm3', 'm4', 'm5']))} 여 ${JSON.stringify(counts(rs, 'room', ['f1', 'f2']))}`);

    // 5-d 방: 모두 비우기
    await resetRoster(db, { picked: true }); resetCalls();
    snap = await rows();
    ({ page } = await newCtx({ code: true }));
    await openLive(page); await chooseKind(page, 'room');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    await tid(page, 'draw-dialog-cancel').click(); await wait(page, () => window.__draw.dialog === null);
    s.eq(diffRows(snap, await rows()), [], '[방·비우기] 취소: DB 불변');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    await tid(page, 'draw-dialog-ok').click(); await waitView(page, 'play');
    rs = await rows();
    s.eq(rs.filter((x) => x.room).length, 0, '[방·비우기] 방 모두 비움');
    s.eq(diffRows(snap, rs, { ignore: ['room'] }), [], '[방·비우기] 팀·조식·점심·자유시간 불변');
    s.eq(calls('admin_clear').map((c) => c.args.p_what), ['room'], '[방·비우기] admin_clear(room) 1번');
    s.eq(calls('admin_reset').length, 0, '[방·비우기] admin_reset 안 부름');
    r = await playAll(page);
    rs = await rows();
    const men = counts(rs, 'room', ['m1', 'm2', 'm3', 'm4', 'm5']); const women = counts(rs, 'room', ['f1', 'f2']);
    s.eq(rs.filter((x) => x.room).length, 29, '[방·비우기] 다시 뽑아 전원 방');
    s.ok(spread(men) <= 1 && spread(women) <= 1, `[방·비우기] 인원 차이 ≤1: 남 ${JSON.stringify(men)} 여 ${JSON.stringify(women)}`);
    s.eq(diffRows(snap, rs, { ignore: ['room'] }), [], '[방·비우기] 다시 뽑은 뒤에도 다른 칸 불변');
  });

  // ══ 6. 권한 없음 + 참가자 화면 ═══════════════════════
  await scenario(6, '권한 없음(비밀번호 없이/틀린 비밀번호) + 참가자 화면', async (s) => {
    await resetRoster(db); resetCalls();
    const forbidden = () => server.calls.filter((c) => ['pick', 'pick_room'].includes(c.fn) || c.fn.startsWith('admin_'));
    let { page } = await newCtx();
    await page.goto(`${server.url}/draw.html`);
    await waitView(page, 'login');
    s.ok(await visible(page, 'draw-login'), '비밀번호 화면');
    s.ok(!(await visible(page, 'draw-menu')), '첫 화면은 안 보임');
    for (const k of ['Digit1', 'Digit2', 'Space', 'Enter', 'ArrowRight', 'PageDown']) await page.keyboard.press(k); // 입력칸에 초점이 없어도 진행 안 됨
    await sleep(200);
    s.eq((await st(page)).view, 'login', '키를 눌러도 비밀번호 화면 그대로');
    s.eq(server.calls.length, 0, '비밀번호 없이 열었을 때 rpc 요청 0건');
    // 틀린 비밀번호
    await tid(page, 'draw-code').fill('틀린-비밀번호');
    await tid(page, 'draw-login-submit').click();
    await wait(page, () => window.__draw.view === 'login' && !window.__draw.busy && document.getElementById('loginErr').textContent.length > 0);
    s.ok((await text(page, 'draw-login-error')).length > 0, `틀린 비밀번호 안내: ${await text(page, 'draw-login-error')}`);
    s.eq((await st(page)).view, 'login', '틀린 비밀번호는 거절');
    s.eq(await page.evaluate(() => localStorage.getItem('team-picker-admin')), null, '틀린 비밀번호는 저장 안 됨');
    s.eq(forbidden().length, 0, '틀린 비밀번호 뒤 pick/pick_room/admin_* 요청 0건');
    s.eq(server.calls.map((c) => `${c.fn}:${c.status}`), ['board_state:400'], '서버가 받은 요청은 board_state 한 건(거절)');
    await page.keyboard.press('Escape');
    for (const k of ['Digit1', 'Digit2', 'Space']) await page.keyboard.press(k);
    s.eq((await st(page)).view, 'login', '틀린 뒤에도 키로 못 들어감');
    // 저장된 틀린 비밀번호(예전 비밀번호) 로 열기
    const w = await newCtx();
    await w.ctx.addInitScript(() => { try { localStorage.setItem('team-picker-admin', JSON.stringify('옛-비밀번호')); } catch {} });
    await w.page.goto(`${server.url}/draw.html`);
    await wait(w.page, () => window.__draw && window.__draw.view === 'login' && !window.__draw.busy && document.getElementById('loginErr').textContent.length > 0);
    s.eq(forbidden().length, 0, '저장된 틀린 비밀번호로 열어도 pick/admin 요청 0건');
    // 맞는 비밀번호로 들어감
    await tid(page, 'draw-code').fill(ADMIN_CODE);
    await tid(page, 'draw-login-submit').click();
    await waitView(page, 'menu');
    s.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('team-picker-admin'))), ADMIN_CODE, '맞는 비밀번호는 저장됨(board.html 과 같은 키)');
    s.eq(forbidden().length, 0, '로그인만으로 쓰기 요청 없음');
    // 새로 고침: 저장돼 있어 묻지 않음
    await page.reload(); await waitView(page, 'menu');
    s.ok(!(await visible(page, 'draw-login')), '저장된 비밀번호면 다시 묻지 않음');

    // board.html 로 들어가면 draw.html 이 묻지 않고, '비밀번호 지우기' 뒤에는 다시 묻는다(저장 키 공유)
    const bctx = await newCtx();
    bctx.page.on('dialog', (d) => d.accept());
    await bctx.page.goto(`${server.url}/board.html`);
    await bctx.page.locator('#code').fill(ADMIN_CODE);
    await bctx.page.locator('#codeForm button[type=submit]').click();
    await bctx.page.locator('#glanceBody tr').first().waitFor({ timeout: 10000 });
    await bctx.page.goto(`${server.url}/draw.html`);
    await waitView(bctx.page, 'menu');
    s.ok(true, 'board.html 에서 로그인하면 draw.html 이 묻지 않음');
    await bctx.page.goto(`${server.url}/board.html`);
    await bctx.page.locator('#glanceBody tr').first().waitFor({ timeout: 10000 });
    await bctx.page.locator('#forget').click();
    await sleep(300);
    await bctx.page.goto(`${server.url}/draw.html`);
    await waitView(bctx.page, 'login');
    s.ok(true, "board.html '비밀번호 지우기' 뒤 draw.html 이 다시 물음");

    // 참가자 화면(index.html)
    const ictx = await newCtx();
    const idx = ictx.page;
    await idx.goto(`${server.url}/index.html`);
    await idx.locator('#dept option', { hasText: '시험영업부' }).waitFor({ state: 'attached', timeout: 10000 });
    await idx.locator('#dept').selectOption({ label: '시험영업부' });
    await idx.locator('#name').fill('견본가');
    await idx.locator('#loginBtn').click();
    await idx.locator('#goMenu').waitFor({ state: 'visible', timeout: 10000 });
    s.ok(await idx.locator('#goMenu').isVisible(), '참가자 메인: 로그인되고 조식 단추 보임');
    s.ok(!(await idx.locator('#goRoom').isVisible()), '참가자 메인: 방 뽑기 단추 숨김 유지');
    s.ok(!(await idx.locator('#goTeam').isVisible()), '참가자 메인: 팀 뽑기 단추 숨김 유지');
    s.eq(forbidden().length, 0, '참가자 화면 동안 pick/pick_room/admin 요청 없음');
  });

  // ══ 7. 연습 모드 ══════════════════════════════════════
  await scenario(7, '연습 모드(비밀번호 없이, DB 요청 0건)', async (s) => {
    await resetRoster(db); resetCalls();
    const before = await rows();
    const { page, guard } = await newCtx();
    await page.goto(`${server.url}/draw.html?practice=1`);
    await waitView(page, 'menu');
    s.eq((await st(page)).mode, 'practice', '모드');
    s.ok(await visible(page, 'draw-practice-badge'), "'연습' 표시");
    s.ok(await page.locator('#watermark').isVisible(), '연습 워터마크');
    s.ok(!(await visible(page, 'draw-login')), '비밀번호 화면 없이 바로 첫 화면');
    s.ok(/^연습/.test(await page.title()), `탭 제목: ${await page.title()}`);
    await chooseKind(page, 'team');
    s.ok(/전체 30명/.test(await text(page, 'draw-intro-summary')), `요약: ${await text(page, 'draw-intro-summary')}`);
    await startBtn(page);
    let r = await playAll(page);
    s.eq(r.presses, 5, '[팀] 누른 횟수');
    const names = await page.evaluate(() => [...document.querySelectorAll('[data-testid="draw-finale-board"] li .nm')].map((x) => x.textContent));
    s.eq(names.length, 30, '[팀] 마지막 장면 30명');
    s.ok(names.every((n) => /^견본 /.test(n)), '[팀] 견본 이름만 나옴');
    s.ok(/연습/.test(await text(page, 'draw-finale-title')), '[팀] 마지막 장면 제목에 연습 표시');
    // 방: 마지막 장면의 다음 단추
    await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
    s.ok(await visible(page, 'draw-nogender'), '[방] 성별 없는 견본 안내');
    await startBtn(page);
    r = await playAll(page);
    s.eq(r.presses, 8, '[방] 누른 횟수');
    s.eq(r.d.calls, { board_state: 0, pick: 0, pick_room: 0, admin_reset: 0, admin_clear: 0 }, '화면 안 DB 호출 기록 0');
    // 한 명씩 + 모두 공개 + 비우기
    await page.goto(`${server.url}/draw.html?practice=1&unit=person`); await waitView(page, 'menu');
    await chooseKind(page, 'team'); await startBtn(page);
    await page.keyboard.press('Space'); await waitReady(page, 30000);
    await tid(page, 'draw-all').click(); await wait(page, () => window.__draw.dialog === 'all');
    await tid(page, 'draw-dialog-ok').click(); await waitFinale(page, 60000);
    s.eq((await st(page)).revealed, 30, '[한 명씩] 모두 공개 뒤 30명');
    await tid(page, 'draw-finale-home').click(); await waitView(page, 'menu');
    await chooseKind(page, 'team');
    s.ok(await visible(page, 'draw-clear'), '[연습] 이미 뽑은 사람 → 모두 비우기 단추');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    s.ok(/연습/.test(await page.locator('#dlgBody').innerText()), '[연습] 확인 상자에 연습 안내');
    await tid(page, 'draw-dialog-ok').click(); await waitView(page, 'play');
    s.eq((await st(page)).remaining, 30, '[연습] 비운 뒤 30명 모두 남음');
    // 새로 고침하면 처음으로
    await page.reload(); await waitView(page, 'menu');
    s.ok(/뽑음 0 \/ 30명/.test(await text(page, 'draw-menu-team-status')), `새로 고침 뒤 처음으로: ${await text(page, 'draw-menu-team-status')}`);
    s.eq(server.calls.length, 0, '서버가 받은 rpc 요청 0건');
    s.eq(guard.proxied.length, 0, '브라우저가 supabase 로 보내려던 요청 0건');
    s.eq(diffRows(before, await rows()), [], 'DB 변화 0');
    s.eq(await page.evaluate(() => localStorage.getItem('team-picker-admin')), null, '연습 모드는 비밀번호를 만들거나 저장하지 않음');
    s.eq(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('draw-reveal'))), [], '연습 모드는 공개 위치를 localStorage 에 남기지 않음');
  });

  // ══ 8. 오류 처리 ══════════════════════════════════════
  const failPicks = async (page) => {
    const f = { left: 0, aborted: 0, arm(n) { f.left = n; } };
    await page.route(/\/rpc\/pick(_room)?$/, async (r) => { if (f.left > 0) { f.left--; f.aborted++; return r.abort('failed'); } return r.fallback(); });
    return f;
  };
  await scenario(8, '오류 처리(pick 연속 실패 → 오류 상자 → 다시 시도 / 건너뛰기 / 한 명씩)', async (s) => {
    // 8-a 한 팀씩: 3번 실패 → 오류 상자 → 스페이스로 같은 사람 다시
    await resetRoster(db); resetCalls();
    let { page } = await newCtx({ code: true });
    let f = await failPicks(page);
    await openLive(page); await chooseKind(page, 'team');
    f.arm(3);
    await startBtn(page); await page.keyboard.press('Space');
    await waitErr(page, 30000);
    let d = await st(page);
    const X = d.current;
    s.ok(await visible(page, 'draw-error'), '오류 상자 보임');
    s.ok((await text(page, 'draw-error-message')).length > 0, `오류 글: ${await text(page, 'draw-error-message')}`);
    s.ok(await visible(page, 'draw-retry') && await visible(page, 'draw-skip'), '다시 시도·건너뛰기 단추');
    s.eq(f.aborted, 3, '끊은 요청 수(자동 재시도 2번 포함 3번)');
    s.eq(d.calls.pick, 1, '화면이 부른 pick 수(재시도는 한 번으로 셈)');
    s.eq(calls('pick').length, 0, '서버에는 아직 닿지 않음');
    s.eq((await rows()).filter((r) => r.team).length, 0, '실패 동안 DB 팀 0명');
    s.eq(d.locked, false, '오류 상태는 잠겨 있지 않음');
    await page.keyboard.press('Space'); // 같은 사람으로 다시
    const r = await playAll(page);
    let rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 29, '[다시 시도] 최종 29명 팀');
    s.ok(!!rs.find((x) => x.name === X.name).team, `[다시 시도] 실패했던 ${X.name} 이(가) 저장됨`);
    s.eq(calls('pick').filter((c) => c.args.p_name === X.name).length, 1, `[다시 시도] ${X.name} 의 서버 pick 1번`);
    s.eq(new Set(calls('pick').map((c) => c.args.p_name)).size, calls('pick').length, '[다시 시도] 같은 사람 중복 요청 없음');
    s.eq(calls('pick').length, 29, '[다시 시도] 서버 pick 총 29');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[다시 시도] 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(r.seq, TEAM_ORDER, '[다시 시도] 공개 순서 정상');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[다시 시도] 마지막 장면 = DB');

    // 8-b 건너뛰기 → 마지막 장면 안내 → 이어서 뽑기
    await resetRoster(db); resetCalls();
    ({ page } = await newCtx({ code: true }));
    f = await failPicks(page);
    await openLive(page); await chooseKind(page, 'team');
    f.arm(3);
    await startBtn(page); await page.keyboard.press('Space');
    await waitErr(page, 30000);
    const Y = (await st(page)).current;
    await tid(page, 'draw-skip').click();
    for (let i = 0; i < 300 && (await st(page)).phase !== 'ready'; i++) await sleep(50);
    await playAll(page);
    s.eq((await st(page)).skipped, 1, '[건너뛰기] 건너뛴 사람 1명');
    rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 28, '[건너뛰기] 28명 저장');
    s.eq(rs.find((x) => x.name === Y.name).team, null, `[건너뛰기] ${Y.name} 은(는) 팀 없음`);
    const note = await text(page, 'draw-finale-note');
    s.ok(/아직 안 뽑은 사람 1명/.test(note) && note.includes(Y.name), `[건너뛰기] 마지막 장면 안내: ${note}`);
    await tid(page, 'draw-continue').click(); await waitView(page, 'intro');
    s.ok(/이미\s*28명/.test(await text(page, 'draw-intro-summary')), `[건너뛰기] 이어서: ${await text(page, 'draw-intro-summary')}`);
    await tid(page, 'draw-keep').click(); await waitView(page, 'play');
    const r2 = await playAll(page);
    rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 29, '[건너뛰기] 이어서 뽑아 29명');
    s.eq(calls('pick').filter((c) => c.args.p_name === Y.name).length, 1, `[건너뛰기] ${Y.name} 의 서버 pick 은 이어서 뽑을 때 1번`);
    s.eq(calls('pick').length, 29, '[건너뛰기] 서버 pick 총 29(중복 없음)');
    s.eq(new Set(calls('pick').map((c) => c.args.p_name)).size, 29, '[건너뛰기] 같은 사람 중복 요청 없음');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[건너뛰기] 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);

    // 8-c 한 명씩: 실패 → 다시 시도 단추
    await resetRoster(db); resetCalls();
    ({ page } = await newCtx({ code: true }));
    f = await failPicks(page);
    await openLive(page, '?unit=person'); await chooseKind(page, 'room');
    f.arm(3);
    await startBtn(page); await page.keyboard.press('Space');
    await waitErr(page, 40000);
    const Z = (await st(page)).current;
    s.ok(await visible(page, 'draw-error'), '[한 명씩] 오류 상자');
    await tid(page, 'draw-retry').click();
    await waitReady(page, 30000);
    d = await st(page);
    s.eq(d.last && d.last.id, Z.id, `[한 명씩] 같은 사람(${Z.name})이 공개됨`);
    rs = await rows();
    s.ok(!!rs.find((x) => x.id === Z.id).room, `[한 명씩] ${Z.name} 방 저장`);
    s.eq(calls('pick_room').length, 1, '[한 명씩] 서버 pick_room 1번(실패 요청은 닿지 않음)');
    s.eq(rs.filter((x) => x.room).length, 1, '[한 명씩] DB 방 1명');
  });

  // ══ 9. 화면 크기 · 캡처 · 움직임 줄이기 ═══════════════
  async function layoutCheck(page, label, vp) {
    const issues = await page.evaluate(() => {
      const stage = document.getElementById('stage').getBoundingClientRect();
      const out = [];
      const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.dataset && el.dataset.testid ? `[${el.dataset.testid}]` : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
      for (const el of document.querySelectorAll('#stage *')) {
        if (el.closest('[hidden]') || el.closest('.sr-only') || ['confetti', 'flash', 'watermark'].includes(el.id) || el.id === 'stage') continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const t = (el.textContent || '').trim().slice(0, 30);
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) out.push(`가로 넘침 ${desc(el)} scrollW ${el.scrollWidth} > clientW ${el.clientWidth} "${t}"`);
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) out.push(`세로 넘침 ${desc(el)} scrollH ${el.scrollHeight} > clientH ${el.clientHeight} "${t}"`);
        if (r.left < stage.left - 2 || r.right > stage.right + 2 || r.top < stage.top - 2 || r.bottom > stage.bottom + 2) out.push(`무대 밖 ${desc(el)} rect(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}) 무대(${Math.round(stage.left)},${Math.round(stage.top)},${Math.round(stage.right)},${Math.round(stage.bottom)}) "${t}"`);
      }
      const de = document.documentElement;
      if (de.scrollWidth > innerWidth + 1 || de.scrollHeight > innerHeight + 1) out.push(`문서 스크롤 ${de.scrollWidth}x${de.scrollHeight} > ${innerWidth}x${innerHeight}`);
      if (stage.left < -1 || stage.top < -1 || stage.right > innerWidth + 1 || stage.bottom > innerHeight + 1) out.push('무대가 화면 밖');
      return out;
    });
    for (const i of issues) {
      const m = i.match(/> (?:clientW|clientH) (\d+)/) && i.match(/scroll[WH] (\d+) > client[WH] (\d+)/);
      const tag = m && Number(m[1]) - Number(m[2]) <= 8 ? '[경미 ≤8px] ' : '';
      layoutFindings.push(`${tag}${vp} ${label}: ${i}`);
    }
    return issues;
  }
  // 끝나는 애니메이션(카드가 차례로 나오는 것 등)이 모두 끝날 때까지 기다림(무한 반복은 제외). 중간 모습으로 넘침을 재지 않게
  const settle = (page) => page.evaluate(async () => {
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      const run = document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations !== Infinity);
      if (!run.length) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  async function shot(page, vp, name, moving = false) {
    if (!moving) await settle(page); // 섞는 중·도는 중 장면은 계속 움직이므로 기다리지 않음
    const file = join(SHOTS, `${vp}_${name}.png`);
    await page.screenshot({ path: file });
    shotFiles.push(file);
    await layoutCheck(page, name, vp);
  }
  const delayPicks = (page, ms) => page.route(/\/rpc\/pick(_room)?$/, async (r) => { await sleep(ms); r.fallback(); });

  for (const [w, h] of [[1920, 1080], [1280, 720]]) {
    await scenario(9, `화면 크기 ${w}×${h}: 장면별 캡처·넘침 점검`, async (s) => {
      const vp = String(w);
      const viewport = { width: w, height: h };
      // 로그인
      let c = await newCtx({ viewport });
      await c.page.goto(`${server.url}/draw.html`); await waitView(c.page, 'login');
      await shot(c.page, vp, '01_login');
      await c.page.locator('[data-testid="draw-code"]').fill('틀린-비밀번호'); await tid(c.page, 'draw-login-submit').click();
      await wait(c.page, () => document.getElementById('loginErr').textContent.length > 0 && !window.__draw.busy);
      await shot(c.page, vp, '02_login_error');
      // 첫 화면 + 시작 화면(이미 n명, 성별 없음 안내) + 확인 상자
      await resetRoster(db, { picked: true, noGender: true });
      c = await newCtx({ viewport, code: true });
      const page = c.page;
      await openLive(page);
      await shot(page, vp, '03_menu');
      await chooseKind(page, 'team');
      await shot(page, vp, '04_intro_team_already12');
      await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
      await shot(page, vp, '05_dialog_clear');
      await tid(page, 'draw-dialog-cancel').click(); await wait(page, () => window.__draw.dialog === null);
      await tid(page, 'draw-back').click(); await waitView(page, 'menu');
      await chooseKind(page, 'room');
      await shot(page, vp, '06_intro_room_already_nogender');
      // 팀: 섞는 중 · 공개 · 모두 공개 상자 · 마지막 장면
      await resetRoster(db);
      c = await newCtx({ viewport, code: true });
      const p2 = c.page;
      await delayPicks(p2, 140);
      await openLive(p2); await chooseKind(p2, 'team');
      await shot(p2, vp, '07_intro_team_fresh');
      await tid(p2, 'draw-start').click(); await waitView(p2, 'play');
      await shot(p2, vp, '08_play_ready');
      await p2.keyboard.press('Space');
      await wait(p2, () => window.__draw.phase === 'saving'); await sleep(500);
      await shot(p2, vp, '09_team_saving', true);
      await waitReady(p2);
      await shot(p2, vp, '10_team_reveal_1_red');
      await p2.keyboard.press('Space'); await waitReady(p2);
      await shot(p2, vp, '11_team_reveal_2_blue');
      await tid(p2, 'draw-all').click(); await wait(p2, () => window.__draw.dialog === 'all');
      await shot(p2, vp, '12_dialog_all');
      await tid(p2, 'draw-dialog-ok').click(); await waitFinale(p2); await sleep(600);
      await shot(p2, vp, '13_finale_team');
      // 방: 공개(남·여) · 마지막 장면
      await tid(p2, 'draw-next-kind').click(); await waitView(p2, 'intro');
      await tid(p2, 'draw-start').click(); await waitView(p2, 'play');
      await p2.keyboard.press('Space'); await waitReady(p2);
      await shot(p2, vp, '14_room_reveal_1_male');
      for (let i = 0; i < 5; i++) { await p2.keyboard.press('Space'); await waitReady(p2); }
      await shot(p2, vp, '15_room_reveal_6_female');
      await p2.keyboard.press('Space'); await waitReady(p2); // 여자 2호실
      await p2.keyboard.press('Space'); await waitFinale(p2); await sleep(600);
      await shot(p2, vp, '16_finale_room');
      // 성별 없는 명단 마지막 장면(안내 줄이 들어간 모양)
      await resetRoster(db, { noGender: true });
      c = await newCtx({ viewport, code: true });
      const p3 = c.page;
      await openLive(p3); await chooseKind(p3, 'room'); await startBtn(p3); await playAll(p3); await sleep(600);
      await shot(p3, vp, '17_finale_room_nogender_note');
      // 한 명씩: 돌림판 · 결과
      await resetRoster(db, { picked: true });
      c = await newCtx({ viewport, code: true });
      const p4 = c.page;
      await openLive(p4, '?unit=person'); await chooseKind(p4, 'team');
      await tid(p4, 'draw-keep').click(); await waitView(p4, 'play');
      await p4.keyboard.press('Space');
      await wait(p4, () => window.__draw.phase === 'spinning'); await sleep(700);
      await shot(p4, vp, '18_person_name_spin', true);
      await sleep(2300);
      await shot(p4, vp, '19_person_wheel_spin', true);
      await waitReady(p4);
      await shot(p4, vp, '20_person_result');
      // 오류 상자
      await resetRoster(db);
      c = await newCtx({ viewport, code: true });
      const p5 = c.page;
      const f = await failPicks(p5);
      await openLive(p5); await chooseKind(p5, 'team'); f.arm(3);
      await startBtn(p5); await p5.keyboard.press('Space'); await waitErr(p5, 30000);
      await shot(p5, vp, '21_error_box');
      // 연습 모드
      c = await newCtx({ viewport });
      const p6 = c.page;
      await p6.goto(`${server.url}/draw.html?practice=1`); await waitView(p6, 'menu');
      await shot(p6, vp, '22_practice_menu');
      await chooseKind(p6, 'team'); await startBtn(p6);
      await p6.keyboard.press('Space'); await waitReady(p6);
      await shot(p6, vp, '23_practice_reveal');
      await tid(p6, 'draw-all').click(); await wait(p6, () => window.__draw.dialog === 'all'); await tid(p6, 'draw-dialog-ok').click(); await waitFinale(p6); await sleep(600);
      await shot(p6, vp, '24_practice_finale');
      s.note(`${vp}: 캡처 24장`);
    });
  }

  await scenario(9, '움직임 줄이기(reducedMotion: reduce): 팀·방·한 명씩 끝까지', async (s) => {
    await resetRoster(db); resetCalls();
    let { page } = await newCtx({ code: true, reducedMotion: 'reduce' });
    await openLive(page);
    s.eq((await st(page)).reduced, true, '__draw.reduced');
    await chooseKind(page, 'team'); await startBtn(page);
    let t0 = Date.now();
    let r = await playAll(page);
    s.eq(r.presses, 5, '[팀] 누른 횟수');
    let rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 29, '[팀] DB 전원 팀');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[팀] 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[팀] 마지막 장면 = DB');
    s.note(`[팀] 움직임 줄이기 진행 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
    await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
    await startBtn(page);
    r = await playAll(page);
    s.eq(r.presses, 8, '[방] 누른 횟수');
    rs = await rows();
    s.eq(rs.filter((x) => x.room).length, 29, '[방] DB 전원 방');
    s.eq(rs.filter((x) => x.room[0] !== (x.gender === '남' ? 'm' : 'f')).length, 0, '[방] 성별 섞임');
    // 한 명씩
    await resetRoster(db);
    ({ page } = await newCtx({ code: true, reducedMotion: 'reduce' }));
    await openLive(page, '?unit=person'); await chooseKind(page, 'team'); await startBtn(page);
    t0 = Date.now();
    r = await playAll(page, { max: 40 });
    s.eq(r.presses, 30, '[한 명씩] 누른 횟수(29명 + 마지막 장면)');
    rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 29, '[한 명씩] DB 전원 팀');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[한 명씩] 인원 차이 ≤1`);
    s.note(`[한 명씩] 움직임 줄이기 진행 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  });

  // ══ 10. 관리자 페이지 회귀 ════════════════════════════
  await scenario(10, '관리자 페이지(board.html) 회귀: 발표 화면 링크·명단·자동으로 나누기', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    await page.goto(`${server.url}/board.html`);
    await page.locator('#glanceBody tr').first().waitFor({ timeout: 10000 });
    s.eq(await page.locator('#glanceBody tr').count(), 29, '한눈에 보기 줄 수');
    s.eq(await page.locator('#peopleBody tr').count(), 29, '명단 관리 표 줄 수');
    const link = page.locator('#drawLink');
    s.ok(await link.isVisible(), '발표용 뽑기 화면 링크 보임');
    s.ok(/draw\.html$/.test(await link.getAttribute('href')), `링크 주소: ${await link.getAttribute('href')}`);
    await page.locator('#roomCard > summary').click();
    s.ok(await page.locator('#roomAuto').isVisible(), '객실표를 펴면 자동으로 나누기 단추 보임');
    await page.locator('#roomAuto').click();
    await wait(page, () => document.getElementById('roomMsg').textContent.length > 0, null, 15000);
    s.ok(/남녀 따로/.test(await page.locator('#roomMsg').innerText()), `자동으로 나누기 안내: ${await page.locator('#roomMsg').innerText()}`);
    const rs = await rows();
    const men = counts(rs, 'room', ['m1', 'm2', 'm3', 'm4', 'm5']); const women = counts(rs, 'room', ['f1', 'f2']);
    s.eq(rs.filter((x) => x.room).length, 29, '자동으로 나누기: 전원 방');
    s.ok(spread(men) <= 1 && spread(women) <= 1, `자동으로 나누기 인원 차이 ≤1: 남 ${JSON.stringify(men)} 여 ${JSON.stringify(women)}`);
    s.eq(rs.filter((x) => x.room[0] !== (x.gender === '남' ? 'm' : 'f')).length, 0, '자동으로 나누기: 성별 섞임 0');
    // 링크로 가면 묻지 않고 열림
    await link.click();
    await page.waitForURL(/draw\.html/);
    await waitView(page, 'menu');
    s.ok(/뽑음 0 \/ 29명/.test(await text(page, 'draw-menu-team-status')) && /29 \/ 29명|모두 뽑았어요/.test(await text(page, 'draw-menu-room-status')), `링크로 들어간 첫 화면 상태: 팀 ${await text(page, 'draw-menu-team-status')} / 방 ${await text(page, 'draw-menu-room-status')}`);
    s.ok(await visible(page, 'draw-to-board'), '첫 화면에 관리자 페이지로 돌아가는 링크');
  });

  // ══ 11. 키 · 단추(소리·전체 화면·Esc·처음 화면) ═══════════
  await scenario(11, '키: M 소리, F 전체 화면, Esc, 첫 화면 1·2, 처음 화면 단추', async (s) => {
    await resetRoster(db); resetCalls();
    const before = await rows();
    const { page } = await newCtx({ code: true });
    await openLive(page);
    s.eq((await st(page)).sound, false, '소리는 처음에 꺼져 있음');
    s.ok(/꺼짐/.test(await text(page, 'draw-sound')), `소리 단추: ${await text(page, 'draw-sound')}`);
    await page.keyboard.press('KeyM');
    s.eq((await st(page)).sound, true, 'M: 소리 켜짐');
    s.eq(await tid(page, 'draw-sound').getAttribute('aria-pressed'), 'true', '소리 단추 aria-pressed');
    await page.keyboard.press('KeyM');
    s.eq((await st(page)).sound, false, 'M: 다시 꺼짐');
    await tid(page, 'draw-sound').click();
    s.eq((await st(page)).sound, true, '소리 단추 클릭으로 켜짐');
    await tid(page, 'draw-sound').click();
    await page.keyboard.press('KeyF'); await sleep(300);
    const fs1 = await page.evaluate(() => !!document.fullscreenElement);
    await page.keyboard.press('KeyF'); await sleep(300);
    const fs2 = await page.evaluate(() => !!document.fullscreenElement);
    if (fs1 && !fs2) s.ok(true, 'F: 전체 화면 켜고 끄기');
    else s.note(`F: 헤드리스 Chrome 에서 전체 화면 전환을 확인하지 못함(켬 ${fs1}, 끔 ${!fs2}) — 실제 노트북에서 직접 확인 필요`);
    await page.keyboard.press('Digit2'); await waitView(page, 'intro');
    s.eq((await st(page)).kind, 'room', '2: 방 배정 뽑기');
    await tid(page, 'draw-back').click(); await waitView(page, 'menu');
    await page.keyboard.press('Digit1'); await waitView(page, 'intro');
    s.eq((await st(page)).kind, 'team', '1: 팀 뽑기');
    await startBtn(page);
    s.ok(await visible(page, 'draw-home'), '뽑는 화면에 처음 화면 단추');
    // 공개 단위 바꾸기(첫 화면)
    await tid(page, 'draw-home').click(); await waitView(page, 'menu');
    await tid(page, 'draw-unit-person').click();
    s.eq((await st(page)).unit, 'person', '한 명씩으로 바꿈');
    s.eq(await tid(page, 'draw-unit-person').getAttribute('aria-pressed'), 'true', '한 명씩 aria-pressed');
    await tid(page, 'draw-unit-group').click();
    s.eq((await st(page)).unit, 'group', '한 팀·한 방씩으로 되돌림');
    s.eq(diffRows(before, await rows()), [], '키·단추 확인 동안 DB 불변');
    s.eq(server.calls.filter((c) => c.fn !== 'board_state').length, 0, 'board_state 말고는 요청 없음');
  });

  // ── 정리 · 보고 ──────────────────────────────────────
  await browser.close();
  await server.close();
  await db.end();
  console.log('\n══ 요약 ══');
  for (const r of results) console.log(`${r.ok ? '통과' : '실패'}  [${r.num}] ${r.name}  (${r.checks}개 확인)`);
  if (layoutFindings.length) {
    console.log(`\n레이아웃 점검 발견 ${layoutFindings.length}건:`);
    const seen = new Set();
    for (const l of layoutFindings) if (!seen.has(l)) { seen.add(l); console.log('  - ' + l); }
  } else if (!only.length || only.includes('9')) console.log('\n레이아웃 점검: 글자 잘림·넘침·무대 밖 요소 없음');
  if (shotFiles.length) console.log(`\n캡처 ${shotFiles.length}장: ${SHOTS}`);
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, results, layoutFindings, shotFiles };
}
