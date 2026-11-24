// 발표용 뽑기 화면(draw.html) 통합 시험.  실행: cd tests && node run.mjs draw [시나리오 번호 ...]   (예: node run.mjs draw 1 5)
//   30~30.4: 부서 숨김(모든 공개 화면에 부서 문자열 없음·같은 이름 구분 표시·이름 글자 크기·넘침)
//   1~12·16~19: 기본 진행 '전체 한 번에'(unit=all) · 13~15: 권한·관리자 페이지·키 · 21~29: 남겨 둔 '한 팀·한 방씩'(?unit=group)·'한 명씩'(?unit=person) 회귀
//   40~47: 입구(관리자 비밀번호 — 통과 전 화면·명단 DOM 없음·주소 옵션·저장된 비밀번호 무시·같은 탭 새로 고침·새 탭·잠그기·통신 오류·키·노출·캡처). 캡처 폴더: LOCK_SHOTS (기본 DRAW_SHOTS/lock)
//   모든 시나리오: openLive·enterGate 가 입구에서 비밀번호를 직접 넣음(같은 탭은 sessionStorage 로 저절로). 콘솔에 비밀번호가 나오면 실패
//   npm run test:draw  도 같음.  캡처 폴더: 환경변수 DRAW_SHOTS (기본 tests/.out/draw-shots). 전환 연속 캡처는 그 아래 transition-team/ · transition-room/
// 운영 DB 에는 닿지 않는다: 모든 browser context 에 guardNetwork 를 걸고, 시나리오 끝마다 막힌 외부 요청이 0건인지 확인한다.
// 각 시나리오는 끝난 뒤 로컬 postgres 를 직접 조회해(pg) 결과를 검증한다.
import { mkdirSync, rmSync } from 'node:fs';
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
    const s = { num, name, checks: 0, fails: [], notes: [], guards: [], errors: [], ctxs: [], consoles: [] };
    s.ok = (c, msg) => { s.checks++; if (!c) s.fails.push(msg); return !!c; };
    s.eq = (a, b, msg) => s.ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: 실제 ${JSON.stringify(a)} / 기대 ${JSON.stringify(b)}`);
    s.note = (m) => s.notes.push(m);
    cur = s;
    process.stdout.write(`[${num}] ${name} ... `);
    try { await fn(s); } catch (e) { s.fails.push('예외: ' + String(e.stack || e).split('\n').slice(0, 5).join(' | ')); }
    for (const g of s.guards) s.ok(g.blocked.length === 0, `허용 안 된 외부 요청: ${g.blocked.join(', ')}`); // 운영 DB 등 외부 접근 0건
    s.ok(s.errors.length === 0, `페이지 오류(pageerror): ${s.errors.join(' | ')}`);
    s.ok(!s.consoles.some((t) => t.includes(ADMIN_CODE)), '콘솔에 관리자 비밀번호가 안 나옴'); // 모든 시나리오 공통
    for (const c of s.ctxs) await c.close().catch(() => {});
    const ok = s.fails.length === 0;
    results.push({ num, name, ok, checks: s.checks, fails: s.fails, notes: s.notes, ms: Date.now() - t0 });
    console.log(`${ok ? '통과' : '실패'} (${s.checks}개 확인, ${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    for (const f of s.fails) console.log('    ✗ ' + f);
    for (const n of s.notes) console.log('    · ' + n);
    cur = null;
  }

  /** 새 context(+가드). code:true 면 관리자 비밀번호를 localStorage 'team-picker-admin' 에 미리 넣어 둔다(board.html 에 들어간 적이 있는 기기 흉내).
   *  draw.html 은 그 값을 쓰지 않으므로(입구에서 직접 넣음) 들어가는 것은 openLive·enterGate 가 한다. */
  async function newCtx(o = {}) {
    const { code, trace, ...rest } = o;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ko-KR', ...rest });
    const g = await guardNetwork(ctx, server.url);
    cur.guards.push(g);
    cur.ctxs.push(ctx);
    ctx.on('page', (p) => { p.on('pageerror', (e) => cur.errors.push(e.message)); p.on('console', (m) => cur.consoles.push(m.text())); });
    if (code) await ctx.addInitScript((c) => { try { localStorage.setItem('team-picker-admin', JSON.stringify(c)); } catch {} }, ADMIN_CODE);
    if (trace) await ctx.addInitScript(() => { // 화면·단계·groupIndex 가 바뀐 순서를 4ms 마다 기록(팀 건너뛰기·되돌아감·룰렛 반복 확인)
      window.__trace = []; let last = null;
      const rec = () => { const d = window.__draw; if (!d) return; const k = `${d.view}|${d.groupIndex}|${d.phase}`; if (k !== last) { last = k; window.__trace.push({ v: d.view, g: d.groupIndex, ph: d.phase, t: performance.now() }); } };
      setInterval(rec, 4); // 타이머는 헤드리스에서 늦춰질 수 있어, 화면·단계 속성이 바뀔 때마다도 기록(MutationObserver)
      document.addEventListener('DOMContentLoaded', () => {
        new MutationObserver(rec).observe(document.body, { attributes: true, attributeFilter: ['data-phase'] });
        const stage = document.getElementById('stage');
        if (stage) new MutationObserver(rec).observe(stage, { attributes: true, attributeFilter: ['data-view'] });
      });
    });
    const page = await ctx.newPage();
    return { ctx, page, guard: g };
  }
  const st = (page) => page.evaluate(() => { const d = window.__draw; return d ? JSON.parse(JSON.stringify(d)) : null; });
  const wait = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout, polling: 30 });
  // 뽑는 화면(play)은 열린 직후 보호 시간(screenGuardMs.play) 동안 진행 키를 받지 않으므로, 그게 끝날 때까지 기다림
  const waitView = (page, v, t) => wait(page, (x) => window.__draw && window.__draw.view === x && !window.__draw.busy && (x !== 'play' || !window.__draw.guarded), v, t);
  const waitReady = (page, t) => wait(page, () => { const d = window.__draw; return d && !d.busy && d.phase === 'ready'; }, null, t);
  const waitFinale = (page, t) => wait(page, () => { const d = window.__draw; return d && d.view === 'finale' && !d.busy; }, null, t);
  const waitErr = (page, t) => wait(page, () => { const d = window.__draw; return d && d.phase === 'error' && !d.busy; }, null, t);
  const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
  const text = async (page, id) => (await tid(page, id).innerText()).replace(/\s+/g, ' ').trim();
  const visible = (page, id) => tid(page, id).isVisible();
  const G = '?unit=group'; // 남겨 둔 '한 팀·한 방씩' 시험용 주소 옵션
  const traceOf = (page) => page.evaluate(() => window.__trace);
  const dedup = (a) => a.filter((x, i) => i === 0 || x !== a[i - 1]);
  const unguard = (page) => wait(page, () => window.__draw && !window.__draw.guarded && !window.__draw.busy); // 화면 전환 직후 보호 시간이 끝날 때까지

  /** 입구: 서버 확인이 끝날 때까지 기다린 뒤(같은 탭이면 저절로 들어감) 아직 입구면 비밀번호를 넣고 Enter. 직접 넣었으면 true */
  async function enterGate(page, pw = ADMIN_CODE) {
    await wait(page, () => { const d = window.__draw; return d && (d.view !== 'login' || (!d.busy && d.gate !== 'checking')); });
    if ((await st(page)).view !== 'login') return false;
    await tid(page, 'draw-code').fill(pw);
    await tid(page, 'draw-code').press('Enter');
    await wait(page, () => { const d = window.__draw; return d && (d.view !== 'login' || (!d.busy && d.gate !== 'checking')); });
    if ((await st(page)).view === 'login') throw new Error(`입구를 통과하지 못함: ${await text(page, 'draw-login-error')}`);
    return true;
  }
  async function openLive(page, query = '') { await page.goto(`${server.url}/draw.html${query}`); await enterGate(page); await waitView(page, 'menu'); }
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

  // ── 오류 흉내 도우미 ──────────────────────────────────
  const failPicks = async (page) => {
    const f = { left: 0, aborted: 0, arm(n) { f.left = n; } };
    await page.route(/\/rpc\/pick(_room)?$/, async (r) => { if (f.left > 0) { f.left--; f.aborted++; return r.abort('failed'); } return r.fallback(); });
    return f;
  };
  // ── 화면 점검 도우미 ──────────────────────────────────
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

  // ════════════════════════════════════════════════════════════════
  // 전체 한 번에(기본 unit='all'): 시작 → 한 번 누름 → 룰렛(남은 사람 전원 저장) → 저절로 전체 결과
  // ════════════════════════════════════════════════════════════════
  const MIN_MS = 3500; // draw.js DRAW_CONFIG.rouletteMinMs
  const phasesOf = (tr) => dedup(tr.map((t) => `${t.v}:${t.ph}`));
  // 뽑는 화면·전체 결과의 단계만(전체 결과를 그리기 직전 잠깐 'play:finale' 인 순간은 뺌)
  const mainPhases = (tr) => phasesOf(tr.filter((t) => t.v === 'finale' || (t.v === 'play' && t.ph !== 'finale')));
  /** 시작 화면의 주 단추 → 뽑는 화면 → 한 번 누름 → 전체 결과까지. 누른 횟수·룰렛 시간(누름~느려지기 시작)을 돌려줌 */
  async function runAll(page, { key = 'Space' } = {}) {
    await wait(page, () => { const d = window.__draw; return d && !d.busy && (d.view === 'finale' || d.phase === 'ready'); });
    let presses = 0; let t0 = 0;
    if ((await st(page)).view !== 'finale') { t0 = Date.now(); await page.keyboard.press(key); presses++; }
    await wait(page, () => { const d = window.__draw; return d && !d.busy && (d.view === 'finale' || d.phase === 'error'); });
    const d = await st(page);
    if (d.phase === 'error') throw new Error(`진행 중 오류 상태: ${d.error}`);
    return { presses, d, ms: t0 ? Date.now() - t0 : 0 };
  }
  // 룰렛을 누른 때부터 느려지기 시작(landing)까지 걸린 시간(trace 기준)
  const rouletteMs = (tr) => { const a = tr.find((t) => t.ph === 'saving'); const b = tr.find((t) => t.ph === 'landing' || t.v === 'finale'); return a && b ? Math.round(b.t - a.t) : -1; };

  await scenario(1, '[전체] 처음부터 끝까지(팀): 한 번 누르면 룰렛 → 저절로 전체 결과', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true, trace: true });
    await openLive(page);
    const d0 = await st(page);
    s.eq([d0.mode, d0.unit], ['live', 'all'], '모드·공개 방법 기본값(전체 한 번에)');
    s.ok(!(await visible(page, 'draw-unit-line')), '첫 화면에 공개 방법 줄이 없음(기본이라 단순하게)');
    await chooseKind(page, 'team');
    s.ok(/전체 29명/.test(await text(page, 'draw-intro-summary')), `시작 화면 요약: ${await text(page, 'draw-intro-summary')}`);
    s.ok(await visible(page, 'draw-start'), '시작하기 단추');
    await startBtn(page);
    s.ok(/뽑기 시작/.test(await text(page, 'draw-next')), `다음 단추 글: ${await text(page, 'draw-next')}`);
    s.ok(!(await visible(page, 'draw-all')), '전체 한 번에는 "모두 공개" 단추 없음');
    s.ok(!(await visible(page, 'draw-board')), '옆 결과판 없음(결과는 끝나고 한꺼번에)');
    s.ok(/전체 결과/.test(await page.locator('#idleSub').innerText()), `준비 안내: ${await page.locator('#idleSub').innerText()}`);
    const r = await runAll(page);
    s.eq(r.presses, 1, '누른 횟수(뽑는 화면에서 1번)');
    s.eq(r.d.view, 'finale', '더 누르지 않아도 전체 결과로 넘어감');
    const tr = await traceOf(page);
    if (process.env.DRAW_DEBUG) console.log(JSON.stringify(tr));
    const ph = mainPhases(tr);
    s.eq(ph, ['play:ready', 'play:saving', 'play:landing', 'finale:finale'], '단계(준비 → 룰렛 → 멈춤 → 전체 결과)');
    const rm = rouletteMs(tr);
    s.ok(rm >= MIN_MS - 50, `룰렛 최소 시간 지킴(${rm}ms ≥ ${MIN_MS})`);
    const rs = await rows();
    const c = counts(rs, 'team', TEAM_ORDER);
    s.eq(rs.filter((x) => x.team).length, 29, 'DB 팀이 정해진 사람');
    s.ok(spread(c) <= 1, `팀 인원 차이 ≤1: ${JSON.stringify(c)}`);
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '전체 결과 이름 = DB 결과');
    s.eq(r.d.revealed, 29, '__draw.revealed = 29');
    s.eq([r.d.saveDone, r.d.saveTotal], [29, 29], '진행 막대 29 / 29');
    s.eq(calls('pick').length, 29, '서버가 받은 pick 수');
    s.eq(new Set(calls('pick').map((x) => x.args.p_name)).size, 29, 'pick 받은 사람 수(중복 없음)');
    s.eq(calls('pick_room').length + calls('admin_reset').length + calls('admin_clear').length, 0, '다른 쓰기 요청');
    s.ok(await visible(page, 'draw-next-kind'), '② 방 배정 뽑기로 → 단추');
    s.ok(await page.evaluate(() => document.getElementById('finaleBoard').classList.contains('enter')), '전체 결과 연출(enter) 적용');
    s.note(`분포 ${JSON.stringify(c)}, 룰렛(누름~멈추기 시작) ${rm}ms, 누름~전체 결과 ${r.ms}ms`);
  });

  await scenario(2, '[전체] 처음부터 끝까지(방) + 성별 없는 사람', async (s) => {
    await resetRoster(db); resetCalls();
    let { page } = await newCtx({ code: true });
    await openLive(page); await chooseKind(page, 'room');
    s.ok(!(await visible(page, 'draw-nogender')), '성별 없는 사람이 없으면 안내 안 보임');
    await startBtn(page);
    let r = await runAll(page);
    s.eq(r.presses, 1, '누른 횟수 1');
    let rs = await rows();
    s.eq(rs.filter((x) => x.room).length, 29, 'DB 방 배정 수');
    s.eq(rs.filter((x) => x.room && x.room[0] !== (x.gender === '남' ? 'm' : 'f')).length, 0, '성별 섞인 방');
    const men = counts(rs, 'room', ['m1', 'm2', 'm3', 'm4', 'm5']); const women = counts(rs, 'room', ['f1', 'f2']);
    s.ok(spread(men) <= 1 && spread(women) <= 1, `성별 안 방 인원 차이 ≤1: 남 ${JSON.stringify(men)} 여 ${JSON.stringify(women)}`);
    s.eq(await finaleMap(page), mapOf(rs, 'room'), '전체 결과 이름 = DB 결과');
    s.eq(await page.evaluate(() => [...document.querySelectorAll('#finaleBoard .rrow.men section')].length + '/' + [...document.querySelectorAll('#finaleBoard .rrow.women section')].length), '5/2', '남자 5칸·여자 2칸');
    s.eq(calls('pick_room').length, 29, 'pick_room 수');
    s.eq(calls('pick').length, 0, 'pick(팀) 요청 없음');
    s.ok(await visible(page, 'draw-next-kind') && /팀 뽑기로/.test(await text(page, 'draw-next-kind')), '① 팀 뽑기로 → 단추');
    // 성별 없는 1명
    await resetRoster(db, { noGender: true }); resetCalls();
    ({ page } = await newCtx({ code: true }));
    await openLive(page); await chooseKind(page, 'room');
    const ng = await text(page, 'draw-nogender');
    s.ok(await visible(page, 'draw-nogender') && /1명/.test(ng) && /견본고/.test(ng), `성별 없는 사람 안내: ${ng}`);
    await startBtn(page);
    r = await runAll(page);
    rs = await rows();
    s.eq(rs.filter((x) => x.room).length, 28, '방 배정 수(28)');
    s.eq(rs.find((x) => x.name === '견본고').room, null, '성별 없는 사람 방 그대로 없음');
    s.eq(calls('pick_room').length, 28, 'pick_room 수(성별 없는 사람 요청 안 함)');
    s.ok(/성별이 없어 못 뽑은 사람 1명/.test(await text(page, 'draw-finale-note')), '전체 결과 안내');
    s.eq(r.d.saveTotal, 28, '진행 막대 전체 = 28');
  });

  await scenario(3, '[전체] 이미 뽑은 사람 섞임(그대로 두기 / 모두 비우기, 팀·방)', async (s) => {
    // 3-a 팀: 그대로 두고
    await resetRoster(db, { picked: true }); resetCalls();
    let snap = await rows();
    let { page } = await newCtx({ code: true });
    await openLive(page); await chooseKind(page, 'team');
    s.ok(/이미\s*12명/.test(await text(page, 'draw-intro-summary')), `'이미 12명': ${await text(page, 'draw-intro-summary')}`);
    s.ok(/남은 17명만/.test(await text(page, 'draw-keep')), `그대로 두고 단추: ${await text(page, 'draw-keep')}`);
    s.ok(await visible(page, 'draw-clear'), '모두 비우고 처음부터 단추');
    await tid(page, 'draw-keep').click(); await waitView(page, 'play');
    s.ok(/이미 뽑은 12명도 함께/.test(await page.locator('#idleSub').innerText()), `준비 안내: ${await page.locator('#idleSub').innerText()}`);
    s.eq([(await st(page)).saveDone, (await st(page)).saveTotal], [12, 29], '진행 막대가 12 / 29에서 시작');
    let r = await runAll(page);
    let rs = await rows();
    s.eq(r.presses, 1, '[팀·그대로] 누른 횟수 1');
    s.eq(diffRows(snap, rs, { ids: snap.filter((x) => x.team).map((x) => x.id) }), [], '[팀·그대로] 이미 뽑은 12명 모든 칸 불변');
    s.eq(diffRows(snap, rs, { ids: snap.filter((x) => !x.team).map((x) => x.id), ignore: ['team', 'picked_at'] }), [], '[팀·그대로] 나머지 사람의 다른 칸 불변');
    s.eq(rs.filter((x) => x.team).length, 29, '[팀·그대로] 최종 전원 팀');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[팀·그대로] 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(r.d.calls.pick, 17, '[팀·그대로] pick 수(남은 사람만)');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[팀·그대로] 전체 결과 = DB(이미 뽑은 사람 포함 29명)');
    // 3-b 팀: 모두 비우기(→·PageDown·F 무시, Esc·취소 → 확인)
    await resetRoster(db, { picked: true }); resetCalls();
    snap = await rows();
    ({ page } = await newCtx({ code: true }));
    await openLive(page); await chooseKind(page, 'team');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    s.eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'dlgCancel', '상자 초점은 취소');
    for (let i = 0; i < 10; i++) { await page.keyboard.press('ArrowRight'); await page.keyboard.press('PageDown'); }
    s.eq((await st(page)).dialog, 'clear', '[팀·비우기] →·PageDown 으로는 확정 안 됨');
    await page.keyboard.press('Escape'); await wait(page, () => window.__draw.dialog === null);
    s.eq(diffRows(snap, await rows()), [], '[팀·비우기] Esc: DB 불변');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    await tid(page, 'draw-dialog-cancel').click(); await wait(page, () => window.__draw.dialog === null);
    s.eq(calls('admin_reset').length, 0, '[팀·비우기] 취소 뒤 admin_reset 없음');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    await tid(page, 'draw-dialog-ok').click(); await waitView(page, 'play');
    rs = await rows();
    s.eq(rs.filter((x) => x.team || x.picked_at).length, 0, '[팀·비우기] 팀·뽑은 시각 모두 비움');
    s.eq(diffRows(snap, rs, { ignore: ['team', 'picked_at'] }), [], '[팀·비우기] 조식·점심·방·자유시간 등 다른 칸 불변');
    s.eq(calls('admin_reset').length, 1, '[팀·비우기] admin_reset 1번');
    r = await runAll(page);
    rs = await rows();
    s.eq(r.presses, 1, '[팀·비우기] 누른 횟수 1');
    s.eq(rs.filter((x) => x.team).length, 29, '[팀·비우기] 다시 뽑아 전원 팀');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `[팀·비우기] 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(r.d.calls.pick, 29, '[팀·비우기] 다시 29명 pick');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[팀·비우기] 전체 결과 = DB');
    // 3-c 방: 그대로 두고
    await resetRoster(db, { picked: true }); resetCalls();
    snap = await rows();
    const roomDone = snap.filter((x) => x.room).length;
    ({ page } = await newCtx({ code: true }));
    await openLive(page); await chooseKind(page, 'room');
    await tid(page, 'draw-keep').click(); await waitView(page, 'play');
    r = await runAll(page);
    rs = await rows();
    s.eq(diffRows(snap, rs, { ids: snap.filter((x) => x.room).map((x) => x.id) }), [], '[방·그대로] 이미 방 있는 사람 불변');
    s.eq(diffRows(snap, rs, { ignore: ['room'] }), [], '[방·그대로] 다른 칸 불변');
    s.eq(rs.filter((x) => x.room).length, 29, '[방·그대로] 최종 전원 방');
    s.eq(r.d.calls.pick_room, 29 - roomDone, '[방·그대로] pick_room 수');
    s.eq(await finaleMap(page), mapOf(rs, 'room'), '[방·그대로] 전체 결과 = DB');
    // 3-d 방: 모두 비우기
    await resetRoster(db, { picked: true }); resetCalls();
    snap = await rows();
    ({ page } = await newCtx({ code: true }));
    await openLive(page); await chooseKind(page, 'room');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    await tid(page, 'draw-dialog-ok').click(); await waitView(page, 'play');
    s.eq(calls('admin_clear').map((c) => c.args.p_what), ['room'], '[방·비우기] admin_clear(room) 1번');
    r = await runAll(page);
    rs = await rows();
    const men = counts(rs, 'room', ['m1', 'm2', 'm3', 'm4', 'm5']); const women = counts(rs, 'room', ['f1', 'f2']);
    s.eq(rs.filter((x) => x.room).length, 29, '[방·비우기] 다시 뽑아 전원 방');
    s.ok(spread(men) <= 1 && spread(women) <= 1, `[방·비우기] 인원 차이 ≤1: 남 ${JSON.stringify(men)} 여 ${JSON.stringify(women)}`);
    s.eq(diffRows(snap, rs, { ignore: ['room'] }), [], '[방·비우기] 팀·조식·점심·자유시간 불변');
    s.eq(await finaleMap(page), mapOf(rs, 'room'), '[방·비우기] 전체 결과 = DB');
  });

  /** 전원을 DB 에서 바로 정해 둠(전원 이미 뽑은 상태 흉내: 실제 함수 pick/pick_room 을 차례로 부름) */
  async function drawEveryone(kind) {
    const ps = (await rows()).filter((r) => kind === 'team' || r.gender);
    for (const p of ps) await db.query(`select public.${kind === 'team' ? 'pick' : 'pick_room'}($1, $2)`, [p.dept, p.name]);
  }

  await scenario(4, '[전체] 전원이 이미 뽑은 경우: 룰렛 없이 바로 전체 결과 + 다시 뽑기는 모두 비우기로', async (s) => {
    await resetRoster(db); await drawEveryone('team'); await drawEveryone('room'); resetCalls();
    const snap = await rows();
    s.eq([snap.filter((x) => x.team).length, snap.filter((x) => x.room).length], [29, 29], '(준비) 전원 팀·방 있음');
    const { page } = await newCtx({ code: true, trace: true });
    await openLive(page);
    s.ok(/모두 뽑았어요/.test(await text(page, 'draw-menu-team-status')), `첫 화면 상태: ${await text(page, 'draw-menu-team-status')}`);
    await chooseKind(page, 'team');
    s.ok(await visible(page, 'draw-show-result') && /전체 결과 보기/.test(await text(page, 'draw-show-result')), '전체 결과 보기 단추');
    s.ok(!(await visible(page, 'draw-keep')) && !(await visible(page, 'draw-start')), '뽑기 단추 없음');
    s.ok(await visible(page, 'draw-clear'), '모두 비우고 처음부터 단추');
    const hint = await text(page, 'draw-intro-hint');
    s.ok(await visible(page, 'draw-intro-hint') && /모두 비우고 처음부터/.test(hint), `다시 뽑는 법 안내: ${hint}`);
    await tid(page, 'draw-show-result').click();
    await waitFinale(page);
    const tr = await traceOf(page);
    s.ok(!tr.some((t) => t.ph === 'saving' || t.ph === 'landing'), `룰렛 없이 바로(단계: ${phasesOf(tr).join(' → ')})`);
    s.eq(await finaleMap(page), mapOf(snap, 'team'), '[팀] 전체 결과 = DB');
    s.eq(calls('pick').length + calls('pick_room').length, 0, '쓰기 요청 0');
    // 방도
    await unguard(page);
    await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
    await tid(page, 'draw-show-result').click(); await waitFinale(page);
    s.eq(await finaleMap(page), mapOf(snap, 'room'), '[방] 전체 결과 = DB');
    s.eq(diffRows(snap, await rows()), [], 'DB 불변');
    // 다시 뽑기: 모두 비우고 처음부터 → 확인 → 한 번 누름 → 전체 결과
    await unguard(page);
    await tid(page, 'draw-finale-home').click(); await waitView(page, 'menu');
    await chooseKind(page, 'team');
    await tid(page, 'draw-clear').click(); await wait(page, () => window.__draw.dialog === 'clear');
    await tid(page, 'draw-dialog-ok').click(); await waitView(page, 'play');
    const r = await runAll(page);
    const rs = await rows();
    s.eq(r.presses, 1, '[다시 뽑기] 누른 횟수 1');
    s.eq(rs.filter((x) => x.team).length, 29, '[다시 뽑기] 전원 팀');
    s.eq(calls('pick').length, 29, '[다시 뽑기] pick 29');
    s.eq(diffRows(snap, rs, { ignore: ['team', 'picked_at'] }), [], '[다시 뽑기] 방 등 다른 칸 불변');
  });

  await scenario(5, '[전체] 저장 중 새로 고침 → 남은 사람만 이어서 저장 → 전체 결과', async (s) => {
    await resetRoster(db); resetCalls();
    const a = await newCtx({ code: true });
    await a.page.route(/\/rpc\/pick$/, async (r) => { await sleep(120); r.fallback(); });
    await openLive(a.page); await chooseKind(a.page, 'team'); await startBtn(a.page);
    await a.page.keyboard.press('Space');
    for (let i = 0; i < 400; i++) { const n = (await rows()).filter((r) => r.team).length; if (n >= 9) break; await sleep(25); }
    s.eq((await st(a.page)).phase, 'saving', '룰렛(저장) 도중');
    await a.page.reload();
    await sleep(700);
    const snap = await rows();
    const n1 = snap.filter((r) => r.team).length;
    s.ok(n1 >= 9 && n1 < 29, `저장 도중에 끊김(저장된 ${n1}명)`);
    await waitView(a.page, 'menu');
    s.ok(/뽑음 \d+ \/ 29명/.test(await text(a.page, 'draw-menu-team-status')), `첫 화면 상태: ${await text(a.page, 'draw-menu-team-status')}`); // 끊긴 마지막 요청이 첫 화면을 읽은 뒤에 끝날 수 있어 숫자는 시작 화면에서 확인
    await chooseKind(a.page, 'team');
    s.ok(new RegExp(`이미\\s*${n1}명`).test(await text(a.page, 'draw-intro-summary')), `시작 화면 '이미 ${n1}명': ${await text(a.page, 'draw-intro-summary')}`);
    s.ok(new RegExp(`남은 ${29 - n1}명만`).test(await text(a.page, 'draw-keep')), `그대로 두고 단추: ${await text(a.page, 'draw-keep')}`);
    await tid(a.page, 'draw-keep').click(); await waitView(a.page, 'play');
    const r = await runAll(a.page);
    const rs = await rows();
    s.eq(r.presses, 1, '이어서 누른 횟수 1');
    s.eq(diffRows(snap.filter((x) => x.team), rs, { ids: snap.filter((x) => x.team).map((x) => x.id) }), [], '이미 저장된 사람 결과 불변');
    s.eq(rs.filter((x) => x.team).length, 29, '최종 29명 모두 팀');
    s.ok(spread(counts(rs, 'team', TEAM_ORDER)) <= 1, `최종 팀 인원 차이 ≤1: ${JSON.stringify(counts(rs, 'team', TEAM_ORDER))}`);
    s.eq(r.d.calls.pick, 29 - n1, '이어서 한 pick 수(남은 사람만)');
    s.eq(new Set(calls('pick').map((c) => c.args.p_name)).size, 29, '서버 기준 사람마다 pick 한 번(중복 없음)');
    s.eq(await finaleMap(a.page), mapOf(rs, 'team'), '전체 결과 = DB');
    s.note(`저장 ${n1}명에서 끊김 → 남은 ${29 - n1}명만 이어서`);
  });

  await scenario(6, '[전체] 전체 결과에서 새로 고침 → 같은 전체 결과가 다시 보임', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    await openLive(page); await chooseKind(page, 'team'); await startBtn(page);
    await runAll(page);
    const m1 = await finaleMap(page);
    const snap = await rows();
    resetCalls();
    await page.reload();
    await waitFinale(page);
    const d = await st(page);
    s.eq([d.view, d.kind], ['finale', 'team'], '새로 고침 뒤 전체 결과(팀) 그대로');
    s.eq(await finaleMap(page), m1, '새로 고침 전후 같은 결과');
    s.eq(await finaleMap(page), mapOf(snap, 'team'), '= DB');
    s.eq(calls('pick').length + calls('pick_room').length + calls('admin_reset').length + calls('admin_clear').length, 0, '새로 고침으로 쓰기 요청 없음');
    s.eq(diffRows(snap, await rows()), [], 'DB 불변');
    s.ok(await visible(page, 'draw-next-kind'), '전체 결과 단추 그대로');
    // 방: 끝까지 → 새로 고침 → 방 전체 결과
    await unguard(page);
    await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
    await startBtn(page); await runAll(page);
    const m2 = await finaleMap(page);
    await page.reload(); await waitFinale(page);
    s.eq((await st(page)).kind, 'room', '[방] 새로 고침 뒤 방 전체 결과');
    s.eq(await finaleMap(page), m2, '[방] 같은 결과');
    // 처음 화면으로 나가면 기억을 지움 → 새로 고침하면 첫 화면
    await unguard(page);
    await tid(page, 'draw-finale-home').click(); await waitView(page, 'menu');
    await page.reload(); await waitView(page, 'menu');
    s.eq((await st(page)).view, 'menu', '처음 화면으로 나간 뒤 새로 고침 → 첫 화면');
    // 다른 탭(새 context)은 기억이 없어 첫 화면
    const b = await newCtx({ code: true });
    await openLive(b.page);
    s.eq((await st(b.page)).view, 'menu', '다른 브라우저는 첫 화면부터');
  });

  await scenario(7, '[전체] 키 연타: 룰렛 중·자동 전환 직후 연타해도 한 번만 진행, 방 뽑기로 넘어가지 않음', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true, trace: true });
    await openLive(page); await chooseKind(page, 'team'); await startBtn(page);
    const nb = await tid(page, 'draw-next').boundingBox();
    const keys = ['Space', 'Enter', 'ArrowRight', 'PageDown'];
    let n = 0; let finAt = 0; let fb = null; let hb = null; let blockedClicks = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const m = n % 7;
      if (m === 4) await page.evaluate(() => document.querySelector('[data-testid="draw-next"]').click());
      else if (m === 5) await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2);
      else if (m === 6 && fb) { await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2); await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2); blockedClicks += 2; }
      else await page.keyboard.press(keys[n % 4]);
      n++;
      if (!finAt && (await page.evaluate(() => window.__draw.view)) === 'finale') {
        finAt = Date.now();
        fb = await tid(page, 'draw-next-kind').boundingBox(); hb = await tid(page, 'draw-finale-home').boundingBox();
      }
      if (finAt && Date.now() - finAt > 1500) break; // 자동 전환 뒤 1.5초 동안 계속 연타(보호 2.8초 안)
    }
    let d = await st(page);
    s.eq([d.view, d.kind], ['finale', 'team'], `연타 ${n}번(전체 결과 단추 좌표 클릭 ${blockedClicks}번 포함) 뒤에도 팀 전체 결과에 머묾`);
    s.eq(d.guarded, true, '자동 전환 직후에는 보호 중(guarded)');
    s.eq(await page.evaluate(() => !!(document.activeElement && document.activeElement.closest('#finaleView button'))), false, '보호 중 단추 좌표 클릭으로 전체 결과 단추에 초점이 남지 않음');
    // 보호 중: 단추에 초점을 두고 Enter·스페이스, 누르고 있는 Enter(반복)
    await page.focus('[data-testid="draw-next-kind"]');
    await page.keyboard.press('Enter'); await page.keyboard.press('Space');
    await page.keyboard.down('Enter'); await page.keyboard.down('Enter'); await page.keyboard.down('Enter'); await page.keyboard.up('Enter');
    await sleep(100);
    d = await st(page);
    s.eq([d.view, d.kind], ['finale', 'team'], '보호 중 단추 위 Enter·스페이스·반복 Enter 로도 안 넘어감');
    const tr = await traceOf(page);
    s.eq(mainPhases(tr), ['play:ready', 'play:saving', 'play:landing', 'finale:finale'], '룰렛은 한 번만(연타로 다시 시작하지 않음)');
    const rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 29, 'DB 전원 팀');
    s.eq(calls('pick').length, 29, '서버 pick 29');
    s.eq(new Set(calls('pick').map((x) => x.args.p_name)).size, 29, '같은 사람 중복 pick 없음');
    s.eq(calls('pick_room').length + calls('admin_reset').length + calls('admin_clear').length, 0, '방 뽑기·비우기 요청 없음');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '전체 결과 = DB');
    // 보호가 끝난 뒤: 초점 없는 곳에서 진행 키를 연타·꾹 눌러도 전체 결과에 머묾
    await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
    await unguard(page);
    s.eq((await st(page)).guarded, false, '보호 시간 뒤 guarded=false');
    for (let i = 0; i < 30; i++) await page.keyboard.press(keys[i % 4]);
    await page.keyboard.down('Space'); await page.keyboard.down('Space'); await page.keyboard.up('Space');
    d = await st(page);
    s.eq([d.view, d.kind], ['finale', 'team'], '보호 뒤에도 진행 키(스페이스·Enter·→·PageDown)로는 전체 결과에서 안 넘어감');
    // 단추는 정상 동작
    await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
    s.eq((await st(page)).kind, 'room', '보호 뒤 ② 방 배정 뽑기로 → 동작');
    s.note(`연타 ${n}번, 자동 전환 뒤 1.5초 동안 연타`);
  });

  await scenario(8, '[전체] 오류 처리(룰렛 중 pick 연속 실패 → 다시 시도 / 건너뛰기)', async (s) => {
    await resetRoster(db); resetCalls();
    let { page } = await newCtx({ code: true });
    let f = await failPicks(page);
    await openLive(page); await chooseKind(page, 'team');
    f.arm(3);
    await startBtn(page); await page.keyboard.press('Space');
    await waitErr(page, 30000);
    let d = await st(page);
    const X = d.current;
    s.ok(await visible(page, 'draw-error') && await visible(page, 'draw-retry') && await visible(page, 'draw-skip'), '오류 상자·다시 시도·건너뛰기');
    s.ok(await visible(page, 'draw-savebar'), '오류 때도 진행 막대 보임');
    s.eq(d.view, 'play', '오류면 전체 결과로 넘어가지 않음');
    s.eq((await rows()).filter((r) => r.team).length, 0, '실패 동안 DB 팀 0명');
    await page.keyboard.press('Space'); // 같은 사람으로 다시
    const r = await runAll(page).catch((e) => ({ e }));
    s.ok(!r.e, `다시 시도 → 전체 결과: ${r.e || ''}`);
    let rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 29, '[다시 시도] 최종 29명 팀');
    s.eq(calls('pick').filter((c) => c.args.p_name === X.name).length, 1, `[다시 시도] ${X.name} 의 서버 pick 1번`);
    s.eq(calls('pick').length, 29, '[다시 시도] 서버 pick 총 29');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[다시 시도] 전체 결과 = DB');
    // 건너뛰기
    await resetRoster(db); resetCalls();
    ({ page } = await newCtx({ code: true }));
    f = await failPicks(page);
    await openLive(page); await chooseKind(page, 'team');
    f.arm(3);
    await startBtn(page); await page.keyboard.press('Space');
    await waitErr(page, 30000);
    const Y = (await st(page)).current;
    await tid(page, 'draw-skip').click();
    await waitFinale(page);
    rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 28, '[건너뛰기] 28명 저장 후 전체 결과');
    const note = await text(page, 'draw-finale-note');
    s.ok(/아직 안 뽑은 사람 1명/.test(note) && note.includes(Y.name), `[건너뛰기] 안내: ${note}`);
    s.ok(/아직 안 뽑은 사람이 있어요/.test(await text(page, 'draw-finale-title')), `[건너뛰기] 축하 대신 안내 제목: ${await text(page, 'draw-finale-title')}`);
    await unguard(page);
    await tid(page, 'draw-continue').click(); await waitView(page, 'intro');
    await tid(page, 'draw-keep').click(); await waitView(page, 'play');
    await runAll(page);
    rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 29, '[건너뛰기] 이어서 뽑아 29명');
    s.eq(new Set(calls('pick').map((c) => c.args.p_name)).size, 29, '[건너뛰기] 같은 사람 중복 요청 없음');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[건너뛰기] 전체 결과 = DB');
  });

  await scenario(9, '[전체] 연습 모드(같은 진행, DB 요청 0건)', async (s) => {
    await resetRoster(db); resetCalls();
    const before = await rows();
    const { page, guard } = await newCtx({ trace: true });
    await openLive(page, '?practice=1'); // 연습 모드도 입구를 지남(확인용 board_state 읽기 한 번)
    s.eq([(await st(page)).mode, (await st(page)).unit], ['practice', 'all'], '연습·전체 한 번에');
    s.ok(await visible(page, 'draw-practice-badge'), "'연습' 표시");
    await chooseKind(page, 'team');
    s.ok(/전체 30명/.test(await text(page, 'draw-intro-summary')), `요약: ${await text(page, 'draw-intro-summary')}`);
    await startBtn(page);
    let r = await runAll(page);
    s.eq(r.presses, 1, '[팀] 누른 횟수 1');
    const tr = await traceOf(page);
    s.ok(phasesOf(tr).includes('play:landing'), '[팀] 룰렛 → 멈춤 → 전체 결과');
    const names = await page.evaluate(() => [...document.querySelectorAll('[data-testid="draw-finale-board"] li .nm')].map((x) => x.textContent));
    s.eq(names.length, 30, '[팀] 전체 결과 30명');
    s.ok(names.every((n) => /^견본 /.test(n)), '[팀] 견본 이름만');
    s.ok(/연습/.test(await text(page, 'draw-finale-title')), '[팀] 제목에 연습 표시');
    s.note(`[연습·팀] 누름~전체 결과 ${r.ms}ms`);
    await unguard(page);
    await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
    s.ok(await visible(page, 'draw-nogender'), '[방] 성별 없는 견본 안내');
    await startBtn(page);
    r = await runAll(page);
    s.eq(r.presses, 1, '[방] 누른 횟수 1');
    s.eq((await st(page)).revealed, 29, '[방] 전체 결과 29명(성별 없는 1명 빼고)');
    s.eq(r.d.calls, { board_state: 0, pick: 0, pick_room: 0, admin_reset: 0, admin_clear: 0 }, '화면 안 DB 호출 기록 0');
    // 새로 고침하면 처음으로(연습은 기억하지 않음)
    await page.reload(); await waitView(page, 'menu');
    s.ok(/뽑음 0 \/ 30명/.test(await text(page, 'draw-menu-team-status')), `새로 고침 뒤 처음으로: ${await text(page, 'draw-menu-team-status')}`);
    s.eq(server.calls.map((c) => c.fn), ['board_state', 'board_state'], '서버가 받은 rpc 는 입구 확인 board_state 뿐(처음 + 새로 고침 뒤 다시 확인)');
    s.eq(guard.proxied.filter((u) => !/\/rpc\/board_state$/.test(String(u.url || u))).length, 0, '브라우저가 supabase 로 보낸 요청은 입구 확인뿐');
    s.eq(diffRows(before, await rows()), [], 'DB 변화 0');
    s.eq(await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.startsWith('draw-') || k === 'team-picker-admin')), ['draw-gate'], '연습 모드가 남기는 것은 이 탭의 입구 기억(sessionStorage)뿐');
  });

  await scenario(10, '[전체] 움직임 줄이기(reducedMotion: reduce)', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true, reducedMotion: 'reduce', trace: true });
    await openLive(page);
    s.eq((await st(page)).reduced, true, '__draw.reduced');
    await chooseKind(page, 'team'); await startBtn(page);
    let r = await runAll(page);
    s.eq(r.presses, 1, '[팀] 누른 횟수 1');
    let rs = await rows();
    s.eq(rs.filter((x) => x.team).length, 29, '[팀] DB 전원 팀');
    s.eq(await finaleMap(page), mapOf(rs, 'team'), '[팀] 전체 결과 = DB');
    const tr = await traceOf(page);
    s.ok(!tr.some((t) => t.ph === 'landing'), '[팀] 느려지는 연출(landing) 없음');
    s.ok(!(await page.evaluate(() => document.getElementById('finaleBoard').classList.contains('enter'))), '[팀] 채워지는 연출 없음');
    s.ok(r.ms < MIN_MS, `[팀] 최소 룰렛 시간 없이 바로(${r.ms}ms)`);
    s.note(`[팀] 움직임 줄이기 누름~전체 결과 ${r.ms}ms`);
    await unguard(page);
    await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
    await startBtn(page);
    r = await runAll(page);
    rs = await rows();
    s.eq(rs.filter((x) => x.room).length, 29, '[방] DB 전원 방');
    s.eq(await finaleMap(page), mapOf(rs, 'room'), '[방] 전체 결과 = DB');
  });


  // ══ 16~19: 검수 지적 반영 확인 ═══════════════════════════
  await scenario(16, '[전체] 시작 화면에서 Enter 두 번(80·400ms) → 저장 0건, 보호 시간 뒤에는 정상 시작', async (s) => {
    for (const gap of [80, 400]) {
      await resetRoster(db); resetCalls();
      const { page } = await newCtx({ code: true });
      await openLive(page); await chooseKind(page, 'team');
      await sleep(800); // 시작 화면 보호(0.7초)가 끝난 뒤
      s.eq(await page.evaluate(() => document.activeElement && document.activeElement.dataset.testid), 'draw-start', `[${gap}ms] 초점은 시작하기`);
      await page.keyboard.press('Enter'); await sleep(gap); await page.keyboard.press('Enter');
      await sleep(1200);
      const d = await st(page);
      s.eq([d.view, d.phase], ['play', 'ready'], `[${gap}ms] 두 번째 Enter 는 무시 → 뽑는 화면 준비 상태`);
      s.eq(calls('pick').length + d.calls.pick, 0, `[${gap}ms] 저장(pick) 0건`);
      s.eq((await rows()).filter((r) => r.team).length, 0, `[${gap}ms] DB 팀 0명`);
      await page.keyboard.press('Enter'); // 보호 시간이 지난 뒤
      await wait(page, () => window.__draw.phase === 'saving' || window.__draw.view === 'finale');
      s.ok(true, `[${gap}ms] 보호 시간 뒤 누르면 룰렛 시작`);
      await waitFinale(page);
      s.eq((await rows()).filter((r) => r.team).length, 29, `[${gap}ms] 끝까지 29명`);
    }
  });

  await scenario(17, '[전체] 전체 결과를 띄운 뒤 다른 곳에서 비우고 새로 고침(전부 비움 → 첫 화면 / 일부 비움 → 안내 제목)', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    await openLive(page); await chooseKind(page, 'team'); await startBtn(page);
    await runAll(page);
    s.ok(/^🎉/.test(await text(page, 'draw-finale-title')), `다 뽑으면 축하 제목: ${await text(page, 'draw-finale-title')}`);
    // 일부(1명) 비움 → 같은 탭 새로 고침 → 전체 결과 + 안내 제목
    await db.query('update public.people set team = null, picked_at = null where id = 3');
    await page.reload(); await waitFinale(page);
    let t = await text(page, 'draw-finale-title');
    s.ok(/아직 안 뽑은 사람이 있어요/.test(t) && !/🎉|모두 정해졌/.test(t), `한 명 비운 뒤 제목: ${t}`);
    s.ok(/아직 안 뽑은 사람 1명/.test(await text(page, 'draw-finale-note')), `안내: ${await text(page, 'draw-finale-note')}`);
    s.ok(await visible(page, 'draw-continue'), '남은 1명 이어서 뽑기 단추');
    await shot(page, '1280', 'b01_finale_reopen_one_left');
    // 전부 비움(관리자 페이지의 비우기 흉내) → 새로 고침 → 첫 화면, 기억 지움
    await db.query('update public.people set team = null, picked_at = null');
    await page.reload(); await waitView(page, 'menu');
    s.eq((await st(page)).view, 'menu', '결과가 하나도 없으면 빈 판 대신 첫 화면');
    s.eq(await page.evaluate(() => sessionStorage.getItem('draw-finale')), null, '다시 열기 기억 지움');
    await page.reload(); await waitView(page, 'menu');
    s.eq((await st(page)).view, 'menu', '다시 새로 고쳐도 첫 화면');
  });

  await scenario(18, '[전체] 마지막 한 명을 건너뛰면 기다리지 않고 바로 전체 결과', async (s) => {
    await resetRoster(db); await drawEveryone('team');
    await db.query("update public.people set team = null, picked_at = null where id = (select min(id) from public.people)");
    resetCalls();
    const { page } = await newCtx({ code: true });
    const f = await failPicks(page);
    await openLive(page); await chooseKind(page, 'team');
    s.ok(/남은 1명만/.test(await text(page, 'draw-keep')), `그대로 두고 단추: ${await text(page, 'draw-keep')}`);
    await tid(page, 'draw-keep').click(); await waitView(page, 'play');
    f.arm(3);
    await page.keyboard.press('Space');
    await waitErr(page, 30000);
    const t0 = Date.now();
    await tid(page, 'draw-skip').click();
    await waitFinale(page);
    const ms = Date.now() - t0;
    s.ok(ms < 1500, `건너뛴 뒤 전체 결과까지 ${ms}ms(< 1500, 룰렛 최소 시간·멈추기 없음)`);
    s.ok(/아직 안 뽑은 사람이 있어요/.test(await text(page, 'draw-finale-title')), `제목: ${await text(page, 'draw-finale-title')}`);
    s.ok(/아직 안 뽑은 사람 1명/.test(await text(page, 'draw-finale-note')), `안내: ${await text(page, 'draw-finale-note')}`);
    s.eq((await rows()).filter((r) => r.team).length, 28, 'DB 28명(건너뛴 1명 그대로)');
    await shot(page, '1280', 'b02_finale_after_skip_last');
    s.note(`건너뛰기 → 전체 결과 ${ms}ms`);
  });

  await scenario(19, '[전체] 빠르게 도는 동안 가짜 짝 없음 + 진행 숫자 하나만', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    let first = true;
    await page.route(/\/rpc\/pick_room$/, async (r) => { if (first) { first = false; await sleep(2500); } r.fallback(); }); // 처음 2.5초 동안 아무도 안 정해짐
    await openLive(page); await chooseKind(page, 'room'); await startBtn(page);
    await page.keyboard.press('Space');
    await wait(page, () => window.__draw.phase === 'saving');
    s.ok(!(await visible(page, 'draw-progress')), '룰렛 중 위쪽 진행 숫자 없음(진행 막대만)');
    s.ok(await visible(page, 'draw-savebar'), '진행 막대 보임');
    let samples = 0; let fake = 0; let wrongGender = 0;
    for (let i = 0; i < 15; i++) {
      const o = await page.evaluate(() => {
        const name = document.getElementById('slotName').textContent;
        const on = [...document.querySelectorAll('#wheel .opt.on')].map((x) => x.dataset.key);
        const maybe = [...document.querySelectorAll('#wheel .opt.maybe')].map((x) => x.dataset.key);
        return { name, on, maybe, done: window.__draw.saveDone };
      });
      if (o.done === 0) { samples++; if (o.on.length) fake++; if (o.maybe.length && !(o.maybe.every((k) => k[0] === 'm') || o.maybe.every((k) => k[0] === 'f'))) wrongGender++; }
      await sleep(120);
    }
    s.ok(samples >= 8, `아무도 안 정해진 동안 표본 ${samples}개`);
    s.eq(fake, 0, '아직 안 정한 사람에게 밝은(정해진 것 같은) 칸 없음');
    s.eq(wrongGender, 0, '옅게 켜지는 칸은 그 사람 성별의 방만');
    // 느려질 때는 실제 결과(맛보기)
    await wait(page, () => window.__draw.phase === 'landing');
    const rs = await rows();
    let checked = 0; let wrong = 0;
    for (let i = 0; i < 6; i++) {
      const o = await page.evaluate(() => ({ name: document.getElementById('slotName').textContent, on: [...document.querySelectorAll('#wheel .opt.on')].map((x) => x.dataset.key), ph: window.__draw.phase }));
      if (o.ph !== 'landing') break;
      const r = rs.find((x) => x.name === o.name);
      if (r && o.on.length) { checked++; if (o.on[0] !== r.room || o.on.length !== 1) wrong++; }
      await sleep(180);
    }
    s.ok(checked >= 2 && wrong === 0, `느려질 때 이름·칸 짝 = DB 결과(${checked}개 확인, 틀림 ${wrong})`);
    await waitFinale(page);
  });

  // ── 화면 크기 · 캡처 · 이름 잘림 ─────────────────────────
  // 긴 이름(명단 이름은 띄어쓰기 없이 저장됨: norm_name). 남자 칸·여자 칸(id 9 = 여) 모두에 들어가게
  const LONG = [[1, '견본남궁가나다라'], [2, '견본알렉산드라김'], [5, '견본제갈가나다'], [9, '견본황보다라마바사'], [14, '견본선우가나'], [20, '견본마리아테레사']];
  async function longNames() { for (const [id, n] of LONG) await db.query('update public.people set name = $2 where id = $1', [id, n]); }
  /** 전체 결과의 이름이 잘리지 않고(가로·세로) 읽힐 만큼 큰지 */
  async function finaleReadable(s, page, label) {
    const r = await page.evaluate(() => {
      const stage = document.getElementById('stage').getBoundingClientRect();
      const out = { clipped: [], minPx: 1e9, minName: '', count: 0, u: stage.width / 100 };
      for (const li of document.querySelectorAll('#finaleBoard li')) {
        const nm = li.querySelector('.nm'); const g = li.closest('.grp');
        const a = nm.getBoundingClientRect(); const b = li.getBoundingClientRect(); const c = g.getBoundingClientRect();
        out.count++;
        if (nm.scrollWidth > nm.clientWidth + 1 || a.right > b.right + 1 || a.bottom > c.bottom + 1 || a.right > c.right + 1) out.clipped.push(nm.textContent);
        const px = parseFloat(getComputedStyle(nm).fontSize);
        if (px < out.minPx) { out.minPx = px; out.minName = nm.textContent; }
      }
      return out;
    });
    s.eq(r.clipped, [], `${label}: 잘린 이름 없음`);
    s.ok(r.minPx >= r.u * 1.4, `${label}: 가장 작은 이름 글자 ${r.minPx.toFixed(1)}px(무대 너비의 ${(r.minPx / r.u).toFixed(2)}%, '${r.minName}') ≥ 1.4%`);
    return r;
  }

  for (const [w, h] of [[1920, 1080], [1280, 720]]) {
    await scenario(11, `[전체] 화면 크기 ${w}×${h}: 장면별 캡처·넘침·이름 잘림 점검`, async (s) => {
      const vp = String(w);
      const viewport = { width: w, height: h };
      const sizes = [];
      // 첫 화면 · 시작 · 준비 · 룰렛 · 멈춤 · 전체 결과(팀)
      await resetRoster(db);
      let c = await newCtx({ viewport, code: true });
      const p = c.page;
      await delayPicks(p, 140);
      await openLive(p);
      await shot(p, vp, 'a01_menu');
      await chooseKind(p, 'team');
      await shot(p, vp, 'a02_intro_team');
      await startBtn(p);
      await shot(p, vp, 'a03_play_ready');
      await p.keyboard.press('Space');
      await wait(p, () => window.__draw.phase === 'saving'); await sleep(1200);
      await shot(p, vp, 'a04_roulette_saving', true);
      await wait(p, () => window.__draw.phase === 'landing'); await sleep(500);
      await shot(p, vp, 'a05_roulette_landing', true);
      await waitFinale(p);
      await shot(p, vp, 'a06_finale_team');
      sizes.push(['팀 29명', await finaleReadable(s, p, '팀 29명')]);
      // 방
      await unguard(p);
      await tid(p, 'draw-next-kind').click(); await waitView(p, 'intro');
      await shot(p, vp, 'a07_intro_room');
      await startBtn(p); await p.keyboard.press('Space');
      await wait(p, () => window.__draw.phase === 'saving'); await sleep(1200);
      await shot(p, vp, 'a08_room_roulette', true);
      await waitFinale(p);
      await shot(p, vp, 'a09_finale_room');
      sizes.push(['방 29명', await finaleReadable(s, p, '방 29명')]);
      // 전원 이미 뽑음(시작 화면 안내) · 모두 비우기 상자
      c = await newCtx({ viewport, code: true });
      const p2 = c.page;
      await openLive(p2); await chooseKind(p2, 'team');
      await shot(p2, vp, 'a10_intro_all_drawn');
      await tid(p2, 'draw-clear').click(); await wait(p2, () => window.__draw.dialog === 'clear');
      await shot(p2, vp, 'a11_dialog_clear');
      await tid(p2, 'draw-dialog-cancel').click(); await wait(p2, () => window.__draw.dialog === null);
      await tid(p2, 'draw-show-result').click(); await waitFinale(p2);
      await shot(p2, vp, 'a12_finale_all_drawn_direct');
      // 긴 이름 + 성별 없음 + 이미 뽑은 사람 섞임
      await resetRoster(db, { picked: true, noGender: true }); await longNames();
      c = await newCtx({ viewport, code: true });
      const p3 = c.page;
      await openLive(p3); await chooseKind(p3, 'team');
      await tid(p3, 'draw-keep').click(); await waitView(p3, 'play');
      await shot(p3, vp, 'a13_play_ready_keep');
      await runAll(p3);
      await shot(p3, vp, 'a14_finale_team_long_names');
      sizes.push(['팀 긴 이름', await finaleReadable(s, p3, '팀 긴 이름')]);
      await unguard(p3);
      await tid(p3, 'draw-next-kind').click(); await waitView(p3, 'intro');
      await shot(p3, vp, 'a15_intro_room_nogender');
      await tid(p3, 'draw-keep').click(); await waitView(p3, 'play');
      await runAll(p3);
      await shot(p3, vp, 'a16_finale_room_long_names_note');
      sizes.push(['방 긴 이름', await finaleReadable(s, p3, '방 긴 이름')]);
      // 연습 모드(30명, '견본 고슴도치' 등)
      c = await newCtx({ viewport });
      const p4 = c.page;
      await openLive(p4, '?practice=1');
      await shot(p4, vp, 'a17_practice_menu');
      await chooseKind(p4, 'team'); await startBtn(p4); await runAll(p4);
      await shot(p4, vp, 'a18_practice_finale_team');
      sizes.push(['연습 팀 30명', await finaleReadable(s, p4, '연습 팀 30명')]);
      await unguard(p4);
      await tid(p4, 'draw-next-kind').click(); await waitView(p4, 'intro'); await startBtn(p4); await runAll(p4);
      await shot(p4, vp, 'a19_practice_finale_room');
      sizes.push(['연습 방 29명', await finaleReadable(s, p4, '연습 방 29명')]);
      // 오류 상자(룰렛 중)
      await resetRoster(db);
      c = await newCtx({ viewport, code: true });
      const p5 = c.page;
      const f = await failPicks(p5);
      await openLive(p5); await chooseKind(p5, 'team'); f.arm(3);
      await startBtn(p5); await p5.keyboard.press('Space'); await waitErr(p5, 30000);
      await shot(p5, vp, 'a20_error_box');
      // 남긴 방법(한 팀·한 방씩 / 한 명씩): 첫 화면의 공개 방법 줄 · 마지막 장면 모양(결과판 글자 맞춤이 같이 바뀌었으므로)
      await resetRoster(db);
      c = await newCtx({ viewport, code: true });
      const p6 = c.page;
      await openLive(p6, '?unit=group');
      await shot(p6, vp, 'a21_menu_unit_group');
      await chooseKind(p6, 'team'); await startBtn(p6);
      await p6.keyboard.press('Space'); await waitReady(p6);
      await shot(p6, vp, 'a22_group_reveal_red');
      await tid(p6, 'draw-all').click(); await wait(p6, () => window.__draw.dialog === 'all'); await sleep(600);
      await tid(p6, 'draw-dialog-ok').click(); await waitFinale(p6); await sleep(600);
      await shot(p6, vp, 'a23_group_finale_team');
      await resetRoster(db, { picked: true });
      c = await newCtx({ viewport, code: true });
      const p7 = c.page;
      await openLive(p7, '?unit=person'); await chooseKind(p7, 'team');
      await tid(p7, 'draw-keep').click(); await waitView(p7, 'play');
      await p7.keyboard.press('Space'); await waitReady(p7);
      await shot(p7, vp, 'a24_person_result');
      s.note(`${vp}: 이름 글자(무대 너비 %) ${sizes.map(([k, r]) => `${k} 최소 ${(r.minPx / r.u).toFixed(2)}`).join(', ')}`);
    });
  }

  // ── 룰렛 → 전체 결과로 넘어가는 순간 연속 캡처(1920×1080) ──────
  await scenario(12, '[전체] 룰렛 → 전체 결과 전환 연속 캡처(팀·방, 1920×1080)', async (s) => {
    await resetRoster(db);
    const { page } = await newCtx({ viewport: { width: 1920, height: 1080 }, code: true });
    await delayPicks(page, 60);
    await openLive(page);
    for (const kind of ['team', 'room']) {
      const dir = join(SHOTS, `transition-${kind}`);
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      if (kind === 'team') await chooseKind(page, 'team');
      else { await unguard(page); await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro'); }
      await startBtn(page);
      await page.keyboard.press('Space');
      const t0 = Date.now();
      await wait(page, () => window.__draw.phase === 'saving');
      const files = [];
      const snapNow = async () => {
        const d = await st(page);
        const f = join(dir, `${String(files.length + 1).padStart(2, '0')}_${d.view === 'finale' ? 'finale' : d.phase}_${((Date.now() - t0) / 1000).toFixed(1)}s.png`);
        await page.screenshot({ path: f }); files.push(f); shotFiles.push(f);
      };
      await sleep(900); await snapNow(); // 룰렛(저장 중)
      await wait(page, () => window.__draw.phase === 'landing');
      let finAt = 0;
      while (files.length < 14) {
        await snapNow();
        const d = await st(page);
        if (d.view === 'finale' && !finAt) finAt = Date.now();
        if (finAt && Date.now() - finAt > 2300) break;
        await sleep(d.view === 'finale' ? 180 : 230);
      }
      await settle(page); await snapNow(); // 연출이 다 끝난 모습
      s.ok(files.length >= 8 && files.length <= 16, `[${kind}] 연속 캡처 ${files.length}장`);
      s.ok(files.some((f) => /_landing_/.test(f)) && files.some((f) => /_finale_/.test(f)), `[${kind}] 멈춤·전체 결과 장면 모두 포함`);
      s.note(`[${kind}] ${dir} (${files.length}장)`);
    }
  });

  // ══ 13. 권한 없음 + 참가자 화면 ═══════════════════════
  await scenario(13, '입구: 비밀번호 없이/틀린 비밀번호/관리자 페이지에 들어간 기기·링크 + 참가자 화면', async (s) => {
    await resetRoster(db); resetCalls();
    const forbidden = () => server.calls.filter((c) => ['pick', 'pick_room'].includes(c.fn) || c.fn.startsWith('admin_'));
    let { page } = await newCtx();
    await page.goto(`${server.url}/draw.html`);
    await waitView(page, 'login');
    s.ok(await visible(page, 'draw-login'), '비밀번호 화면');
    s.eq(await tid(page, 'draw-menu').count(), 0, '첫 화면은 문서에도 없음');
    s.eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'code', '처음 초점은 비밀번호 칸');
    for (const k of ['Enter', 'Space', 'Enter', 'ArrowRight', 'PageDown', 'Enter']) await page.keyboard.press(k); // 빈 칸(공백만)에서 Enter: 요청 없이 안내만
    s.ok(/넣어 주세요/.test(await text(page, 'draw-login-error')), `빈 칸 Enter 안내: ${await text(page, 'draw-login-error')}`);
    await tid(page, 'draw-code').fill('');
    await page.locator('body').click({ position: { x: 5, y: 5 } }); // 칸 밖에서 진행 키
    for (const k of ['Digit1', 'Digit2', 'Space', 'Enter', 'ArrowRight', 'PageDown']) await page.keyboard.press(k);
    await sleep(200);
    s.eq((await st(page)).view, 'login', '키를 눌러도 비밀번호 화면 그대로');
    s.eq(server.calls.length, 0, '비밀번호 없이 열었을 때 rpc 요청 0건');
    // 틀린 비밀번호
    await tid(page, 'draw-code').fill('틀린-비밀번호');
    await tid(page, 'draw-login-submit').click();
    await wait(page, () => window.__draw.view === 'login' && !window.__draw.busy && window.__draw.gate === 'wrong');
    s.ok(/맞지 않아요/.test(await text(page, 'draw-login-error')), `틀린 비밀번호 안내: ${await text(page, 'draw-login-error')}`);
    s.eq((await st(page)).view, 'login', '틀린 비밀번호는 거절');
    s.eq(await page.evaluate(() => [localStorage.getItem('team-picker-admin'), sessionStorage.getItem('draw-gate')]), [null, null], '틀린 비밀번호는 어디에도 저장 안 됨');
    s.eq(forbidden().length, 0, '틀린 비밀번호 뒤 pick/pick_room/admin_* 요청 0건');
    s.eq(server.calls.map((c) => `${c.fn}:${c.status}`), ['board_state:400'], '서버가 받은 요청은 확인 한 건(거절)');
    await page.keyboard.press('Escape');
    for (const k of ['Digit1', 'Digit2', 'Space']) await page.keyboard.press(k);
    s.eq((await st(page)).view, 'login', '틀린 뒤에도 키로 못 들어감');
    // 관리자 페이지에 들어간 적 있는 기기(localStorage 에 맞는 비밀번호): 그래도 입구가 나오고, draw.js 는 그 키를 읽지도 쓰지도 않음
    const w = await newCtx({ code: true });
    await w.ctx.addInitScript(() => { // localStorage 접근 기록
      const L = Storage.prototype; window.__ls = [];
      for (const m of ['getItem', 'setItem', 'removeItem']) { const f = L[m]; L[m] = function (...a) { if (this === window.localStorage) window.__ls.push(`${m}:${a[0]}`); return f.apply(this, a); }; }
    });
    resetCalls();
    await w.page.goto(`${server.url}/draw.html`);
    await waitView(w.page, 'login'); await sleep(300);
    s.eq((await st(w.page)).gate, 'idle', '[저장된 비밀번호] 입구가 나옴(저절로 안 들어감)');
    s.eq(server.calls.length, 0, '[저장된 비밀번호] 요청 0건');
    s.eq(await w.page.evaluate(() => window.__ls.filter((x) => x.endsWith(':team-picker-admin'))), [], '[저장된 비밀번호] draw.js 가 team-picker-admin 을 읽지도 쓰지도 않음');
    await enterGate(w.page); await waitView(w.page, 'menu');
    await w.page.reload(); await waitView(w.page, 'menu');
    s.eq(await w.page.evaluate(() => window.__ls.filter((x) => x.endsWith(':team-picker-admin'))), [], '[들어간 뒤·새로 고침 뒤에도] team-picker-admin 접근 0');
    s.eq(await w.page.evaluate(() => JSON.parse(localStorage.getItem('team-picker-admin'))), ADMIN_CODE, '[저장된 비밀번호] 관리자 페이지 값은 그대로');
    // 맞는 비밀번호로 들어감
    resetCalls();
    await tid(page, 'draw-code').fill(ADMIN_CODE);
    await tid(page, 'draw-login-submit').click();
    await waitView(page, 'menu');
    s.eq(await page.evaluate(() => [localStorage.getItem('team-picker-admin'), sessionStorage.getItem('draw-gate')]), [null, ADMIN_CODE], '맞는 비밀번호는 이 탭 sessionStorage 에만(localStorage 에는 안 씀)');
    s.eq(server.calls.map((c) => `${c.fn}:${c.status}`), ['board_state:200'], '들어갈 때 요청은 확인 한 건(그 명단으로 첫 화면)');
    s.eq(forbidden().length, 0, '로그인만으로 쓰기 요청 없음');
    // 새로 고침: 같은 탭이면 다시 묻지 않음(서버에 다시 확인)
    resetCalls();
    await page.reload(); await waitView(page, 'menu');
    s.ok(!(await visible(page, 'draw-login')), '같은 탭 새로 고침은 다시 묻지 않음');
    s.eq(server.calls.map((c) => c.fn), ['board_state'], '새로 고침 뒤 서버에 다시 확인 한 번');

    // 관리자 페이지에 들어간 뒤 그 페이지의 발표용 뽑기 링크로 와도 입구가 나옴
    const bctx = await newCtx();
    bctx.page.on('dialog', (d) => d.accept());
    await bctx.page.goto(`${server.url}/board.html`);
    await bctx.page.locator('#code').fill(ADMIN_CODE);
    await bctx.page.locator('#codeForm button[type=submit]').click();
    await bctx.page.locator('#glanceBody tr').first().waitFor({ timeout: 10000 });
    await bctx.page.locator('#drawLink').click();
    await bctx.page.waitForURL(/draw\.html/);
    await waitView(bctx.page, 'login');
    s.eq((await st(bctx.page)).gate, 'idle', '관리자 페이지 링크로 와도 입구');
    s.eq(await tid(bctx.page, 'draw-menu').count(), 0, '관리자 페이지 링크로 와도 첫 화면 DOM 없음');
    s.eq(await bctx.page.evaluate(() => JSON.parse(localStorage.getItem('team-picker-admin'))), ADMIN_CODE, '관리자 페이지의 비밀번호 저장은 그대로');

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

  // ══ 14. 관리자 페이지 회귀 ════════════════════════════
  await scenario(14, '관리자 페이지(board.html) 회귀: 발표 화면 링크·명단·자동으로 나누기', async (s) => {
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
    s.ok(await page.locator('#roomAuto').isVisible(), '객실표를 펴면 방 전부 새로 섞기 단추 보임');
    page.once('dialog', (d) => d.accept()); // 자동 섞기는 확인을 한 번만 받음(뒤 단계의 뜻밖의 확인 상자는 받지 않음)
    await page.locator('#roomAuto').click();
    await wait(page, () => document.getElementById('roomMsg').textContent.length > 0, null, 15000);
    s.ok(/남녀 따로/.test(await page.locator('#roomMsg').innerText()), `자동으로 나누기 안내: ${await page.locator('#roomMsg').innerText()}`);
    const rs = await rows();
    const men = counts(rs, 'room', ['m1', 'm2', 'm3', 'm4', 'm5']); const women = counts(rs, 'room', ['f1', 'f2']);
    s.eq(rs.filter((x) => x.room).length, 29, '자동으로 나누기: 전원 방');
    s.ok(spread(men) <= 1 && spread(women) <= 1, `자동으로 나누기 인원 차이 ≤1: 남 ${JSON.stringify(men)} 여 ${JSON.stringify(women)}`);
    s.eq(rs.filter((x) => x.room[0] !== (x.gender === '남' ? 'm' : 'f')).length, 0, '자동으로 나누기: 성별 섞임 0');
    // 링크로 가도 입구가 나오고, 비밀번호를 넣어야 열림
    await link.click();
    await page.waitForURL(/draw\.html/);
    await waitView(page, 'login');
    s.eq((await st(page)).gate, 'idle', '관리자 페이지 링크로 와도 입구');
    s.eq(await enterGate(page), true, '비밀번호를 직접 넣어야 열림');
    await waitView(page, 'menu');
    s.ok(/뽑음 0 \/ 29명/.test(await text(page, 'draw-menu-team-status')) && /29 \/ 29명|모두 뽑았어요/.test(await text(page, 'draw-menu-room-status')), `링크로 들어간 첫 화면 상태: 팀 ${await text(page, 'draw-menu-team-status')} / 방 ${await text(page, 'draw-menu-room-status')}`);
    s.ok(await visible(page, 'draw-to-board'), '첫 화면에 관리자 페이지로 돌아가는 링크');
  });

  // ══ 15. 키 · 단추 · 공개 방법 고르기(주소) ═══════════════
  await scenario(15, '키: M 소리, F 전체 화면, 첫 화면 1·2, 처음 화면 단추 + 공개 방법(주소 ?unit=)', async (s) => {
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
    // 공개 방법: 기본(전체 한 번에)은 첫 화면에 따로 안 보이고, 주소로 다른 방법을 골랐을 때만 지금 방법·되돌리기 링크가 보임
    await tid(page, 'draw-home').click(); await waitView(page, 'menu');
    s.eq((await st(page)).unit, 'all', '기본 = 전체 한 번에');
    s.ok(!(await visible(page, 'draw-unit-line')), '기본이면 공개 방법 줄 없음');
    for (const [q, u, label] of [['?unit=group', 'group', '한 팀·한 방씩'], ['?unit=person', 'person', '한 명씩'], ['?unit=all', 'all', null], ['?unit=xyz', 'all', null]]) {
      await openLive(page, q);
      s.eq((await st(page)).unit, u, `${q} → unit ${u}`);
      if (label) {
        s.ok(await visible(page, 'draw-unit-line') && (await text(page, 'draw-unit-name')) === label, `${q}: 첫 화면에 '공개 방법: ${label}'`);
        s.eq(await tid(page, 'draw-unit-reset').getAttribute('href'), 'draw.html?unit=all', `${q}: 기본으로 되돌리기 링크`);
        s.ok((await tid(page, 'draw-to-practice').getAttribute('href')).includes(`unit=${u}`), `${q}: 연습 모드 링크도 같은 방법`);
      } else s.ok(!(await visible(page, 'draw-unit-line')), `${q}: 공개 방법 줄 없음`);
    }
    await openLive(page, '?unit=person');
    await tid(page, 'draw-unit-reset').click(); await waitView(page, 'menu');
    s.eq((await st(page)).unit, 'all', '되돌리기 링크 → 전체 한 번에');
    s.eq(diffRows(before, await rows()), [], '키·단추 확인 동안 DB 불변');
    s.eq(server.calls.filter((c) => c.fn !== 'board_state').length, 0, 'board_state 말고는 요청 없음');
  });

  // ════════════════════════════════════════════════════════════════
  // 남겨 둔 공개 방법(?unit=group 한 팀·한 방씩 / ?unit=person 한 명씩) 회귀
  // ════════════════════════════════════════════════════════════════
  // ══ 21. 처음부터 끝까지(팀, 한 팀씩) ═══════════════════
  await scenario(21, '[한 팀씩] 처음부터 끝까지(팀, 빈 명단)', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    await openLive(page, G);
    s.eq([(await st(page)).mode, (await st(page)).unit], ['live', 'group'], '모드·공개 방법(주소 ?unit=group)');
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

  // ══ 23. (한 팀씩) 중간 새로 고침 ═════════════════════════════════
  await scenario(23, '[한 팀씩] 중간 새로 고침(저장 도중 / 공개 도중 / 다른 브라우저)', async (s) => {
    // 3-a 저장 도중
    await resetRoster(db); resetCalls();
    const a = await newCtx({ code: true });
    await a.page.route(/\/rpc\/pick$/, async (r) => { await sleep(120); r.fallback(); }); // 저장이 천천히 되게(중간에 끊기 쉽게)
    await openLive(a.page, G); await chooseKind(a.page, 'team');
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
    await openLive(b.page, G); await chooseKind(b.page, 'team'); await startBtn(b.page);
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
    await openLive(c.page, G); await chooseKind(c.page, 'team');
    s.ok(!(await visible(c.page, 'draw-resume')) && await visible(c.page, 'draw-show-result'), '다른 브라우저는 이어서 공개 없음, 첫 팀부터');
    await tid(c.page, 'draw-show-result').click(); await waitView(c.page, 'play');
    s.eq((await st(c.page)).revealed, 0, '처음부터 공개: 결과판 비어 있음');
    const r3 = await playAll(c.page);
    s.eq(r3.presses, 5, '처음부터 공개 누른 횟수');
    s.eq(r3.d.calls.pick, 0, '재공개는 pick 요청 없음');
  });

  // ══ 24. (한 팀씩·한 명씩) 연타 ══════════════════════════════════════════
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

  await scenario(24, '[한 팀씩·한 명씩] 연타(키·단추 수십 번, 모두 공개 연타)', async (s) => {
    // 4-a 팀, 한 팀씩
    await resetRoster(db); resetCalls();
    let { page } = await newCtx({ code: true, trace: true });
    await openLive(page, G); await chooseKind(page, 'team'); await startBtn(page);
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
    await openLive(page, G); await chooseKind(page, 'room'); await startBtn(page);
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
    await openLive(page, G); await chooseKind(page, 'team'); await startBtn(page);
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
  await scenario(24.5, '[한 팀씩] 확인 상자가 열린 상태에서 스페이스·Enter(관찰)', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    await openLive(page, G); await chooseKind(page, 'team'); await startBtn(page);
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
  await scenario(24.6, '[한 팀씩] 마우스 연속 클릭(마지막 장면 보기 → 마지막 장면에 머묾, 첫 화면 카드 → 시작 화면에 머묾)', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx({ code: true });
    await openLive(page, G); await chooseKind(page, 'team'); await startBtn(page);
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
      s.eq([d.view, d.kind], ['finale', 'team'], `[${gap}ms] 마지막 장면 보기를 두 번 눌러도 마지막 장면(팀)에 머묾`);
      s.eq(calls('pick_room').length + calls('admin_clear').length + calls('admin_reset').length, 0, `[${gap}ms] 쓰기 요청 없음`);
    }
    // 보호 시간이 지나면 마지막 장면 단추가 정상 동작
    await sleep(1700);
    s.eq((await st(page)).guarded, false, '보호 시간 뒤 guarded=false');
    await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
    s.eq((await st(page)).kind, 'room', '보호 시간 뒤에는 ② 방 배정 뽑기로 → 가 동작');
    // 첫 화면 카드를 여러 번 클릭(좌표): 시작 화면에서 멈춰야 함(시작 화면의 주 단추가 같은 자리에 나와도 눌리면 안 됨)
    await tid(page, 'draw-back').click().catch(() => {});
    await page.goto(`${server.url}/draw.html${G}`); await waitView(page, 'menu');
    await sleep(900);
    const cb = await tid(page, 'draw-menu-team').boundingBox();
    const cx = cb.x + cb.width / 2; const cy = cb.y + cb.height / 2;
    for (const gap of [40, 150, 300]) {
      await page.goto(`${server.url}/draw.html${G}`); await waitView(page, 'menu'); await sleep(900);
      for (let i = 0; i < 4; i++) { await page.mouse.click(cx, cy); await sleep(gap); }
      await sleep(900);
      const d = await st(page);
      out.push(`카드 4번 클릭(${gap}ms) → view=${d.view} kind=${d.kind}`);
      s.eq([d.view, d.kind], ['intro', 'team'], `[카드 ${gap}ms] 첫 화면 카드를 여러 번 눌러도 시작 화면에 머묾`);
    }
    s.note(out.join(' / '));
  });

  // ══ 27. (한 팀씩·한 명씩) 연습 모드 ══════════════════════════════════════
  await scenario(27, '[한 팀씩·한 명씩] 연습 모드(입구를 지난 뒤 DB 요청 0건)', async (s) => {
    await resetRoster(db); resetCalls();
    const before = await rows();
    const { page, guard } = await newCtx();
    await openLive(page, '?practice=1&unit=group');
    s.eq((await st(page)).mode, 'practice', '모드');
    s.ok(await visible(page, 'draw-practice-badge'), "'연습' 표시");
    s.ok(await page.locator('#watermark').isVisible(), '연습 워터마크');
    s.ok(!(await visible(page, 'draw-login')), '입구를 지나면 첫 화면(입구는 숨김)');
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
    s.eq(server.calls.filter((c) => c.fn !== 'board_state').length, 0, '서버가 받은 rpc 는 입구 확인 board_state 뿐');
    s.eq(server.calls.length, 3, `입구 확인 = 페이지를 연 횟수(처음·한 명씩으로 이동·새로 고침): ${server.calls.length}`);
    s.eq(guard.proxied.filter((u) => !/\/rpc\/board_state$/.test(String(u.url || u))).length, 0, '브라우저가 supabase 로 보낸 요청은 입구 확인뿐');
    s.eq(diffRows(before, await rows()), [], 'DB 변화 0');
    s.eq(await page.evaluate(() => localStorage.getItem('team-picker-admin')), null, '연습 모드는 비밀번호를 localStorage 에 저장하지 않음');
    s.eq(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('draw-reveal'))), [], '연습 모드는 공개 위치를 localStorage 에 남기지 않음');
  });

  // ══ 28. (남긴 방법) 오류 처리 ══════════════════════════
  await scenario(28, '[한 팀씩·한 명씩] 오류 처리(pick 연속 실패 → 오류 상자 → 다시 시도 / 건너뛰기 / 한 명씩)', async (s) => {
    // 8-a 한 팀씩: 3번 실패 → 오류 상자 → 스페이스로 같은 사람 다시
    await resetRoster(db); resetCalls();
    let { page } = await newCtx({ code: true });
    let f = await failPicks(page);
    await openLive(page, G); await chooseKind(page, 'team');
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
    await openLive(page, G); await chooseKind(page, 'team');
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

    // ══ 29. (한 팀씩·한 명씩) 움직임 줄이기 ═══════════════
  await scenario(29, '[한 팀씩·한 명씩] 움직임 줄이기(reducedMotion: reduce): 팀·방·한 명씩 끝까지', async (s) => {
    await resetRoster(db); resetCalls();
    let { page } = await newCtx({ code: true, reducedMotion: 'reduce' });
    await openLive(page, G);
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

  // ══ 30. 부서 숨김: 발표 화면의 모든 공개 자리에 부서가 안 보임(같은 이름인 사람의 구분 표시만 예외) ══════════
  // 시험 명단: 견본 29명 + '견본다'(시험영업부) 한 명 = 이름이 같은 두 사람(id 3 은 시험생산부) + 긴 이름 6개(LONG).
  const DEPTS = ['시험영업부', '시험개발부', '시험생산부', '시험품질부', '시험관리부', '시험기획부'];
  const PRACTICE_DEPTS = ['연습부 가', '연습부 나', '연습부 다', '연습부 라', '연습부 마', '연습부 바'];
  async function seedDupLong() {
    await resetRoster(db);
    await db.query("insert into public.people (dept, name, title, gender) values ('시험영업부', '견본다', '사원', '남')");
    await longNames();
  }
  /** 지금 화면에서 부서 문자열이 보이는 글자(innerText, 화면 읽기용 #live 포함)에 있는지 + 구분 표시가 같은 이름인 사람에게만 붙었는지 */
  async function deptCheck(s, page, label, { depts = DEPTS, dupNames = ['견본다'], dupDepts = ['시험영업부', '시험생산부'], expectTags = null } = {}) {
    const r = await page.evaluate(({ depts, dupNames, dupDepts }) => {
      let t = document.body.innerText;
      for (const d of dupDepts) t = t.split(`(${d})`).join(''); // 같은 이름 구분 표시 '(부서)'는 예외
      const leaks = depts.filter((d) => t.includes(d));
      const bad = []; let tags = 0;
      for (const li of document.querySelectorAll('#stage .grp li, #stage .group-box li')) {
        if (li.offsetParent === null) continue; // 숨겨진 화면(예: 마지막 장면일 때 뽑는 화면의 옆 결과판)은 안 보이므로 제외
        const nm = li.querySelector('.nm'); const sm = li.querySelector('small');
        const isDup = dupNames.includes(nm.textContent);
        if (sm) { tags++; if (!isDup || !sm.classList.contains('dup') || !/^\(.+\)$/.test(sm.textContent)) bad.push(`표시가 붙은 칸 ${nm.textContent}${sm.textContent}`); }
        else if (isDup) bad.push(`같은 이름인데 구분 표시 없음: ${nm.textContent}`);
        if (li.textContent.replace(nm.textContent, '').trim() && !sm) bad.push(`이름 말고 다른 글이 있음: ${li.textContent}`);
      }
      const slot = document.getElementById('slot');
      if (slot && !slot.hidden) {
        const n = document.getElementById('slotName').textContent; const g = (document.getElementById('slotTag') || { textContent: '' }).textContent;
        if (dupNames.includes(n)) { if (!/^\(.+\)$/.test(g)) bad.push(`룰렛 칸 같은 이름 '${n}'인데 구분 표시 '${g}'`); }
        else if (g && n !== '결과 공개!') bad.push(`룰렛 칸 '${n}'에 구분 표시도 아닌 글 '${g}'`);
      }
      return { leaks, bad, tags };
    }, { depts, dupNames, dupDepts });
    s.eq(r.leaks, [], `${label}: 보이는 글자에 부서 없음`);
    s.eq(r.bad, [], `${label}: 구분 표시는 같은 이름인 사람에게만`);
    if (expectTags != null) s.eq(r.tags, expectTags, `${label}: 구분 표시 개수`);
    return r;
  }
  /** 같은 칸 안 이름 글자 크기가 모두 같은지, 이름·구분 표시가 칸 밖으로 넘치거나 잘리지 않는지. 크기(px)를 돌려줌 */
  async function sizeCheck(s, page, label, { board = false } = {}) {
    await settle(page); // 칸이 차례로 들어오는 연출이 끝난 뒤에 잼
    const r = await page.evaluate(() => {
      const out = { cards: [], over: [], all: [] };
      for (const card of document.querySelectorAll('#stage .grp, #stage .group-box')) {
        if (card.closest('[hidden]') || card.offsetParent === null) continue;
        const sizes = [];
        const cr = card.getBoundingClientRect();
        for (const li of card.querySelectorAll('li')) {
          const nm = li.querySelector('.nm'); const sm = li.querySelector('small');
          const px = parseFloat(getComputedStyle(nm).fontSize); sizes.push(px); out.all.push(px);
          const a = nm.getBoundingClientRect(); const b = li.getBoundingClientRect();
          if (li.scrollWidth > li.clientWidth + 1 || a.right > b.right + 1 || a.right > cr.right + 1 || a.bottom > cr.bottom + 1) out.over.push(`이름 넘침/잘림 '${nm.textContent}'`);
          if (sm && sm.scrollWidth > sm.clientWidth + 1) out.over.push(`구분 표시 잘림 '${nm.textContent}${sm.textContent}'`);
        }
        if (sizes.length) out.cards.push({ min: Math.min(...sizes), max: Math.max(...sizes), n: sizes.length });
      }
      const u = document.getElementById('stage').getBoundingClientRect().width / 100;
      const b = document.getElementById('finaleBoard');
      if (b && !b.closest('[hidden]') && (b.scrollHeight > b.clientHeight + 1 || [...b.querySelectorAll('.grp')].some((g) => g.scrollHeight > g.clientHeight + 1))) out.over.push('결과판 세로 넘침');
      return { ...out, u };
    });
    s.eq(r.over, [], `${label}: 넘치거나 잘린 이름 없음`);
    const uneven = r.cards.filter((c) => c.max - c.min > 0.01);
    s.eq(uneven, [], `${label}: 같은 칸 안 이름 글자 크기 같음(${r.cards.length}칸)`);
    if (board && r.all.length) s.ok(Math.max(...r.all) - Math.min(...r.all) <= 0.01, `${label}: 결과판 전체 이름 글자 크기 같음(${Math.min(...r.all).toFixed(2)}~${Math.max(...r.all).toFixed(2)}px)`);
    return { px: r.all.length ? Math.min(...r.all) : 0, pct: r.all.length ? Math.min(...r.all) / r.u : 0, maxPx: r.all.length ? Math.max(...r.all) : 0, maxPct: r.all.length ? Math.max(...r.all) / r.u : 0, n: r.all.length };
  }
  /** 룰렛이 도는 동안(저장 중) 여러 번 표본을 떠서 부서 글자가 없는지 */
  async function sampleSpin(s, page, label, n = 8, opt = {}) {
    for (let i = 0; i < n; i++) { await deptCheck(s, page, `${label} #${i + 1}`, opt); await sleep(150); }
  }

  for (const [w, h] of [[1920, 1080], [1280, 720]]) {
    await scenario(30, `[부서 숨김] ${w}×${h}: 전체 결과(팀·방)·룰렛 중, 같은 이름·긴 이름`, async (s) => {
      const vp = String(w);
      const viewport = { width: w, height: h };
      await seedDupLong();
      const { page } = await newCtx({ viewport, code: true });
      await delayPicks(page, 120);
      await openLive(page); await chooseKind(page, 'team');
      s.ok(!(await page.locator('body').innerText()).match(/시험(영업|개발|생산|품질|관리|기획)부/), '시작 화면에 부서 없음');
      await startBtn(page);
      await page.keyboard.press('Space');
      await wait(page, () => window.__draw.phase === 'saving');
      await sleep(400);
      await sampleSpin(s, page, '룰렛 중(팀)', 10);
      await wait(page, () => window.__draw.phase === 'landing');
      await sampleSpin(s, page, '룰렛 느려지는 중(팀)', 4);
      await waitFinale(page);
      await shot(page, vp, 'n01_finale_team');
      await deptCheck(s, page, '팀 전체 결과', { expectTags: 2 });
      const t = await sizeCheck(s, page, '팀 전체 결과');
      s.note(`${vp} 팀(30명·긴 이름 포함) 이름 글자: 보통 ${t.maxPx.toFixed(1)}px(무대 ${t.maxPct.toFixed(2)}%), 가장 작은(긴 이름이 든 칸) ${t.px.toFixed(1)}px(${t.pct.toFixed(2)}%)`);
      s.ok(t.pct >= 1.4, `팀 전체 결과 글자가 읽힐 만큼 큼(${t.pct.toFixed(2)}% ≥ 1.4%)`);
      // 방
      await unguard(page);
      await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
      await startBtn(page); await page.keyboard.press('Space');
      await wait(page, () => window.__draw.phase === 'saving'); await sleep(400);
      await sampleSpin(s, page, '룰렛 중(방)', 6);
      await waitFinale(page);
      await shot(page, vp, 'n02_finale_room');
      await deptCheck(s, page, '방 전체 결과', { expectTags: 2 });
      const rm = await sizeCheck(s, page, '방 전체 결과');
      s.note(`${vp} 방(30명·긴 이름 포함) 이름 글자: 보통 ${rm.maxPx.toFixed(1)}px(무대 ${rm.maxPct.toFixed(2)}%), 가장 작은(긴 이름이 든 칸) ${rm.px.toFixed(1)}px(${rm.pct.toFixed(2)}%)`);
      s.ok(rm.pct >= 1.4, `방 전체 결과 글자가 읽힐 만큼 큼(${rm.pct.toFixed(2)}% ≥ 1.4%)`);
    });

    await scenario(30.1, `[부서 숨김] ${w}×${h}: 견본 명단(긴 이름 없음)·이미 뽑은 사람 섞임 전체 결과의 이름 크기`, async (s) => {
      const vp = String(w);
      await resetRoster(db, { picked: true });
      const { page } = await newCtx({ viewport: { width: w, height: h }, code: true });
      await openLive(page); await chooseKind(page, 'team');
      await tid(page, 'draw-keep').click(); await waitView(page, 'play');
      await runAll(page);
      await shot(page, vp, 'n03_finale_team_plain');
      await deptCheck(s, page, '견본 팀 결과', { dupNames: [], dupDepts: [], expectTags: 0 });
      const t = await sizeCheck(s, page, '견본 팀 결과', { board: true });
      await unguard(page);
      await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro');
      await tid(page, 'draw-keep').click(); await waitView(page, 'play');
      await runAll(page);
      await shot(page, vp, 'n04_finale_room_plain');
      await deptCheck(s, page, '견본 방 결과', { dupNames: [], dupDepts: [], expectTags: 0 });
      const rm = await sizeCheck(s, page, '견본 방 결과', { board: true });
      s.note(`${vp} 견본 29명 이름 글자: 팀 ${t.px.toFixed(1)}px(무대 ${t.pct.toFixed(2)}%), 방 ${rm.px.toFixed(1)}px(무대 ${rm.pct.toFixed(2)}%)`);
      s.ok(t.pct >= 2.2 && rm.pct >= 2.0, `견본 29명 이름이 충분히 큼(팀 ${t.pct.toFixed(2)}% ≥ 2.2%, 방 ${rm.pct.toFixed(2)}% ≥ 2.0%)`);
    });

    await scenario(30.2, `[부서 숨김] ${w}×${h}: 한 팀씩·한 방씩 공개 칸과 옆 결과판`, async (s) => {
      const vp = String(w);
      await seedDupLong();
      const { page } = await newCtx({ viewport: { width: w, height: h }, code: true });
      for (const kind of ['team', 'room']) {
        if (kind === 'team') await openLive(page, G); else { await unguard(page); await tid(page, 'draw-next-kind').click(); await waitView(page, 'intro'); }
        if (kind === 'team') await chooseKind(page, 'team');
        await startBtn(page);
        let shown = 0;
        for (let i = 0; i < 12; i++) {
          await wait(page, () => { const d = window.__draw; return d && !d.busy && (d.view === 'finale' || d.phase === 'ready'); });
          const d = await st(page);
          if (d.view === 'finale') break;
          if (d.last && d.last.group) {
            shown++;
            await deptCheck(s, page, `한 ${kind === 'team' ? '팀' : '방'}씩 ${d.last.group}`, { dupDepts: ['시험영업부', '시험생산부'] });
            await sizeCheck(s, page, `한 ${kind === 'team' ? '팀' : '방'}씩 ${d.last.group}`);
            if (shown <= 2) await shot(page, vp, `n05_group_${kind}_${d.last.group}`);
          }
          await page.keyboard.press('Space');
        }
        await waitFinale(page);
        await deptCheck(s, page, `한 ${kind === 'team' ? '팀' : '방'}씩 마지막 장면`, { expectTags: 2 });
        await sizeCheck(s, page, `한 ${kind === 'team' ? '팀' : '방'}씩 마지막 장면`);
        s.ok(shown >= 4, `${kind}: 팀(방)을 하나씩 ${shown}번 공개`);
      }
    });

    await scenario(30.3, `[부서 숨김] ${w}×${h}: 한 명씩(이름 섞이는 중·공개·옆 결과판·모두 공개)`, async (s) => {
      const vp = String(w);
      await seedDupLong();
      const { page } = await newCtx({ viewport: { width: w, height: h }, code: true });
      await openLive(page, '?unit=person'); await chooseKind(page, 'team'); await startBtn(page);
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Space');
        await wait(page, () => window.__draw.phase === 'spinning');
        await sampleSpin(s, page, `한 명씩 ${i + 1}번째 섞는 중`, 5);
        await waitReady(page, 30000);
        await deptCheck(s, page, `한 명씩 ${i + 1}번째 공개`);
        if (i === 0) await shot(page, vp, 'n06_person_reveal');
        await sizeCheck(s, page, `한 명씩 ${i + 1}번째 옆 결과판`);
      }
      await tid(page, 'draw-all').click(); await wait(page, () => window.__draw.dialog === 'all');
      await tid(page, 'draw-dialog-ok').click();
      await wait(page, () => window.__draw.phase === 'bulk'); await sampleSpin(s, page, '모두 공개 중', 4);
      await waitFinale(page, 90000);
      await deptCheck(s, page, '한 명씩 마지막 장면', { expectTags: 2 });
      await sizeCheck(s, page, '한 명씩 마지막 장면');
    });

    await scenario(30.4, `[부서 숨김] ${w}×${h}: 연습 모드(전체·한 팀씩·한 명씩)`, async (s) => {
      const vp = String(w);
      const opt = { depts: PRACTICE_DEPTS, dupNames: [], dupDepts: [] };
      const { page } = await newCtx({ viewport: { width: w, height: h } });
      await openLive(page, '?practice=1');
      await chooseKind(page, 'team'); await startBtn(page);
      await page.keyboard.press('Space');
      await wait(page, () => window.__draw.phase === 'saving'); await sleep(300);
      await sampleSpin(s, page, '연습 룰렛 중', 5, opt);
      await waitFinale(page);
      await shot(page, vp, 'n07_practice_finale_team');
      await deptCheck(s, page, '연습 팀 전체 결과', { ...opt, expectTags: 0 });
      await sizeCheck(s, page, '연습 팀 전체 결과', { board: true });
      await page.goto(`${server.url}/draw.html?practice=1&unit=group`); await waitView(page, 'menu');
      await chooseKind(page, 'team'); await startBtn(page);
      await page.keyboard.press('Space'); await waitReady(page);
      await deptCheck(s, page, '연습 한 팀씩', { ...opt, expectTags: 0 });
      await sizeCheck(s, page, '연습 한 팀씩');
      await page.goto(`${server.url}/draw.html?practice=1&unit=person`); await waitView(page, 'menu');
      await chooseKind(page, 'team'); await startBtn(page);
      await page.keyboard.press('Space'); await wait(page, () => window.__draw.phase === 'spinning');
      await sampleSpin(s, page, '연습 한 명씩 섞는 중', 4, opt);
      await waitReady(page, 30000);
      await deptCheck(s, page, '연습 한 명씩 공개', opt);
    });
  }

  // 같은 이름 구분 표시가 룰렛·한 명씩 이름 칸에도 실제로 나오는지(명단을 5명으로 줄여 같은 이름이 자주 나오게)
  await scenario(30.5, '[부서 숨김] 룰렛·한 명씩 이름 칸: 같은 이름인 사람에게만 (부서) 표시', async (s) => {
    for (const unit of ['', '?unit=person']) {
      await seedDupLong();
      await db.query('delete from public.people where id not in (1, 2, 3, 4, 30)');
      const { page } = await newCtx({ code: true });
      await delayPicks(page, 500);
      await openLive(page, unit); await chooseKind(page, 'team'); await startBtn(page);
      await page.keyboard.press('Space');
      await wait(page, () => ['saving', 'spinning'].includes(window.__draw.phase));
      const seen = { tag: 0, plain: 0 };
      for (let i = 0; i < 24; i++) {
        const o = await page.evaluate(() => ({ n: document.getElementById('slotName').textContent, t: document.getElementById('slotTag').textContent, sh: !document.getElementById('slot').hidden }));
        if (o.sh && o.n === '견본다') { seen.tag++; s.ok(/^\((시험영업부|시험생산부)\)$/.test(o.t), `같은 이름 표시 모양: '${o.t}'`); }
        else if (o.sh && o.n && o.n !== '결과 공개!') { seen.plain++; s.eq(o.t, '', `다른 이름 '${o.n}'에는 표시 없음`); }
        await sleep(110);
      }
      s.ok(seen.tag > 0 && seen.plain > 0, `${unit || '전체'}: 같은 이름 ${seen.tag}번·다른 이름 ${seen.plain}번 표본`);
      await deptCheck(s, page, `${unit || '전체'} 이름 칸`);
    }
  });

  // 진행자 안내: 같은 이름인 사람이 오류로 멈추면 '이름(부서)', 이름이 하나뿐인 사람이 멈추면 이름만. 성별 없는 사람 안내도 같은 규칙
  await scenario(30.6, '[부서 숨김] 진행자 안내(오류로 멈춤·성별 없음·아직 안 뽑음): 같은 이름만 이름(부서)', async (s) => {
    await seedDupLong();
    await db.query('delete from public.people where id not in (3, 30, 4)'); // 견본다 둘(시험생산부·시험영업부) + 견본라
    await db.query("update public.people set gender = null where id = 4"); // 견본라: 성별 없음(이름이 하나뿐)
    const { page } = await newCtx({ code: true });
    await openLive(page); await chooseKind(page, 'room');
    const ng = await text(page, 'draw-nogender');
    s.ok(/견본라(?!\()/.test(ng) && !/견본라\(/.test(ng), `성별 없음 안내: 이름이 하나뿐인 사람은 이름만: ${ng}`);
    await db.query("update public.people set gender = '남' where id = 4"); // 아래는 팀 뽑기로
    await page.goto(`${server.url}/draw.html`); await waitView(page, 'menu'); await chooseKind(page, 'team');
    await startBtn(page);
    const g = await failPicks(page);
    g.arm(40); // 저장 요청이 계속 실패 → 오류 상자
    await page.keyboard.press('Space'); await waitErr(page, 60000);
    const cur = (await st(page)).current;
    const msg = await text(page, 'draw-msg');
    const want = cur.name === '견본다' ? `견본다(${cur.dept})` : cur.name;
    s.ok(msg.includes(want + ' 님'), `오류 안내가 '${want}'로 나옴: ${msg}`);
    if (cur.name !== '견본라') s.ok(!/견본라\(/.test(msg), '이름이 하나뿐인 사람에게는 부서가 안 붙음');
    await deptCheck(s, page, '오류 상자', { dupNames: ['견본다'], dupDepts: ['시험영업부', '시험생산부'] });
    s.ok(await visible(page, 'draw-error'), '오류 상자 보임');
  });

  // ══ 40~47. 입구(관리자 비밀번호): 통과 전에는 화면·명단 없음, 이 탭에만 기억, 잠그기, 통신 오류, 키, 노출 ══════════
  const LOCK_SHOTS = process.env.LOCK_SHOTS || join(SHOTS, 'lock');
  const APP_IDS = ['draw-menu', 'draw-intro', 'draw-play', 'draw-finale', 'draw-board', 'draw-finale-board', 'draw-menu-team-status', 'draw-practice-badge', 'draw-lock', 'draw-loading', 'draw-dialog'];
  const WRITE_FNS = (c) => c.fn !== 'board_state'; // 이 화면이 부르는 함수 가운데 board_state 말고는 모두 쓰기(pick·pick_room·admin_*)
  /** 입구에서 문서에 남은 것: 화면 요소·명단 이름(보이는 글자와 숨은 DOM 모두)·견본 명단·첫 화면 글 */
  async function gateLeak(page) {
    const names = [...new Set((await rows()).map((r) => r.name))];
    return page.evaluate(({ ids, names }) => {
      const html = document.body.outerHTML.replace(/<template[\s\S]*?<\/template>/g, ''); // <template> 안(아직 만들지 않은 화면 틀)은 문서가 아님. 그 틀에도 명단은 없음
      const text = document.body.innerText;
      const practice = /견본 (토끼|판다|여우|사과|포도|감자)/;
      return {
        appEls: ids.filter((id) => document.querySelector(`[data-testid="${id}"]`)),
        textNames: names.filter((n) => text.includes(n)),
        domNames: names.filter((n) => html.includes(n) || document.documentElement.outerHTML.includes(n)),
        practice: practice.test(text) || practice.test(document.documentElement.outerHTML),
        menuText: /무엇을 뽑을까요|레크리에이션 팀 뽑기|방 배정 뽑기|연습 모드|명\)/.test(text),
        stageKids: [...document.getElementById('stage').children].map((e) => e.id),
        lis: document.querySelectorAll('li').length,
      };
    }, { ids: APP_IDS, names });
  }
  const NO_LEAK = { appEls: [], textNames: [], domNames: [], practice: false, menuText: false, stageKids: ['error', 'loginView'], lis: 0 };
  const gateIdle = (page) => wait(page, () => { const d = window.__draw; return d && d.view === 'login' && !d.busy && d.gate !== 'checking'; });
  const gateState = (page) => page.evaluate(() => window.__draw.gate);

  await scenario(40, '입구: 비밀번호 없이·틀린 비밀번호·주소 옵션·저장된 비밀번호 — 화면·명단 DOM 없음, 쓰기 0건', async (s) => {
    await resetRoster(db, { picked: true }); resetCalls(); // 일부는 이미 뽑은 상태(첫 화면 인원 숫자가 새어 나오는지도 봄)
    const { ctx, page } = await newCtx({ code: true }); // 관리자 페이지에 들어간 적 있는 기기(맞는 비밀번호가 localStorage 에)
    for (const q of ['', '?practice=1', '?unit=group', '?unit=person', '?practice=1&unit=person', '?unit=all&practice=1']) {
      await page.goto(`${server.url}/draw.html${q}`);
      await gateIdle(page); await sleep(250);
      s.eq(await gateState(page), 'idle', `[${q || '옵션 없음'}] 입구`);
      s.eq(await gateLeak(page), NO_LEAK, `[${q || '옵션 없음'}] 비밀번호 없이: 화면·명단 DOM 없음`);
      s.eq(await page.title(), '발표용 뽑기', `[${q || '옵션 없음'}] 탭 제목에 연습·종류 표시 없음`);
      await tid(page, 'draw-code').fill('틀린-비밀번호-1');
      await tid(page, 'draw-code').press('Enter');
      await gateIdle(page);
      s.eq(await gateState(page), 'wrong', `[${q || '옵션 없음'}] 틀린 비밀번호`);
      s.eq(await gateLeak(page), NO_LEAK, `[${q || '옵션 없음'}] 틀린 비밀번호 뒤: 화면·명단 DOM 없음`);
      s.eq(await page.evaluate(() => sessionStorage.getItem('draw-gate')), null, `[${q || '옵션 없음'}] 틀린 비밀번호는 기억 안 함`);
    }
    s.eq(server.calls.filter(WRITE_FNS).length, 0, '그동안 쓰기 요청 0건');
    s.eq(server.calls.map((c) => `${c.fn}:${c.status}`), Array(6).fill('board_state:400'), '요청은 틀린 비밀번호 확인 6건뿐(모두 거절)');
    s.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('team-picker-admin'))), ADMIN_CODE, 'localStorage 의 관리자 페이지 비밀번호는 그대로(안 지움·안 씀)');
    const ws = await page.evaluate(() => (window.__draw && Object.keys(window.__draw)) || []);
    s.ok(!ws.includes('people'), 'window.__draw 에 명단 없음');
  });

  await scenario(41, '입구: 같은 탭 새로 고침은 다시 묻지 않음(첫 화면·룰렛 저장 중·전체 결과), 서버에 다시 확인', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx();
    await page.goto(`${server.url}/draw.html`);
    s.eq(await enterGate(page), true, '처음에는 직접 넣음');
    await waitView(page, 'menu');
    // 첫 화면
    resetCalls();
    await page.reload();
    s.eq(await enterGate(page), false, '[첫 화면] 새로 고침 뒤 묻지 않음');
    await waitView(page, 'menu');
    s.eq(server.calls.map((c) => `${c.fn}:${c.status}`), ['board_state:200'], '[첫 화면] 서버에 다시 확인 한 번(그 명단으로 첫 화면)');
    // 룰렛 저장 중
    await page.route(/\/rpc\/pick$/, async (r) => { await sleep(120); r.fallback(); });
    await chooseKind(page, 'team'); await startBtn(page);
    await page.keyboard.press('Space');
    for (let i = 0; i < 400; i++) { const n = (await rows()).filter((r) => r.team).length; if (n >= 6) break; await sleep(25); }
    s.eq((await st(page)).phase, 'saving', '룰렛(저장) 도중');
    await page.reload();
    s.eq(await enterGate(page), false, '[룰렛 저장 중] 새로 고침 뒤 묻지 않음');
    await waitView(page, 'menu');
    await sleep(500);
    const n1 = (await rows()).filter((r) => r.team).length;
    await chooseKind(page, 'team');
    s.ok(await visible(page, 'draw-keep'), `[룰렛 저장 중] 이어 하기 단추: ${await text(page, 'draw-keep')}`);
    await tid(page, 'draw-keep').click(); await waitView(page, 'play');
    await runAll(page);
    s.eq((await rows()).filter((r) => r.team).length, 29, `[룰렛 저장 중] 남은 ${29 - n1}명 이어서 저장 → 29명`);
    // 전체 결과
    const m1 = await finaleMap(page);
    resetCalls();
    await page.reload();
    s.eq(await enterGate(page), false, '[전체 결과] 새로 고침 뒤 묻지 않음');
    await waitFinale(page);
    s.eq([(await st(page)).view, await finaleMap(page)], ['finale', m1], '[전체 결과] 같은 전체 결과 다시');
    s.eq(server.calls.filter(WRITE_FNS).length, 0, '[전체 결과] 새로 고침으로 쓰기 0건');
    s.eq(calls('board_state').length, 2, '[전체 결과] 입구 다시 확인 1 + 전체 결과 최신 명단 1');
    s.eq(await page.evaluate(() => [Object.keys(localStorage).filter((k) => !k.startsWith('draw-reveal')), document.cookie]), [[], ''], '오래 남는 저장소(localStorage·쿠키)에 새로 적은 것 없음');
  });

  await scenario(42, '입구: 새 탭(같은 context)·새 context(브라우저를 다시 연 것)는 다시 물음', async (s) => {
    await resetRoster(db); resetCalls();
    const a = await newCtx();
    await openLive(a.page);
    const p2 = await a.ctx.newPage();
    await p2.goto(`${server.url}/draw.html`);
    await gateIdle(p2);
    s.eq(await gateState(p2), 'idle', '같은 브라우저의 새 탭: 입구');
    s.eq(await gateLeak(p2), NO_LEAK, '새 탭: 화면·명단 DOM 없음');
    s.eq(await p2.evaluate(() => sessionStorage.getItem('draw-gate')), null, '새 탭에는 기억 없음');
    s.eq(await a.page.evaluate(() => sessionStorage.getItem('draw-gate')), ADMIN_CODE, '원래 탭은 그대로 기억');
    const b = await newCtx({ code: true });
    await b.page.goto(`${server.url}/draw.html?practice=1`);
    await gateIdle(b.page);
    s.eq(await gateState(b.page), 'idle', '새 context(브라우저를 다시 연 것과 같음): 입구');
    s.eq(server.calls.filter(WRITE_FNS).length, 0, '쓰기 0건');
  });

  await scenario(43, '잠그기: 확인 상자·취소, 누르면 입구로(기억·명단 DOM 지움), 룰렛 중·화면 전환 직후에는 안 눌림', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx();
    await page.goto(`${server.url}/draw.html`);
    await tid(page, 'draw-code').fill(ADMIN_CODE);
    await tid(page, 'draw-code').press('Enter');
    await wait(page, () => window.__draw && window.__draw.view === 'menu');
    s.ok((await st(page)).guarded, '통과 직후는 보호 시간');
    await tid(page, 'draw-lock').click({ force: true });
    await sleep(150);
    s.eq((await st(page)).dialog, null, '통과 직후(보호 시간)에는 잠그기가 안 눌림');
    await unguard(page);
    s.ok(await visible(page, 'draw-lock'), '첫 화면에 잠그기 단추');
    await tid(page, 'draw-lock').click();
    await wait(page, () => window.__draw.dialog === 'lock');
    await page.keyboard.press('Enter'); await sleep(50); // 열린 직후(0.5초) Enter 는 무시
    s.eq((await st(page)).dialog, 'lock', '열린 직후 Enter 로 닫히지 않음');
    s.ok(/잠글까요/.test(await text(page, 'draw-dialog-title')), `확인 상자: ${await text(page, 'draw-dialog-title')}`);
    s.eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'dlgCancel', '처음 초점은 취소');
    await tid(page, 'draw-dialog-cancel').click();
    await wait(page, () => window.__draw.dialog === null);
    s.eq([(await st(page)).view, await page.evaluate(() => sessionStorage.getItem('draw-gate'))], ['menu', ADMIN_CODE], '취소하면 그대로');
    // 룰렛 중에는 안 눌림
    await page.route(/\/rpc\/pick$/, async (r) => { await sleep(150); r.fallback(); });
    await chooseKind(page, 'team'); await startBtn(page);
    await page.keyboard.press('Space');
    await wait(page, () => window.__draw.phase === 'saving');
    s.ok(await tid(page, 'draw-lock').isDisabled(), '룰렛(저장) 중 잠그기 단추 꺼짐');
    await tid(page, 'draw-lock').click({ force: true }); await sleep(100);
    await page.evaluate(() => document.getElementById('lockBtn').click()); await sleep(100);
    s.eq((await st(page)).dialog, null, '룰렛 중 눌러도 확인 상자 안 열림');
    await wait(page, () => window.__draw.phase === 'landing' || window.__draw.view === 'finale');
    s.ok(await tid(page, 'draw-lock').isDisabled(), '멈추는 중에도 꺼짐');
    await waitFinale(page);
    s.ok((await st(page)).guarded, '전체 결과로 넘어간 직후 보호 시간');
    await tid(page, 'draw-lock').click({ force: true }); await sleep(100);
    s.eq((await st(page)).dialog, null, '전체 결과로 넘어간 직후(보호 시간)에는 안 눌림');
    await unguard(page);
    s.ok((await page.locator('#finaleBoard li').count()) === 29, '전체 결과에 29명');
    // 잠그기
    const writes0 = server.calls.filter(WRITE_FNS).length;
    await tid(page, 'draw-lock').click();
    await wait(page, () => window.__draw.dialog === 'lock');
    await sleep(600);
    const loaded = page.waitForEvent('load');
    const now = await page.evaluate(async () => {
      document.getElementById('dlgOk').click();
      await new Promise((r) => setTimeout(r, 0));
      return { lis: document.querySelectorAll('li').length, kids: [...document.getElementById('stage').children].map((e) => e.id), mem: sessionStorage.getItem('draw-gate') };
    }).catch((e) => ({ err: String(e).slice(0, 80) }));
    if (now.err) s.note(`누른 바로 뒤 DOM 은 페이지가 먼저 다시 불러져 못 읽음: ${now.err}`);
    else s.eq(now, { lis: 0, kids: ['error', 'loginView'], mem: null }, '누른 즉시: 명단 DOM·기억 지움');
    await loaded;
    await gateIdle(page);
    s.eq(await gateState(page), 'idle', '잠근 뒤 입구');
    s.ok(/잠갔어요/.test(await text(page, 'draw-login-info')), `잠근 뒤 안내: ${await text(page, 'draw-login-info')}`);
    s.eq(await page.evaluate(() => sessionStorage.getItem('draw-gate')), null, '잠근 뒤 sessionStorage 비밀번호 없음');
    s.eq(await gateLeak(page), NO_LEAK, '잠근 뒤 화면·명단 DOM 없음');
    s.eq(server.calls.filter(WRITE_FNS).length, writes0, '잠그기로 쓰기 요청 없음');
    // 새로 고쳐도 입구(기억이 없음)
    resetCalls();
    await page.reload(); await gateIdle(page);
    s.eq([await gateState(page), server.calls.length], ['idle', 0], '잠근 뒤 새로 고침: 입구, 요청 0건');
    // 다시 넣으면 들어감(전체 결과를 띄운 채 잠갔으므로 전체 결과로 다시 — 결과는 DB 에 있음)
    await enterGate(page);
    await wait(page, () => window.__draw && ['menu', 'finale'].includes(window.__draw.view) && !window.__draw.busy);
    s.note(`잠근 뒤 다시 넣으면: ${(await st(page)).view}`);
    // 첫 화면에서 잠그기
    await unguard(page);
    if ((await st(page)).view === 'finale') { await tid(page, 'draw-finale-home').click(); await waitView(page, 'menu'); await unguard(page); }
    await tid(page, 'draw-lock').click(); await wait(page, () => window.__draw.dialog === 'lock');
    await Promise.all([page.waitForEvent('load'), tid(page, 'draw-dialog-ok').click()]);
    await gateIdle(page);
    s.eq(await gateLeak(page), NO_LEAK, '[첫 화면에서 잠금] 화면·명단 DOM 없음');
  });

  await scenario(44, '입구: 통신 오류는 틀린 것과 따로 안내 + 다시 연결 / 새로 고침 재확인 때 오류·비밀번호 바뀜', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx();
    let down = 0;
    await page.route(/\/rpc\/board_state$/, async (r) => { if (down > 0) { down--; return r.abort('failed'); } return r.fallback(); });
    await page.goto(`${server.url}/draw.html`);
    await gateIdle(page);
    // 처음 넣을 때 통신 오류
    down = 1;
    await tid(page, 'draw-code').fill(ADMIN_CODE);
    await tid(page, 'draw-code').press('Enter');
    await gateIdle(page);
    const offMsg = await text(page, 'draw-login-error');
    s.eq(await gateState(page), 'offline', '통신 오류 상태');
    s.ok(/연결/.test(offMsg) && !/맞지 않아요/.test(offMsg), `통신 오류 안내(틀림과 다름): ${offMsg}`);
    s.ok(await visible(page, 'draw-reconnect'), "'다시 연결' 단추");
    s.eq(await page.evaluate(() => [document.getElementById('code').value, sessionStorage.getItem('draw-gate')]), ['', null], '입력 칸 비움·아직 기억 안 함');
    s.eq(await gateLeak(page), NO_LEAK, '통신 오류: 화면·명단 DOM 없음');
    // 틀린 비밀번호 안내와 다른지
    await tid(page, 'draw-code').fill('틀린-비밀번호-2'); await tid(page, 'draw-code').press('Enter'); await gateIdle(page);
    const wrongMsg = await text(page, 'draw-login-error');
    s.ok(wrongMsg !== offMsg && /맞지 않아요/.test(wrongMsg), `틀림 안내: ${wrongMsg}`);
    s.ok(!(await visible(page, 'draw-reconnect')), "틀리면 '다시 연결' 없음");
    // 다시 통신 오류 → 다시 연결로 들어감
    down = 1;
    await tid(page, 'draw-code').fill(ADMIN_CODE); await tid(page, 'draw-code').press('Enter'); await gateIdle(page);
    s.eq(await gateState(page), 'offline', '다시 통신 오류');
    await tid(page, 'draw-reconnect').click();
    await waitView(page, 'menu');
    s.eq(await page.evaluate(() => sessionStorage.getItem('draw-gate')), ADMIN_CODE, "'다시 연결'로 들어가고 기억");
    // 새로 고침 때 통신 오류: 기억은 두고 입구에서 다시 연결
    down = 1;
    await page.reload(); await gateIdle(page);
    s.eq(await gateState(page), 'offline', '[새로 고침] 다시 확인 중 통신 오류 → 입구(오류 안내)');
    s.eq(await gateLeak(page), NO_LEAK, '[새로 고침·통신 오류] 화면·명단 DOM 없음');
    s.eq(await page.evaluate(() => sessionStorage.getItem('draw-gate')), ADMIN_CODE, '[새로 고침·통신 오류] 기억은 그대로(틀린 게 아니므로)');
    await tid(page, 'draw-reconnect').click();
    await waitView(page, 'menu');
    s.ok(true, '[새로 고침·통신 오류] 다시 연결로 들어감(비밀번호 다시 안 넣음)');
    // 비밀번호가 바뀐 뒤 새로 고침 → 기억 지우고 입구
    await db.query("update public.config set value = 'test-admin-code-changed' where key = 'admin_code'");
    try {
      await page.reload(); await gateIdle(page);
      s.eq(await gateState(page), 'wrong', '[비밀번호 바뀜] 새로 고침 → 입구');
      s.ok(/바뀌었어요/.test(await text(page, 'draw-login-error')), `[비밀번호 바뀜] 안내: ${await text(page, 'draw-login-error')}`);
      s.eq(await page.evaluate(() => sessionStorage.getItem('draw-gate')), null, '[비밀번호 바뀜] 기억 지움');
      // 들어온 뒤 바뀜(첫 화면에서 팀 뽑기를 고르면 명단을 다시 받다가 거절) → 입구로
      await enterGate(page, 'test-admin-code-changed'); await waitView(page, 'menu');
      await db.query(`update public.config set value = '${ADMIN_CODE}' where key = 'admin_code'`);
      await unguard(page);
      await Promise.all([page.waitForEvent('load'), page.keyboard.press('Digit1')]);
      await gateIdle(page);
      s.eq(await gateState(page), 'wrong', '[들어온 뒤 바뀜] 입구로 돌아감');
      s.ok(/바뀌었어요/.test(await text(page, 'draw-login-error')), `[들어온 뒤 바뀜] 안내: ${await text(page, 'draw-login-error')}`);
      s.eq(await gateLeak(page), NO_LEAK, '[들어온 뒤 바뀜] 화면·명단 DOM 없음');
    } finally {
      await db.query(`update public.config set value = '${ADMIN_CODE}' where key = 'admin_code'`);
    }
    s.eq(server.calls.filter(WRITE_FNS).length, 0, '쓰기 0건');
  });

  await scenario(45, '입구 키: 연타해도 확인 한 번, Space·Enter 는 진행 키가 아님, 통과 직후 연타·클릭이 첫 화면 단추를 안 누름', async (s) => {
    await resetRoster(db); resetCalls();
    const { page } = await newCtx();
    await page.route(/\/rpc\/board_state$/, async (r) => { await sleep(1200); r.fallback(); }); // 느린 확인
    await page.goto(`${server.url}/draw.html`);
    await gateIdle(page);
    await tid(page, 'draw-code').fill(ADMIN_CODE);
    await tid(page, 'draw-code').press('Enter');
    for (let i = 0; i < 6; i++) { await tid(page, 'draw-login-submit').click({ force: true }).catch(() => {}); await page.keyboard.press('Enter'); }
    s.eq((await st(page)).gate, 'checking', '확인 중');
    s.ok(await tid(page, 'draw-login-submit').isDisabled(), '확인 중 들어가기 단추 꺼짐');
    await waitView(page, 'menu');
    s.eq(calls('board_state').length, 1, '연타해도 확인 요청 한 번');
    // 통과 직후 연타: 새 탭에서 Enter 를 누른 채(반복)·스페이스·클릭
    const p2 = await page.context().newPage();
    await p2.goto(`${server.url}/draw.html`); await gateIdle(p2);
    resetCalls();
    await tid(p2, 'draw-code').fill(ADMIN_CODE);
    await p2.keyboard.down('Enter'); // 제출
    const t0 = Date.now();
    let opened = false;
    let clicks = 0;
    let menuAt = 0;
    while (Date.now() - t0 < 1600) { // 키를 누른 채(반복 Enter) + 스페이스·Enter 연타 + 보호 시간 동안 첫 화면 단추 클릭
      await p2.keyboard.down('Enter');
      await p2.keyboard.press('Space');
      await p2.keyboard.press('Enter');
      const d = await st(p2);
      if (d.view === 'menu' && !menuAt) menuAt = Date.now();
      if (d.view === 'menu' && d.guarded && Date.now() - menuAt < 600) { // 보호 시간(screenGuardMs.gate 1초)이 끝나기 한참 전까지만 클릭
        const box = await p2.locator('#pickTeam').boundingBox().catch(() => null);
        if (box) { await p2.mouse.click(box.x + box.width / 2, box.y + box.height / 2); clicks++; }
      }
      if (d.view === 'intro' || d.view === 'loading') opened = true;
    }
    await p2.keyboard.up('Enter');
    await sleep(300);
    const d = await st(p2);
    s.ok(!opened && d.view === 'menu', `통과 직후 연타해도 첫 화면 그대로: ${d.view}`);
    s.ok(clicks >= 2, `보호 시간 동안 첫 화면 단추를 ${clicks}번 클릭함`);
    s.eq(server.calls.filter((c) => c.fn !== 'board_state').length, 0, '통과 직후 연타로 다른 요청 없음');
    s.eq(calls('board_state').length, 1, '확인 한 번(명단을 다시 받지도 않음)');
    // 보호 시간이 지나면 단추가 정상으로 눌림
    await unguard(p2);
    await p2.locator('#pickTeam').click(); await waitView(p2, 'intro');
    s.ok(true, '보호 시간 뒤에는 첫 화면 단추가 눌림');
  });

  await scenario(46, '비밀번호 노출 없음: 입력 칸 가림·주소·화면 글자·문서·탭 제목·콘솔·쿠키·localStorage', async (s) => {
    await resetRoster(db); resetCalls();
    const { ctx, page, guard } = await newCtx();
    await page.goto(`${server.url}/draw.html`); await gateIdle(page);
    const attrs = await page.evaluate(() => { const i = document.getElementById('code'); return { type: i.type, ac: i.getAttribute('autocomplete'), form: !!i.form || !!i.closest('form') }; });
    s.eq(attrs, { type: 'password', ac: 'off', form: false }, '입력 칸: type=password, 자동 완성 끔, form 으로 보내지 않음');
    const leaks = [];
    const look = async (label, pw) => {
      const r = await page.evaluate((pw) => ({
        text: document.body.innerText.includes(pw), dom: document.documentElement.outerHTML.includes(pw), title: document.title.includes(pw),
        url: location.href.includes(pw), input: document.getElementById('code').value.includes(pw), ls: Object.values(localStorage).some((v) => String(v).includes(pw)),
      }), pw);
      for (const [k, v] of Object.entries(r)) if (v) leaks.push(`${label}:${k}`);
    };
    await tid(page, 'draw-code').fill('틀린-비밀번호-3'); await tid(page, 'draw-code').press('Enter'); await gateIdle(page);
    await look('틀린 뒤', '틀린-비밀번호-3');
    await tid(page, 'draw-code').fill(ADMIN_CODE); await tid(page, 'draw-code').press('Enter'); await waitView(page, 'menu');
    await look('들어온 뒤', ADMIN_CODE);
    await page.reload(); await waitView(page, 'menu');
    await look('새로 고침 뒤', ADMIN_CODE);
    await chooseKind(page, 'team'); await startBtn(page); await runAll(page);
    await look('전체 결과', ADMIN_CODE);
    s.eq(leaks, [], '화면 글자·문서·탭 제목·주소·입력 칸·localStorage 어디에도 비밀번호 없음');
    s.eq(await ctx.cookies(), [], '쿠키 없음');
    s.ok(!s.consoles.some((t) => t.includes('틀린-비밀번호-3')), '콘솔에 틀린 비밀번호도 안 나옴');
    s.ok(!guard.proxied.some((x) => String(x.url).includes(ADMIN_CODE)), '요청 주소에 비밀번호 없음(본문으로만 보냄)');
  });

  for (const [w, h] of [[1920, 1080], [1280, 720]]) {
    await scenario(47, `입구 캡처 ${w}×${h}: 입구·틀림·통신 오류·들어온 뒤 잠그기 단추`, async (s) => {
      await resetRoster(db); resetCalls();
      mkdirSync(LOCK_SHOTS, { recursive: true });
      const { page } = await newCtx({ viewport: { width: w, height: h } });
      let down = 0;
      await page.route(/\/rpc\/board_state$/, async (r) => { if (down > 0) { down--; return r.abort('failed'); } return r.fallback(); });
      const snap = async (name) => {
        await settle(page);
        const file = join(LOCK_SHOTS, `${w}x${h}_${name}.png`);
        await page.screenshot({ path: file });
        shotFiles.push(file);
        const issues = await layoutCheck(page, `lock ${name}`, String(w));
        s.eq(issues, [], `[${name}] 넘침·무대 밖 없음`);
      };
      await page.goto(`${server.url}/draw.html`); await gateIdle(page);
      await snap('1_gate');
      await tid(page, 'draw-code').fill('틀린-비밀번호'); await tid(page, 'draw-code').press('Enter'); await gateIdle(page);
      await snap('2_wrong');
      down = 1;
      await tid(page, 'draw-code').fill(ADMIN_CODE); await tid(page, 'draw-code').press('Enter'); await gateIdle(page);
      await snap('3_offline');
      await tid(page, 'draw-reconnect').click(); await waitView(page, 'menu'); await unguard(page);
      s.ok(await visible(page, 'draw-lock'), '첫 화면에 잠그기 단추');
      await page.mouse.move(1, 1); // 누른 자리의 hover 모양이 캡처에 남지 않게
      await snap('4_menu_lock');
    });
  }

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
  } else if (!only.length || only.includes('11')) console.log('\n레이아웃 점검: 글자 잘림·넘침·무대 밖 요소 없음');
  if (shotFiles.length) console.log(`\n캡처 ${shotFiles.length}장: ${[...new Set(shotFiles.map((f) => dirname(f)))].join(' , ')}`);
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0 && layoutFindings.length === 0, results, layoutFindings, shotFiles };
}
