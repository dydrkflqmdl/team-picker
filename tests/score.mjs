// 발표용 점수판(score.html) 통합 시험.  실행: cd tests && node run.mjs score [시나리오 번호 ...]   (예: node run.mjs score 1 6)   npm run test:score  도 같음.
//   1 입구(비밀번호 전 DOM·요청 없음, 틀림/통신 오류/서버 오류 구분, 저장된 관리자 비밀번호 무시, 같은 탭 새로 고침·새 탭, 잠그기)
//   2 점수 주기·빼기와 DB 값(네 팀·직접 입력·한도) + 서버 함수 score_add 의 합산·오류·권한·다시 적용해도 점수 유지
//   3 연달아 주기(연타·Enter 두 번·연출 중 같은 팀·다른 팀 바로 이어서·마지막 값으로 정확히 멈춤·연출 길이) + 세어 올라가기/내려가기(사이 값·한 방향·마지막 걸음·안 바뀌는 자리는 가만히·자릿수 변화·음수·세는 도중 이어서)
//   4 새로 고침 뒤 유지(연출 중·저장 중 포함)   5 두 브라우저(다른 쪽 점수 5초 안 반영·동시에 줘도 합산·연출 중 폴링이 안 덮음)
//   6 저장 실패(서버 거절·응답 끊김·서버엔 반영된 채 응답만 끊김)
//   6.1 응답이 끊긴 요청이 늦게 서버에 도착해도 같은 점수를 다시 누르면 한 번만(요청 번호 p_req, (팀, 점수)마다 따로 기억 — 그 사이 다른 점수를 줘도 남음)   6.2 요청을 23초 붙잡았다가 보냄(20초 시간 초과 뒤 도착)
//   6.3 DB 직접: score_add 요청 번호(동시·한도 실패·형식·24시간 정리·초기화로 안 지움·다시 적용)   6.4 +N 표시·소리·방향은 준 점수 기준   6.5 직접 입력 부호(빼기는 늘 −)·입력 칸 길이
//   7 연습 모드   8 관리자 페이지 초기화가 점수판에 반영
//   9 움직임 줄이기   10 1920×1080·1280×720 화면 안에 네 팀·네 점수(처음·도는 중·큰 점수·오류 상자·긴 이름·이름 숨김)
//   11 소리 요청 관측(window.__scoreAudio)   12 키보드·되돌리기·팀 안 고르고 주기   13 이름 표시(팀별·숨김·이스케이프·새로 받기)
// 운영 DB 에는 닿지 않는다: 모든 context 에 guardNetwork 를 걸고, 시나리오 끝마다 막힌 외부 요청이 0건인지 확인한다.
// 견본 명단(seed.mjs)과 시험용 관리자 비밀번호만 쓴다. 시험이 흔들리지 않게 고정 대기 대신 waitForFunction(window.__score.phase 등)을 쓴다.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_CODE, connect, ROOT, PORT, DB } from './db.mjs';
import { resetRoster } from './seed.mjs';
import { startServer } from './server.mjs';
import { guardNetwork, launchBrowser } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEAMS = ['red', 'blue', 'yellow', 'green'];
const KO = { red: '빨강', blue: '파랑', yellow: '노랑', green: '초록' };
const ZERO = { red: 0, blue: 0, yellow: 0, green: 0 };
const QUICK = { 10: '#q-p10', 50: '#q-p50', 100: '#q-p100', '-10': '#q-m10', '-50': '#q-m50' };
const fmt = (n) => (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US'); // 화면 표기(마이너스는 U+2212)

export async function scoreTests(only = []) {
  const db = await connect();
  const server = await startServer({ port: 0 });
  const browser = await launchBrowser();
  const results = [];
  const layoutFindings = [];
  let cur = null;

  // ── 도우미 ──────────────────────────────────────────
  const resetCalls = () => { server.calls.length = 0; };
  const calls = (fn) => server.calls.filter((c) => c.fn === fn);
  const dbScores = async () => Object.fromEntries((await db.query('select team, score from team_scores order by team')).rows.map((r) => [r.team, Number(r.score)]));
  const setScores = async (o = {}) => { for (const t of TEAMS) await db.query('update team_scores set score = $1, updated_at = now() where team = $2', [o[t] ?? 0, t]); };
  const direct = async (fn, args) => { // 대리 서버에 직접 요청(브라우저 없이). {status, body}
    const r = await fetch(`${server.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  const addDirect = (team, delta, code = ADMIN_CODE) => direct('score_add', { p_code: code, p_team: team, p_delta: delta });
  const addReq = (team, delta, req) => direct('score_add', { p_code: ADMIN_CODE, p_team: team, p_delta: delta, p_req: req });
  const reapplySql = () => { // supabase.sql 을 (시험용 비밀번호로) 그대로 다시 적용
    let sql = readFileSync(join(ROOT, 'supabase.sql'), 'utf8');
    sql = sql.replace("values ('admin_code', '여기를-바꾸세요')", `values ('admin_code', '${ADMIN_CODE}')`);
    return spawnSync(join(process.env.PGBIN || '/opt/homebrew/bin', 'psql'), ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-f', '-'], { input: sql, encoding: 'utf8' });
  };
  const reqRows = async () => (await db.query('select req, created_at from score_requests order by req')).rows;

  async function scenario(num, name, fn) {
    if (only.length && !only.includes(String(num))) return;
    const t0 = Date.now();
    const s = { num, name, checks: 0, fails: [], notes: [], guards: [], errors: [], ctxs: [], consoles: [] };
    s.ok = (c, msg) => { s.checks++; if (!c) s.fails.push(msg); return !!c; };
    const norm = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => (p < q ? -1 : 1))) : v)); // 키 순서는 무시
    s.eq = (a, b, msg) => s.ok(norm(a) === norm(b), `${msg}: 실제 ${JSON.stringify(a)} / 기대 ${JSON.stringify(b)}`);
    s.note = (m) => s.notes.push(m);
    cur = s;
    process.stdout.write(`[${num}] ${name} ... `);
    try { await fn(s); } catch (e) { s.fails.push('예외: ' + String(e.stack || e).split('\n').slice(0, 6).join(' | ')); }
    for (const g of s.guards) s.ok(g.blocked.length === 0, `허용 안 된 외부 요청: ${g.blocked.join(', ')}`); // 운영 DB 등 외부 접근 0건
    s.ok(s.errors.length === 0, `페이지 오류(pageerror): ${s.errors.join(' | ')}`);
    s.ok(!s.consoles.some((t) => t.includes(ADMIN_CODE)), '콘솔에 관리자 비밀번호가 안 나옴');
    for (const c of s.ctxs) await c.close().catch(() => {});
    const ok = s.fails.length === 0;
    results.push({ num, name, ok, checks: s.checks, fails: s.fails, notes: s.notes, ms: Date.now() - t0 });
    console.log(`${ok ? '통과' : '실패'} (${s.checks}개 확인, ${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    for (const f of s.fails) console.log('    ✗ ' + f);
    for (const n of s.notes) console.log('    · ' + n);
    cur = null;
  }

  /** 새 context(+가드). code:true 면 관리자 페이지에 들어간 적 있는 기기처럼 localStorage 에 맞는 비밀번호를 미리 둔다. */
  async function newCtx(o = {}) {
    const { code, ...rest } = o;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ko-KR', ...rest });
    const g = await guardNetwork(ctx, server.url);
    cur.guards.push(g);
    cur.ctxs.push(ctx);
    ctx.on('page', (p) => { p.on('pageerror', (e) => cur.errors.push(e.message)); p.on('console', (m) => cur.consoles.push(m.text())); });
    if (code) await ctx.addInitScript((c) => { try { localStorage.setItem('team-picker-admin', JSON.stringify(c)); } catch {} }, ADMIN_CODE);
    const page = await ctx.newPage();
    track(page);
    return { ctx, page, guard: g };
  }
  // 이 페이지가 보낸 rpc 요청 기록(응답을 막거나 끊어도 '보냈는지'는 남음)
  function track(page) {
    page.rpcs = [];
    page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([a-z_]+)$/); if (m) page.rpcs.push(m[1]); });
    page.nrpc = (fn) => page.rpcs.filter((x) => x === fn).length;
    return page;
  }
  const sc = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__score)));
  const wait = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 30 });
  const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
  const gateIdle = (page) => wait(page, () => { const d = window.__score; return d && d.view === 'login' && !d.busy && d.gate !== 'checking'; });
  const waitBoard = (page, t) => wait(page, () => { const d = window.__score; return d && d.view === 'board' && d.ready; }, null, t);
  /** 입구: 서버 확인이 끝날 때까지 기다린 뒤(같은 탭이면 저절로 들어감) 아직 입구면 비밀번호를 넣고 Enter. 직접 넣었으면 true */
  async function enterGate(page, pw = ADMIN_CODE) {
    await wait(page, () => { const d = window.__score; return d && (d.view !== 'login' || (!d.busy && d.gate !== 'checking')); });
    if ((await sc(page)).view !== 'login') return false;
    await page.locator('#code').fill(pw);
    await page.locator('#code').press('Enter');
    await wait(page, () => { const d = window.__score; return d && (d.view !== 'login' || (!d.busy && d.gate !== 'checking')); });
    if ((await sc(page)).view === 'login') throw new Error(`입구를 통과하지 못함: ${await page.locator('#loginErr').innerText()}`);
    return true;
  }
  async function login(page, q = '') {
    await page.goto(`${server.url}/score.html${q}`);
    await enterGate(page);
    await waitBoard(page);
    return page;
  }
  const idle = (page, t = 20000) => wait(page, () => { const d = window.__score; return d && d.phase === 'idle' && !d.animating && !d.busy; }, null, t);
  const settled = async (page) => { await wait(page, () => { const d = window.__score; return d.phase === 'idle' && !d.animating && document.querySelectorAll('.glow-up, .glow-down, .hit-up, .hit-down').length === 0; }); };
  const notBusy = (page) => wait(page, () => window.__score.view === 'board' && !window.__score.busy);
  const pick = (page, t) => page.locator(`#pick-${t}`).click();
  const textOf = (page, t) => page.locator(`#score-${t}`).evaluate((e) => e.textContent.replace(/\s+/g, ''));
  /** 점수를 주고(고른 팀 + 단추 또는 직접 입력) 서버 답이 올 때까지 기다림. 연출 끝까지는 안 기다림 */
  async function give(page, team, delta, { wait: w = true } = {}) {
    const n0 = (await sc(page)).calls.score_add; // 이 화면(새로 고침 뒤 0부터)이 보낸 score_add 수
    await pick(page, team);
    if (QUICK[delta]) await page.locator(QUICK[delta]).click();
    else {
      await page.locator('#customAmt').fill(String(Math.abs(delta)));
      await page.locator(delta > 0 ? '#addBtn' : '#subBtn').click();
    }
    if (w) { await wait(page, (n) => (window.__score.mode === 'practice' || window.__score.calls.score_add >= n) && !window.__score.busy, n0 + 1); }
  }
  /** 화면·서버·DB 가 모두 같은 값인지: 점수 숫자(텍스트·data-value·aria-label), __score.shown/server */
  async function consistent(page, s, label, expect) {
    await idle(page);
    const d = await dbScores();
    if (expect) s.eq(d, expect, `[${label}] DB 값`);
    const st = await sc(page);
    s.eq(st.shown, d, `[${label}] 화면(__score.shown)=DB`);
    s.eq(st.server, d, `[${label}] 마지막으로 받은 서버 값=DB`);
    for (const t of TEAMS) {
      const info = await page.locator(`#score-${t}`).evaluate((e) => ({ text: e.textContent.replace(/\s+/g, ''), val: e.dataset.value, spin: e.dataset.spin, aria: e.getAttribute('aria-label') }));
      s.eq([info.text, info.val, info.spin, info.aria], [fmt(d[t]), String(d[t]), '', `${KO[t]} 팀 ${fmt(d[t])}점`], `[${label}] ${KO[t]} 점수 표시(글자·data-value·aria-label)`);
    }
  }
  const clean = () => db.query('update team_scores set score = 0, updated_at = now()');
  /** 오류·저장 실패를 흉내 */
  const rejectAdd = (page, message = '시험용 저장 실패', status = 400) => page.route(/\/rpc\/score_add$/, (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message, code: 'P0001', details: null, hint: null }) }));
  const slowAdd = (page, ms) => page.route(/\/rpc\/score_add$/, async (r) => { await sleep(ms); r.fallback(); });
  const dropAdd = (page) => page.route(/\/rpc\/score_add$/, (r) => r.abort('failed')); // 서버에 닿지 않음
  const slowReply = (page, ms) => page.route(/\/rpc\/score_add$/, async (r) => { // 서버는 바로 반영하고 응답만 늦게 돌려줌(저장 중 새로 고침 시험)
    const resp = await fetch(`${server.url}/rest/v1/rpc/score_add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: r.request().postData() });
    const body = await resp.text();
    await sleep(ms);
    await r.fulfill({ status: resp.status, contentType: 'application/json', body }).catch(() => {});
  });
  // 브라우저 쪽 요청은 끊고(응답 못 받음), 같은 요청을 서버에는 ms 뒤에 보냄(늦게 도착한 요청). 보낸 본문들을 late 에 쌓음
  const lateArrival = (page, ms, late = []) => page.route(/\/rpc\/score_add$/, async (r) => {
    const body = r.request().postData();
    late.push(JSON.parse(body));
    setTimeout(() => { fetch(`${server.url}/rest/v1/rpc/score_add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {}); }, ms);
    return r.abort('failed');
  });
  const lostReply = (page) => page.route(/\/rpc\/score_add$/, async (r) => { // 서버는 반영하지만 응답이 끊김
    await fetch(`${server.url}/rest/v1/rpc/score_add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: r.request().postData() });
    return r.abort('failed');
  });
  // 연출이 도는 시간 기록: animating 이 처음 true 가 된 때 ~ false 가 된 때(ms)
  const recordSpin = (page) => page.evaluate(() => { window.__spinRec = []; (function f() { const a = window.__score.animating; const L = window.__spinRec; if (!L.length || L[L.length - 1].a !== a) L.push({ a, t: performance.now() }); requestAnimationFrame(f); })(); });
  const spinMs = (page) => page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))); const L = window.__spinRec; const a = L.find((x) => x.a); const b = a && L.find((x) => !x.a && x.t > a.t); return a && b ? b.t - a.t : JSON.stringify([L.map((x) => [x.a, Math.round(x.t)]), Math.round(performance.now()), window.__score.animating, window.__score.phase]); });
  const REDUCED = { reducedMotion: 'reduce' };
  // 세어 올라가는 연출 표본: 15ms 마다(setInterval — requestAnimationFrame 에 기대지 않음) 팀별로 지금 보이는 값(__score.display)·점수 칸 DOM(data-cur·자리별 칸의 굴러가는 정도·위치)을 모음
  const watchStart = (page, teams) => page.evaluate((teams) => {
    if (window.__w) clearInterval(window.__w.id);
    const w = (window.__w = { id: 0, rows: Object.fromEntries(teams.map((t) => [t, []])) });
    const t0 = performance.now();
    w.id = setInterval(() => {
      const d = window.__score;
      for (const t of teams) {
        const box = document.getElementById(`score-${t}`);
        const dgs = [...box.querySelectorAll('.dg')];
        const sg = box.querySelector('.sg');
        w.rows[t].push({
          t: performance.now() - t0, anim: d.animating && !!d.spinning[t], spin: d.spinning[t], disp: d.display[t], shown: d.shown[t], cur: box.dataset.cur, text: box.textContent.replace(/\s+/g, ''),
          sg: sg ? sg.style.opacity : null,
          wheels: dgs.map((e, i) => { const st = e.firstElementChild; return { r: dgs.length - 1 - i, w: Math.round(e.getBoundingClientRect().width * 10) / 10, hid: e.style.display === 'none', roll: e.classList.contains('roll'), d: e.dataset.d, cells: st.textContent, tf: st.style.transform, x: Math.round(e.getBoundingClientRect().left * 10) / 10 }; }),
        });
      }
    }, 15);
  }, teams);
  const watchStop = (page) => page.evaluate(() => { clearInterval(window.__w.id); return window.__w.rows; });
  const tfOf = (w) => { const m = /translate3d\(0px, (-?[\d.]+)%/.exec(w.tf || ''); return m ? parseFloat(m[1]) : null; };
  /** 한 팀의 연출 표본이 "from 에서 to 까지 한 방향으로, 정확히 to 에 멈추는 세기"인지 모아서 확인(길이 1.8~2.5초·사이 값·한 방향·건너뜀 없는 마지막 걸음·처음 빠르고 끝에서 느림) */
  function checkCount(s, rows, { lab, from, to }) {
    const dir = to > from ? 1 : -1;
    const D = Math.abs(to - from);
    const an = rows.filter((r) => r.anim);
    s.ok(an.length > 20, `[${lab}] 연출 표본이 충분함(${an.length}개)`);
    if (an.length < 20) return;
    const vals = an.map((r) => r.disp);
    const lo = Math.min(from, to), hi = Math.max(from, to);
    s.ok(vals.every((v) => v >= lo && v <= hi), `[${lab}] 연출 동안 보이는 값은 늘 ${from} 과 ${to} 사이(표본 ${Math.min(...vals)}~${Math.max(...vals)})`);
    const back = vals.findIndex((v, i) => i > 0 && (v - vals[i - 1]) * dir < 0);
    s.ok(back < 0, `[${lab}] 한 방향으로만 움직임(되돌아가는 표본 ${back < 0 ? '없음' : `#${back}: ${vals[back - 1]} → ${vals[back]}`})`);
    s.ok(an.every((r) => r.cur === String(r.disp)), `[${lab}] 점수 칸의 data-cur 가 __score.display 와 같음`);
    const dur = an[an.length - 1].t - an[0].t;
    s.ok(dur >= 1800 && dur <= 2500, `[${lab}] 연출 길이 1.8~2.5초: ${Math.round(dur)}ms`);
    const end = rows.find((r) => !r.anim && r.t > an[an.length - 1].t);
    s.ok(end && end.disp === to && end.shown === to && end.cur === String(to), `[${lab}] 끝에서 정확히 ${to}(display·shown·data-cur): ${end ? `${end.disp}/${end.shown}/${end.cur}` : '끝 표본 없음'}`);
    const seen = new Set(vals);
    const need = Array.from({ length: Math.min(8, D) }, (_, j) => to - dir * j); // 마지막 8걸음(차이가 8보다 작으면 전부)
    s.ok(need.every((v) => seen.has(v)), `[${lab}] 끝 무렵 마지막 ${need.length}걸음이 건너뛰지 않고 한 칸씩 보임(빠진 값: ${need.filter((v) => !seen.has(v)).join(',') || '없음'})`);
    if (D <= 24) s.ok(Array.from({ length: D + 1 }, (_, j) => from + dir * j).every((v) => seen.has(v)), `[${lab}] 차이가 작아(${D}) 걸음이 하나도 안 빠지고 다 보임(보인 값 ${[...seen].length}개)`);
    if (D >= 50) {
      const prog = (r) => Math.abs(r.disp - from) / D;
      const t50 = an.find((r) => prog(r) >= 0.5), t90 = an.find((r) => prog(r) >= 0.9);
      s.ok(t50.t - an[0].t < 700, `[${lab}] 처음엔 빨라서 절반(${D / 2})이 0.7초 안에 옴: ${Math.round(t50.t - an[0].t)}ms`);
      s.ok(an[an.length - 1].t - t90.t >= 600, `[${lab}] 끝에서는 느려져서 마지막 10%에 0.6초 넘게 걸림: ${Math.round(an[an.length - 1].t - t90.t)}ms`);
    }
    // 굴러가는 방향: 일의 자리 칸이 같은 두 숫자 사이를 굴러가는 연속 표본에서, 올릴 때는 띠가 위로(변환값이 더 작아짐), 내릴 때는 아래로(더 커짐). 연출이 시작되고 1.1초 뒤(속도가 느려진 뒤)부터만 봄
    let pairs = 0, wrong = 0;
    for (let i = 1; i < an.length; i++) {
      const a = an[i - 1].wheels.find((w) => w.r === 0), b = an[i].wheels.find((w) => w.r === 0);
      if (an[i].t - an[0].t < 1100 || !a || !b || !a.roll || !b.roll || a.cells !== b.cells || tfOf(a) == null || tfOf(b) == null || tfOf(a) === tfOf(b)) continue;
      pairs++;
      if ((tfOf(b) - tfOf(a)) * dir > 0) { wrong++; s.note(`[${lab}] 반대 방향 표본: ${an[i - 1].t.toFixed(0)}ms ${JSON.stringify(a)} → ${an[i].t.toFixed(0)}ms ${JSON.stringify(b)}`); } // dir=+1 이면 변환값이 줄어야(더 위로) 함
    }
    s.ok(pairs >= 3 && wrong === 0, `[${lab}] 일의 자리가 ${dir > 0 ? '위로' : '아래로'} 굴러감(비교 ${pairs}쌍 중 반대 방향 ${wrong})`);
  }

  // 화면 안에 들어 있는지: 네 팀·네 점수·조작부·오류 상자가 무대 안, 점수가 칸·이름·오류 상자와 겹치지 않음, 문서가 안 넘침
  const layoutIssues = (page) => page.evaluate(() => {
    const out = [];
    const stageEl = document.getElementById('stage');
    const stage = stageEl.getBoundingClientRect();
    const R = (el) => el.getBoundingClientRect();
    const visible = (el) => { const r = R(el), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const inside = (r, box, slack = 1.5) => r.left >= box.left - slack && r.right <= box.right + slack && r.top >= box.top - slack && r.bottom <= box.bottom + slack;
    const hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const de = document.documentElement;
    if (de.scrollWidth > innerWidth + 1 || de.scrollHeight > innerHeight + 1) out.push(`문서 스크롤 ${de.scrollWidth}x${de.scrollHeight} > ${innerWidth}x${innerHeight}`);
    if (!inside(stage, { left: 0, top: 0, right: innerWidth, bottom: innerHeight })) out.push('무대가 화면 밖');
    const alert = document.getElementById('alert');
    const alertR = alert && !alert.hidden ? R(alert) : null;
    if (alertR && !inside(alertR, stage)) out.push(`오류 상자가 무대 밖 (${Math.round(alertR.left)},${Math.round(alertR.top)},${Math.round(alertR.right)},${Math.round(alertR.bottom)})`);
    for (const t of ['red', 'blue', 'yellow', 'green']) {
      const team = document.getElementById(`team-${t}`), score = document.getElementById(`score-${t}`), names = document.getElementById(`names-${t}`);
      if (!team || !visible(team)) { out.push(`${t} 팀 칸이 안 보임`); continue; }
      const tr = R(team);
      if (!inside(tr, stage)) out.push(`${t} 팀 칸이 무대 밖`);
      if (!visible(score)) { out.push(`${t} 점수가 안 보임`); continue; }
      const vis = score.querySelector('.vis');
      const vr = R(vis);
      if (!inside(vr, tr)) out.push(`${t} 점수가 팀 칸 밖 vis(${Math.round(vr.left)},${Math.round(vr.top)},${Math.round(vr.right)},${Math.round(vr.bottom)}) 칸(${Math.round(tr.left)},${Math.round(tr.top)},${Math.round(tr.right)},${Math.round(tr.bottom)})`);
      const box = R(score.parentElement);
      if (vr.width > box.width + 1) out.push(`${t} 점수 너비 ${Math.round(vr.width)} > 점수 칸 ${Math.round(box.width)}`);
      if (!inside(vr, { left: 0, top: 0, right: innerWidth, bottom: innerHeight })) out.push(`${t} 점수가 화면 밖`);
      const nr = R(names);
      if (visible(names) || getComputedStyle(names).visibility === 'hidden') { if (vr.bottom > nr.top + 1) out.push(`${t} 점수가 이름 줄과 겹침`); if (!inside(nr, tr)) out.push(`${t} 이름 줄이 팀 칸 밖`); }
      if (alertR && hit(vr, alertR)) out.push(`${t} 점수를 오류 상자가 가림`);
      for (const o of ['red', 'blue', 'yellow', 'green']) if (o < t && hit(vr, R(document.getElementById(`score-${o}`).querySelector('.vis')))) out.push(`${t}·${o} 점수끼리 겹침`);
    }
    const ctl = document.getElementById('controls');
    const cr = R(ctl);
    if (!inside(cr, stage)) out.push('조작부가 무대 밖');
    for (const el of ctl.querySelectorAll('button, input, .status, kbd')) if (visible(el) && !inside(R(el), stage)) out.push(`조작부 요소가 무대 밖: ${el.id || el.className}`);
    for (const el of document.querySelectorAll('.top button, .top a, .top h1, .top .badge')) if (visible(el) && !inside(R(el), stage)) out.push(`맨 위 줄 요소가 무대 밖: ${el.id || el.tagName}`);
    const teamsBottom = Math.max(...['red', 'blue', 'yellow', 'green'].map((t) => R(document.getElementById(`team-${t}`)).bottom));
    if (teamsBottom > cr.top + 1.5) out.push(`팀 칸(${Math.round(teamsBottom)})이 조작부(${Math.round(cr.top)})를 넘어감`);
    return out;
  });
  const fontSizes = (page) => page.evaluate(() => {
    const px = (sel) => { const el = document.querySelector(sel); return el ? parseFloat(getComputedStyle(el).fontSize) : 0; };
    const ctl = [...document.querySelectorAll('#controls .btn, #controls input, #controls .status')].map((e) => parseFloat(getComputedStyle(e).fontSize));
    return { score: ['red', 'blue', 'yellow', 'green'].map((t) => px(`#score-${t}`)), names: px('.names'), head: px('.team-h .tn'), controlMax: Math.max(...ctl) };
  });
  // 글자 크기 전환(.3초)·강조 애니메이션이 끝날 때까지 기다림(연출 자체는 JS 로 도므로 기다리지 않음)
  const fontSettled = (page) => page.evaluate(async () => { for (let i = 0; i < 60; i++) { if (!document.getAnimations().some((a) => a.playState === 'running' && (a.transitionProperty === 'font-size' || a.transitionProperty === 'filter'))) return; await new Promise((r) => setTimeout(r, 50)); } });
  // 숫자 줄이 점수 칸(안쪽 너비)보다 조금이라도 넓어진 최대 비율과 그 시간(ms)을 잼(허용 오차 0 — 자릿수가 늘어 글자 크기가 바뀌는 동안의 넘침 확인용)
  const overflowProbe = (page) => page.evaluate(() => { window.__ov = { max: 0, ms: 0, last: null }; (function f(t) { const o = window.__ov; const dt = o.last == null ? 0 : t - o.last; o.last = t; for (const tm of ['red', 'blue', 'yellow', 'green']) { const sc = document.getElementById(`score-${tm}`); const box = sc.parentElement; const w = sc.querySelector('.vis').getBoundingClientRect().width; const cw = box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) * 2; const r = w / cw; if (r > 1) { if (r > o.max) o.info = { tm, r, fs: getComputedStyle(sc).fontSize, wem: sc.style.getPropertyValue('--wem'), cls: sc.className, val: sc.dataset.value, spin: sc.dataset.spin, vis: w, cw }; o.max = Math.max(o.max, r); o.ms += dt; } } requestAnimationFrame(f); })(performance.now()); });
  const checkLayout = async (page, s, label) => {
    await page.mouse.move(1, 1);
    const issues = await layoutIssues(page);
    for (const i of issues) layoutFindings.push(`${label}: ${i}`);
    s.eq(issues, [], `[${label}] 네 팀·네 점수·조작부가 화면 안, 겹침·넘침 없음`);
  };

  // ════════════════════════════════════════════════════════════════
  await scenario(1, '입구: 비밀번호 전 DOM·요청 없음, 틀림/통신 오류/서버 오류 구분, 저장된 비밀번호 무시, 새로 고침·새 탭, 잠그기', async (s) => {
    await db.query('update team_scores set score = 0');
    resetCalls();
    const { ctx, page } = await newCtx({ code: true }); // 관리자 페이지에 들어간 적 있는 기기(맞는 비밀번호가 localStorage 에)
    for (const q of ['', '?practice=1']) {
      await page.goto(`${server.url}/score.html${q}`);
      await gateIdle(page); await sleep(250);
      const lab = q || '일반';
      const dom = await page.evaluate(() => ({ app: document.querySelectorAll('.team, #teams, #controls, [id^="score-"], [id^="names-"], #addBtn, #customAmt').length, stage: [...document.getElementById('stage').children].map((e) => e.id || e.tagName).sort(), view: document.getElementById('stage').dataset.view, title: document.title, nums: /\d{2,}/.test(document.body.innerText) }));
      s.eq(dom.app, 0, `[${lab}] 비밀번호 전: 점수판·조작부·이름 DOM 없음(저장된 관리자 비밀번호가 있어도)`);
      s.eq([dom.view, dom.stage, dom.title], ['login', ['error', 'loginView'], '팀 점수판'], `[${lab}] 입구 화면(무대 안에는 입구뿐 · 탭 제목에 연습 표시 없음)`);
      s.ok(!dom.nums, `[${lab}] 입구 글에 점수 같은 숫자가 없음`);
      s.eq(server.calls.length, 0, `[${lab}] 비밀번호를 넣기 전에는 서버 요청 0건(점수 요청 없음)`);
      s.eq((await sc(page)).calls, { board_state: 0, score_state: 0, score_add: 0 }, `[${lab}] __score.calls 도 0`);
    }
    s.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('team-picker-admin'))), ADMIN_CODE, 'localStorage 의 관리자 페이지 비밀번호는 그대로(안 쓰고 안 지움)');
    // 틀린 비밀번호
    await page.goto(`${server.url}/score.html`); await gateIdle(page);
    await page.locator('#code').fill('틀린-비밀번호-1'); await page.locator('#code').press('Enter'); await gateIdle(page);
    const wrong = await page.evaluate(() => ({ kind: document.getElementById('loginErr').dataset.kind, text: document.getElementById('loginErr').textContent, color: getComputedStyle(document.getElementById('loginErr')).color, recon: !document.getElementById('reconnectBtn').hidden, gate: sessionStorage.getItem('score-gate') }));
    s.eq([wrong.kind, wrong.recon, wrong.gate], ['wrong', false, null], '틀린 비밀번호: data-kind=wrong · 다시 연결 단추 없음 · 기억 안 함');
    s.ok(/맞지 않아요/.test(wrong.text), `틀린 비밀번호 안내: ${wrong.text}`);
    s.eq(await page.evaluate(() => document.querySelectorAll('.team, #teams').length), 0, '틀린 비밀번호 뒤에도 점수판 DOM 없음');
    s.eq(server.calls.map((c) => `${c.fn}:${c.status}`), ['board_state:400'], '요청은 틀린 비밀번호 확인 한 건뿐(점수 요청 없음)');
    // 통신 오류(틀렸다는 뜻이 아님)
    let down = 1;
    await page.route(/\/rpc\/board_state$/, async (r) => { if (down > 0) { down--; return r.abort('failed'); } return r.fallback(); });
    await page.locator('#code').fill(ADMIN_CODE); await page.locator('#code').press('Enter'); await gateIdle(page);
    const off = await page.evaluate(() => ({ kind: document.getElementById('loginErr').dataset.kind, text: document.getElementById('loginErr').textContent, color: getComputedStyle(document.getElementById('loginErr')).color, recon: !document.getElementById('reconnectBtn').hidden, gate: sessionStorage.getItem('score-gate') }));
    s.eq([off.kind, off.recon, off.gate], ['offline', true, null], '통신 오류: data-kind=offline · 다시 연결 단추 보임 · 아직 기억 안 함');
    s.ok(/틀렸다는 뜻은 아니에요/.test(off.text) && !/맞지 않아요/.test(off.text), `통신 오류 안내(틀림과 구분): ${off.text}`);
    s.ok(off.color !== wrong.color, `통신 오류(노랑 ${off.color})와 틀림(빨강 ${wrong.color})은 색이 다름`);
    s.eq(await page.evaluate(() => [document.getElementById('code').value, document.querySelectorAll('.team').length]), ['', 0], '통신 오류: 입력 칸 비움 · 점수판 DOM 없음');
    // 서버 오류(통신은 됨)
    let fail500 = 1;
    await page.route(/\/rpc\/board_state$/, async (r) => { if (fail500 > 0) { fail500--; return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'internal error', code: 'XX000' }) }); } return r.fallback(); });
    await page.locator('#reconnectBtn').click(); await gateIdle(page);
    const srv = await page.evaluate(() => ({ kind: document.getElementById('loginErr').dataset.kind, text: document.getElementById('loginErr').textContent }));
    s.eq(srv.kind, 'server', '서버 오류(500): data-kind=server');
    s.ok(/서버가 확인하지 못했어요/.test(srv.text) && !/인터넷/.test(srv.text) && !/맞지 않아요/.test(srv.text), `서버 오류 안내: ${srv.text}`);
    await page.locator('#reconnectBtn').click(); await waitBoard(page);
    s.ok(true, "'다시 연결'로 들어감(비밀번호를 다시 안 넣음)");
    s.eq(await page.evaluate(() => sessionStorage.getItem('score-gate')), ADMIN_CODE, '들어오면 이 탭에만 기억(sessionStorage)');
    s.eq(await page.evaluate(() => [Object.keys(localStorage), document.cookie]), [['team-picker-admin'], ''], '오래 남는 저장소(localStorage·쿠키)에 새로 적은 것 없음');
    s.eq(await page.evaluate(() => [document.getElementById('stage').dataset.view, document.getElementById('stage').dataset.mode]), ['board', 'live'], '들어온 뒤 화면');
    // 같은 탭 새로 고침: 묻지 않고 서버에 다시 확인
    await page.unroute(/\/rpc\/board_state$/);
    resetCalls();
    await page.reload();
    s.eq(await enterGate(page), false, '같은 탭 새로 고침: 비밀번호를 다시 묻지 않음');
    await waitBoard(page);
    s.ok(calls('board_state').length >= 1 && calls('board_state')[0].status === 200, `새로 고침 뒤 서버에 다시 확인함(board_state ${calls('board_state').length}건)`);
    // 새 탭(같은 context)은 다시 물음
    const p2 = track(await ctx.newPage());
    await p2.goto(`${server.url}/score.html`); await gateIdle(p2);
    s.eq(await p2.evaluate(() => [document.getElementById('stage').dataset.view, sessionStorage.getItem('score-gate'), document.querySelectorAll('.team').length]), ['login', null, 0], '같은 브라우저의 새 탭: 입구 · 기억 없음 · 점수판 DOM 없음');
    await p2.close();
    // 잠그기: 확인 상자 → 취소하면 그대로, 확인하면 기억 삭제 후 입구
    await page.locator('#lockBtn').click();
    s.ok(await page.locator('#dlg').isVisible(), '잠그기 단추: 확인 상자가 뜸');
    s.ok(/잠글까요/.test(await page.locator('#dlgTitle').innerText()), '확인 상자 제목');
    await page.locator('#dlgCancel').click();
    s.eq(await page.evaluate(() => [document.getElementById('dlg').hidden, sessionStorage.getItem('score-gate'), document.getElementById('stage').dataset.view]), [true, ADMIN_CODE, 'board'], '취소하면 그대로(기억 유지·점수판 그대로)');
    await page.locator('#lockBtn').click();
    await Promise.all([page.waitForEvent('load'), page.locator('#dlgOk').click()]);
    await gateIdle(page);
    s.eq(await page.evaluate(() => [sessionStorage.getItem('score-gate'), document.querySelectorAll('.team, #teams, #controls').length, document.getElementById('stage').dataset.view]), [null, 0, 'login'], '잠그면 이 탭의 기억 삭제 · 점수판 DOM 없음 · 입구');
    s.ok(/화면을 잠갔어요/.test(await page.locator('#gateInfo').innerText()), `잠근 뒤 입구 안내: ${await page.locator('#gateInfo').innerText()}`);
    s.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('team-picker-admin'))), ADMIN_CODE, '잠가도 관리자 페이지의 localStorage 는 건드리지 않음');
    await page.reload(); await gateIdle(page);
    s.eq((await sc(page)).view, 'login', '잠근 뒤 새로 고쳐도 입구(다시 비밀번호를 넣어야 함)');
    // 비밀번호가 바뀐 뒤 새로 고침 → 기억 지우고 입구
    await enterGate(page); await waitBoard(page);
    await db.query("update public.config set value = 'test-admin-code-changed' where key = 'admin_code'");
    try {
      await page.reload(); await gateIdle(page);
      s.eq(await page.evaluate(() => [document.getElementById('loginErr').dataset.kind, sessionStorage.getItem('score-gate')]), ['wrong', null], '[비밀번호 바뀜] 새로 고침 → 입구 · 기억 지움');
      s.ok(/바뀌었어요/.test(await page.locator('#loginErr').innerText()), '[비밀번호 바뀜] 안내');
    } finally { await db.query(`update public.config set value = '${ADMIN_CODE}' where key = 'admin_code'`); }
    // 잠그는 순간 5초 받기를 멈춤: 새로 불러오기가 느려(여기서는 10초 붙잡음) 옛 화면이 한동안 남아 있어도 score_state·board_state 가 더 안 나감
    await enterGate(page); await waitBoard(page);
    const pn = (await sc(page)).calls.score_state;
    await wait(page, (n) => window.__score.calls.score_state > n, pn, 9000); await sleep(300); // 5초 받기가 한 번 끝나 다음 받기가 예약된 상태에서 잠금
    await page.route(/\/score\.html/, async (r) => { await sleep(10000); await r.fallback().catch(() => {}); });
    await page.locator('#lockBtn').click();
    await page.locator('#dlgOk').click({ noWaitAfter: true }); // 새 화면이 올 때까지 기다리지 않음
    await sleep(600); // 이미 날아간 받기가 있어도 도착할 시간
    const pollN = () => calls('score_state').length + calls('board_state').length + page.nrpc('score_state') + page.nrpc('board_state'); // 서버가 받은 수 + 브라우저가 보낸 수(중간에 끊겨도 셈)
    const poll0 = pollN();
    await sleep(7000);
    s.eq(pollN(), poll0, '[잠근 뒤] 7초(5초 받기 주기보다 길게) 동안 score_state·board_state 요청이 늘지 않음');
    await gateIdle(page);
    s.eq((await sc(page)).view, 'login', '[잠근 뒤] 새로 불러온 뒤에도 입구');
    await page.unroute(/\/score\.html/);
    s.eq(calls('score_add').length + calls('admin_clear').length, 0, '입구를 시험하는 동안 점수 쓰기 요청 0건');
  });

  await scenario(2, '점수 주기·빼기와 DB 값(네 팀 각각·직접 입력·한도) + 서버 함수 score_add(합산·오류·권한)', async (s) => {
    await clean(); await resetRoster(db, { picked: true }); resetCalls();
    const { page } = await newCtx(REDUCED); // 움직임 줄이기: 연출 없이 바로 바뀌어 빠름(연출은 다른 시나리오)
    await login(page);
    await consistent(page, s, '처음', ZERO);
    s.eq(await page.evaluate(() => [...document.querySelectorAll('.team')].map((e) => e.id)), ['team-red', 'team-blue', 'team-yellow', 'team-green'], '네 팀 칸이 빨강·파랑·노랑·초록 순서로 있음');
    s.eq(await page.locator('.team-h .tn').allInnerTexts(), ['빨강 팀', '파랑 팀', '노랑 팀', '초록 팀'], '팀 이름');
    // 네 팀 각각 + 와 −
    const exp = { ...ZERO };
    for (const [t, d] of [['red', 10], ['blue', 50], ['yellow', 100], ['green', -10], ['red', -50], ['blue', -10], ['yellow', 10], ['green', 50]]) {
      await give(page, t, d); exp[t] += d;
      s.eq(await dbScores(), exp, `${KO[t]} ${d > 0 ? '+' : ''}${d} → DB`);
    }
    await consistent(page, s, '단추로 줌', exp);
    s.eq(calls('score_add').map((c) => [c.args.p_team, c.args.p_delta]), [['red', 10], ['blue', 50], ['yellow', 100], ['green', -10], ['red', -50], ['blue', -10], ['yellow', 10], ['green', 50]], '서버에는 "이 팀에 얼마"만 보냄(점수 전체를 덮어쓰지 않음)');
    s.ok(calls('score_add').every((c) => c.status === 200 && c.args.p_code === ADMIN_CODE && Object.keys(c.args).sort().join() === 'p_code,p_delta,p_req,p_team' && /^[A-Za-z0-9_-]{8,64}$/.test(c.args.p_req)), 'score_add 인자는 p_code·p_team·p_delta·p_req(요청 번호 8~64자 영문·숫자·-·_)');
    s.eq(new Set(calls('score_add').map((c) => c.args.p_req)).size, calls('score_add').length, '점수를 줄 때마다 요청 번호가 새로 만들어짐(서로 다름)');
    // 직접 입력: 더하기·빼기
    await pick(page, 'red');
    await page.locator('#customAmt').fill('30'); await page.locator('#addBtn').click(); await notBusy(page); exp.red += 30;
    await page.locator('#customAmt').fill('12'); await page.locator('#subBtn').click(); await notBusy(page); exp.red -= 12;
    await page.locator('#customAmt').fill('1,500'); await page.locator('#addBtn').click(); await notBusy(page); exp.red += 1500; // 쉼표는 무시
    s.eq(await dbScores(), exp, '직접 입력: 30 더하기 · 12 빼기 · 1,500 더하기 → DB');
    s.eq(await page.locator('#customAmt').inputValue(), '', '성공하면 입력 칸이 비워짐');
    await page.locator('#customAmt').fill('abc12x'); s.eq(await page.locator('#customAmt').inputValue(), '12', '입력 칸은 숫자만 받음(글자는 지워짐)'); await page.locator('#customAmt').fill('');
    // 거절되는 입력: 요청 0건 + 안내
    const n0 = page.nrpc('score_add');
    await page.locator('#customAmt').fill('0'); await page.locator('#addBtn').click();
    s.ok(/0점은 줄 수 없어요/.test(await page.locator('#status').innerText()), '0점: 안내');
    await page.locator('#customAmt').fill(''); await page.locator('#addBtn').click();
    s.ok(/숫자로 넣어 주세요/.test(await page.locator('#status').innerText()), '빈 칸: 안내');
    await page.locator('#customAmt').fill('1000001'); await page.locator('#addBtn').click();
    s.ok(/1,000,000점까지/.test(await page.locator('#status').innerText()), '한 번에 1,000,000 넘게: 안내');
    s.eq(page.nrpc('score_add'), n0, '거절된 입력은 서버 요청 0건');
    // 한 번에 1,000,000 은 됨
    await page.locator('#customAmt').fill('1000000'); await page.locator('#addBtn').click(); await notBusy(page); exp.red += 1000000;
    s.eq(await dbScores(), exp, '정확히 1,000,000 은 들어감');
    await consistent(page, s, '직접 입력 뒤(1,001,xxx 처럼 큰 점수·쉼표)', exp);
    // 마이너스 점수도 그대로 보임
    await pick(page, 'green');
    await page.locator('#customAmt').fill('500'); await page.locator('#subBtn').click(); await notBusy(page); exp.green -= 500;
    await consistent(page, s, '0 아래(마이너스)', exp);
    s.eq(await textOf(page, 'green'), '−460', '0 아래 점수는 막지 않고 − 를 붙여 그대로 보임');
    // ── 서버 함수 score_add 자체 ──
    await clean();
    const st0 = await direct('score_state', { p_code: ADMIN_CODE });
    s.eq([st0.status, st0.body], [200, ZERO], 'anon 이 score_state 를 부를 수 있고 네 팀 키가 항상 있음');
    const par = await Promise.all(Array.from({ length: 20 }, () => addDirect('red', 7)));
    s.ok(par.every((r) => r.status === 200 && Object.keys(r.body).sort().join() === 'blue,green,red,yellow'), 'score_add 는 네 팀 점수를 score_state 와 같은 꼴로 돌려줌');
    s.eq((await dbScores()).red, 140, '동시에 20번 +7 → 140(서버에서 현재 값에 더하므로 서로 모르게 줘도 합산)');
    s.eq(Math.max(...par.map((r) => r.body.red)), 140, '마지막으로 끝난 요청의 응답이 최종 합');
    const bad = [
      ['팀 이름 틀림', await addDirect('purple', 5), /팀/], ['팀 null', await direct('score_add', { p_code: ADMIN_CODE, p_team: null, p_delta: 5 }), /팀/],
      ['0점', await addDirect('red', 0), /점수를 넣어/], ['null 점수', await direct('score_add', { p_code: ADMIN_CODE, p_team: 'red', p_delta: null }), /점수를 넣어/],
      ['한 번에 1,000,001', await addDirect('red', 1000001), /1,000,000/], ['한 번에 −1,000,001', await addDirect('red', -1000001), /1,000,000/],
      ['틀린 비밀번호', await addDirect('red', 5, 'x'), /비밀번호/],
    ];
    for (const [name, r, re] of bad) s.ok(r.status === 400 && re.test(r.body.message), `${name}: 거절(400) ${r.body && r.body.message}`);
    s.eq((await dbScores()).red, 140, '거절된 요청은 점수를 바꾸지 않음');
    await setScores({ blue: 999999995 });
    const over = await addDirect('blue', 10);
    s.ok(over.status === 400 && /너무 커져요/.test(over.body.message), `총합이 +1,000,000,000 을 넘으면 거절: ${over.body.message}`);
    const edge = await addDirect('blue', 5);
    s.eq([edge.status, edge.body.blue], [200, 1000000000], '총합이 정확히 +1,000,000,000 은 들어감');
    await setScores({ blue: -999999995 });
    const under = await addDirect('blue', -10);
    s.ok(under.status === 400 && /너무 커져요/.test(under.body.message), `총합이 −1,000,000,000 아래로 가도 거절: ${under.body.message}`);
    s.eq((await addDirect('blue', -5)).body.blue, -1000000000, '총합이 정확히 −1,000,000,000 은 들어감');
    // 권한: anon 은 표를 직접 못 읽고 못 씀
    const c = await connect();
    try {
      await c.query('begin'); await c.query('set local role anon');
      let readErr = null, writeErr = null;
      try { await c.query('select * from team_scores'); } catch (e) { readErr = e.code; }
      await c.query('rollback'); await c.query('begin'); await c.query('set local role anon');
      try { await c.query('update team_scores set score = 1'); } catch (e) { writeErr = e.code; }
      await c.query('rollback');
      s.eq([readErr, writeErr], ['42501', '42501'], 'anon 은 team_scores 표를 직접 읽지도 쓰지도 못함(권한 없음)');
      const rls = (await c.query("select relrowsecurity from pg_class where relname = 'team_scores'")).rows[0];
      s.eq(rls.relrowsecurity, true, 'team_scores 는 행 수준 보안(RLS) 켜짐');
    } finally { await c.end(); }
    // supabase.sql 을 다시 적용해도 점수가 지워지지 않음
    await setScores({ red: 321, blue: -45, yellow: 6, green: 0 });
    const r = reapplySql();
    s.eq(r.status, 0, `supabase.sql 을 다시 적용해도 오류 없음${r.status ? ': ' + r.stderr.slice(0, 300) : ''}`);
    s.eq(await dbScores(), { red: 321, blue: -45, yellow: 6, green: 0 }, 'supabase.sql 을 다시 적용해도 쌓인 점수는 그대로');
    s.eq((await db.query('select count(*)::int n from team_scores')).rows[0].n, 4, '점수 표는 네 줄 그대로');
  });

  await scenario(3, '연달아 주기: 연타·Enter 두 번은 요청 한 번, 연출 중 같은 팀·다른 팀 바로 이어서, 마지막 값으로 정확히 멈춤, 연출 길이', async (s) => {
    await clean(); resetCalls();
    const { page } = await newCtx();
    await login(page);
    // (a) 연타: 응답이 느린 동안(0.9초) 같은 단추를 여러 번 눌러도 한 번
    await slowAdd(page, 900);
    await pick(page, 'red');
    await page.evaluate(() => { const b = document.querySelector('#q-p10'); for (let i = 0; i < 8; i++) b.click(); });
    await notBusy(page);
    s.eq([page.nrpc('score_add'), (await dbScores()).red], [1, 10], '[연타] 단추를 한꺼번에 8번 눌러도 요청 1번 · +10 한 번만');
    await idle(page);
    for (let i = 0; i < 4; i++) await page.keyboard.press('KeyW'); // 키 연타(앞 키가 요청 중이면 나머지는 무시)
    await notBusy(page); await idle(page);
    s.eq([page.nrpc('score_add'), (await dbScores()).red], [2, 60], '[연타] W 키를 빠르게 4번 눌러도 요청 1번 추가 · +50 한 번만');
    await page.locator('#customAmt').fill('7');
    await Promise.all([page.locator('#customAmt').press('Enter'), page.locator('#customAmt').press('Enter')]); // Enter 두 번
    await notBusy(page); await idle(page);
    s.eq([page.nrpc('score_add'), (await dbScores()).red], [3, 67], '[Enter 두 번] 직접 입력 7 + Enter 두 번도 요청 1번 · +7 한 번만');
    // 키 반복(repeat)은 점수를 안 줌
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const nRep = page.nrpc('score_add');
    await page.evaluate(() => { for (let i = 0; i < 5; i++) document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q', repeat: true, bubbles: true })); });
    await sleep(300);
    s.eq(page.nrpc('score_add'), nRep, '[키 반복] 키를 누르고 있어 반복되는 입력(repeat)은 점수를 안 줌');
    await page.unroute(/\/rpc\/score_add$/);
    // (b) 연출 중 같은 팀에 연속
    await clean(); await page.reload(); await waitBoard(page);
    resetCalls(); const preSends = page.nrpc('score_add'); // 여기부터 새로 셈
    await give(page, 'red', 10);
    await wait(page, () => window.__score.spinning.red === 'up');
    const mid = await page.locator('#score-red').evaluate((e) => [e.dataset.spin, e.classList.contains('spinning'), Number(e.dataset.cur) >= 0 && Number(e.dataset.cur) <= 10, e.querySelectorAll('.dg').length]);
    s.eq(mid, ['up', true, true, 2], '[연출] 점수가 오르면 data-spin=up · 도는 중 표시 · 보이는 값(data-cur)은 0~10 사이 · 2자리(10)까지만 칸이 있음');
    await give(page, 'red', 50); // 앞 연출이 도는 중
    const chain = await sc(page);
    s.eq([chain.shown.red, chain.spinning.red, calls('score_add').length], [60, 'up', 2], '[연출 중 연속] 앞 연출이 도는 중에도 같은 팀에 다시 줄 수 있음 — 목표는 바로 60 으로 바뀌고 계속 도는 중(요청 2번)');
    await give(page, 'red', 10); await give(page, 'red', -5);
    await idle(page);
    await consistent(page, s, '같은 팀 연속(+10,+50,+10,−5)', { ...ZERO, red: 65 });
    s.eq(await textOf(page, 'red'), '65', '[마지막 값] 연속으로 줘도 마지막 값 65 에 정확히 멈춤');
    // (c) 다른 팀에 바로 이어서: 두 팀이 동시에 도는 순간이 있음, 네 팀 점수는 늘 보임
    await give(page, 'red', 100);
    await give(page, 'blue', -50); // 빨강이 도는 중에 파랑
    await wait(page, () => window.__score.spinning.red && window.__score.spinning.blue, null, 5000).then(() => s.ok(true, '[다른 팀] 빨강이 도는 중에 파랑을 줘서 두 팀이 동시에 도는 순간이 있음'), () => s.ok(false, '[다른 팀] 두 팀이 동시에 돌지 않음'));
    const dirs = await sc(page);
    s.ok(dirs.spinning.blue === 'down' || dirs.spinning.blue === null, '[다른 팀] 내려가는 점수는 아래로 굴러감(down)');
    const vis4 = await page.evaluate(() => ['red', 'blue', 'yellow', 'green'].map((t) => { const r = document.getElementById(`score-${t}`).getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    s.eq(vis4, [true, true, true, true], '[다른 팀] 도는 동안에도 네 팀 점수가 모두 화면 안에 보임');
    await idle(page);
    await consistent(page, s, '다른 팀 이어서 줌', { ...ZERO, red: 165, blue: -50 });
    // (d) 연출 길이: 큰 변화도 약 2초
    await recordSpin(page);
    await give(page, 'yellow', 100);
    await idle(page);
    const ms1 = await spinMs(page);
    await recordSpin(page);
    await pick(page, 'green'); await page.locator('#customAmt').fill('999999'); await page.locator('#addBtn').click(); await notBusy(page); await idle(page);
    const ms2 = await spinMs(page);
    s.ok(typeof ms1 === 'number' && ms1 >= 1800 && ms1 <= 2500, `[연출 길이] +100 은 약 2초: ${typeof ms1 === 'number' ? Math.round(ms1) + 'ms' : ms1}`);
    s.ok(typeof ms2 === 'number' && ms2 >= 1800 && ms2 <= 2500, `[연출 길이] +999,999 처럼 크게 바뀌어도 약 2초: ${typeof ms2 === 'number' ? Math.round(ms2) + 'ms' : ms2}`);
    s.eq(await textOf(page, 'green'), '999,999', '큰 점수도 정확히 멈춤(쉼표 표기)');
    s.eq(calls('score_add').length, page.nrpc('score_add') - preSends, '브라우저가 보낸 score_add 와 서버가 받은 score_add 수가 같음(자동 재시도·중복 없음)');

    // (e) 세어 올라가기/내려가기: 네 팀을 연달아 줘서 한꺼번에 돌리고, 팀별 표본(보이는 값·칸 DOM)을 모아 확인
    const countBatch = async (start, gives) => {
      await setScores(start); await page.reload(); await waitBoard(page);
      await overflowProbe(page);
      await watchStart(page, TEAMS);
      for (const [t, d] of gives) await give(page, t, d);
      await idle(page); await sleep(150);
      return { rows: await watchStop(page), ov: await page.evaluate(() => window.__ov) };
    };
    // 0 → +100 · 1,200 → +100(천의 자리는 그대로) · 20 → +10(걸음이 다 보임) · 130 → −50(내려감)
    const A = await countBatch({ red: 0, blue: 1200, yellow: 20, green: 130 }, [['red', 100], ['blue', 100], ['yellow', 10], ['green', -50]]);
    checkCount(s, A.rows.red, { lab: '0→+100', from: 0, to: 100 });
    checkCount(s, A.rows.blue, { lab: '1,200→+100', from: 1200, to: 1300 });
    checkCount(s, A.rows.yellow, { lab: '20→+10', from: 20, to: 30 });
    checkCount(s, A.rows.green, { lab: '130→−50', from: 130, to: 80 });
    // 바뀌지 않는 자리는 가만히: 1,200 → 1,300 도중 천의 자리(와 그 앞 쉼표 자리)는 내용·위치가 그대로, 굴러가는 칸도 아님
    const bl = A.rows.blue.filter((r) => r.anim);
    const th = bl.map((r) => r.wheels.find((w) => w.r === 3));
    s.ok(th.every((w) => w && !w.hid && !w.roll && w.d === '1' && w.cells === '1' && !w.tf && w.x === th[0].x), `[1,200→+100] 천의 자리는 연출 내내 '1'로 가만히(굴러가지 않고 위치도 그대로, x=${th[0] && th[0].x})`);
    s.ok(bl.every((r) => r.wheels.length === 4 && r.wheels.every((w) => !w.hid)), '[1,200→+100] 자릿수가 그대로라 칸은 네 개 그대로');
    s.eq([...new Set(A.rows.blue.filter((r) => r.t >= bl[0].t).map((r) => r.wheels.find((w) => w.r === 2).d))], ['2', '3'], '[1,200→+100] 백의 자리만 2 → 3 으로 한 번 넘어감(끝난 뒤 표본까지 봄 — 3 은 마지막 순간에야 칸에 자리 잡음)');
    s.ok(bl.some((r) => r.wheels.find((w) => w.r === 0).roll) && bl.some((r) => r.wheels.find((w) => w.r === 1).roll), '[1,200→+100] 일·십의 자리는 굴러감');
    // 20 → 30: 십의 자리는 29 → 30 으로 넘어가는 마지막 순간에만 움직임
    const yl = A.rows.yellow.filter((r) => r.anim);
    s.ok(yl.filter((r) => r.disp <= 28).every((r) => { const w = r.wheels.find((x) => x.r === 1); return !w.roll && w.d === '2'; }), '[20→+10] 28 이하일 때 십의 자리는 2 로 가만히(아랫자리가 넘어갈 때만 한 칸 굴러감)');
    s.eq([...new Set(yl.map((r) => r.disp))], Array.from({ length: 11 }, (_, i) => 20 + i), '[20→+10] 보이는 값이 20, 21, … 30 순서로 하나씩');
    s.eq(A.ov.ms, 0, `[세기] 센 팀들이 점수 칸 밖으로 한 번도 안 나감(칸 밖으로 나간 시간 ${Math.round(A.ov.ms)}ms ${JSON.stringify(A.ov.info || null)})`);
    await consistent(page, s, '세어 올라가기(0→100 · 1,200→1,300 · 20→30 · 130→80)', { red: 100, blue: 1300, yellow: 30, green: 80 });
    s.eq(await textOf(page, 'blue'), '1,300', '[1,200→+100] 쉼표 표기 그대로 멈춤');

    // 자릿수가 바뀔 때: 99 → 100 · 1,000 → 999 · 5 → −45(0을 지나 마이너스) · 0 → +999,999(큰 차이도 같은 길이, 마지막 걸음 보임)
    const B = await countBatch({ red: 99, blue: 1000, yellow: 5, green: 0 }, [['red', 1], ['blue', -1], ['yellow', -50], ['green', 999999]]);
    checkCount(s, B.rows.red, { lab: '99→100', from: 99, to: 100 });
    checkCount(s, B.rows.blue, { lab: '1,000→999', from: 1000, to: 999 });
    checkCount(s, B.rows.yellow, { lab: '5→−45', from: 5, to: -45 });
    checkCount(s, B.rows.green, { lab: '0→+999,999', from: 0, to: 999999 });
    const vis = (r) => r.wheels.filter((w) => !w.hid).length;
    const rd = B.rows.red.filter((r) => r.anim), bd = B.rows.blue.filter((r) => r.anim), yd = B.rows.yellow.filter((r) => r.anim), gd = B.rows.green.filter((r) => r.anim);
    const wid = (r, k) => r.wheels.find((w) => w.r === k).w; // 그 자리 칸의 너비(px)
    s.ok(wid(rd[0], 2) < wid(rd[0], 0) * 0.2 && wid(rd.at(-1), 2) > wid(rd.at(-1), 0) * 0.9, `[99→100] 새 맨 윗자리(백)가 빈칸에서 서서히 자라 1 로 나타남(너비 ${wid(rd[0], 2)}px → ${wid(rd.at(-1), 2)}px, 일의 자리 ${wid(rd[0], 0)}px)`);
    s.ok(wid(bd[0], 3) > wid(bd[0], 0) * 0.8 && wid(bd.at(-1), 3) < wid(bd.at(-1), 0) * 0.2 || vis(bd.at(-1)) === 3, `[1,000→999] 맨 윗자리(천)와 쉼표가 서서히 줄어 사라짐(너비 ${wid(bd[0], 3)}px → ${vis(bd.at(-1)) === 3 ? '없음' : wid(bd.at(-1), 3) + 'px'})`);
    s.eq(await textOf(page, 'red'), '100', '[99→100] 끝은 100');
    s.eq(await textOf(page, 'blue'), '999', '[1,000→999] 끝은 999(쉼표 없음)');
    s.ok(yd.some((r) => r.disp >= 1) && yd.some((r) => r.disp <= -1) && yd.every((r) => r.disp >= -45 && r.disp <= 5), '[5→−45] 0 을 지나 마이너스 쪽으로 −45 까지 내려감');
    s.ok(yd[0].sg === '0' && yd.at(-1).sg === '1' && yd.filter((r) => r.disp >= 1).every((r) => r.sg === '0'), '[5→−45] 마이너스 표시는 0 아래로 내려간 뒤에 나타남');
    s.eq(await textOf(page, 'yellow'), '−45', '[5→−45] 끝은 −45');
    s.eq(await textOf(page, 'green'), '999,999', '[0→+999,999] 끝은 999,999');
    s.ok(gd.filter((r) => r.disp >= 1000).length > 5 && gd.some((r) => r.disp === 999992) && gd.some((r) => r.disp === 999999), '[0→+999,999] 큰 차이도 마지막 걸음(999,992 … 999,999)이 보임');
    s.eq(B.ov.ms, 0, `[자릿수 변화] 자릿수가 늘고 주는 동안 점수가 칸 밖으로 한 번도 안 나감(${Math.round(B.ov.ms)}ms · 최대 ${((B.ov.max - 1) * 100).toFixed(1)}% ${JSON.stringify(B.ov.info || null)})`);
    await consistent(page, s, '자릿수가 바뀌는 연출', { red: 100, blue: 999, yellow: -45, green: 999999 });

    // 연달아 주기: 세는 도중 새 점수가 오면 지금 보이는 값에서 새 목표로 이어서 세고(0 으로 되돌아가지 않음), 마지막은 서버 값에 정확히 멈춤
    await setScores({}); await page.reload(); await waitBoard(page);
    await watchStart(page, ['red']);
    await give(page, 'red', 100);
    await wait(page, () => window.__score.display.red >= 30 && window.__score.display.red <= 70);
    await give(page, 'red', 50); // 세는 도중 +50 → 목표 150
    s.eq([(await sc(page)).shown.red, (await sc(page)).animating], [150, true], '[이어서] 세는 도중 새 점수: 목표는 바로 150 · 계속 세는 중');
    await wait(page, () => window.__score.display.red >= 110 && window.__score.display.red <= 140);
    await give(page, 'red', -100); // 이번엔 오르는 도중 방향이 바뀜 → 목표 50
    await idle(page); await sleep(150);
    const cr = (await watchStop(page)).red;
    const sw = cr.findIndex((r) => r.shown === 50); // 방향이 바뀐 새 목표가 반영된 첫 표본
    s.ok(cr.slice(cr.findIndex((r) => r.anim), cr.findLastIndex((r) => r.anim) + 1).every((r) => r.anim), '[이어서] +100 · +50 · −100 이 한 번도 끊기거나 멈추지 않고 이어서 셈(연출이 계속 도는 중)');
    const first150 = cr.findIndex((r) => r.shown === 150);
    const upTo = cr.slice(cr.findIndex((r) => r.anim), sw).map((r) => r.disp);
    s.ok(upTo.every((v, i) => i === 0 || v >= upTo[i - 1]) && cr[first150].disp >= 20, `[이어서] +50 이 들어와도 0 으로 되돌아가거나 멈추지 않고 이어서 오름(새 목표 반영 때 ${cr[first150].disp})`);
    s.ok(Math.abs(cr[sw].disp - cr[sw - 1].disp) <= 12, `[이어서] 방향이 바뀌어도 지금 보이는 값에서 바로 이어짐(${cr[sw - 1].disp} → ${cr[sw].disp})`);
    const down = cr.slice(sw).filter((r) => r.anim).map((r) => r.disp);
    s.ok(down.every((v, i) => i === 0 || v <= down[i - 1]) && down.at(-1) === 50, `[이어서] 방향이 바뀐 뒤에는 50 까지 한 방향(내림)으로만 감(${down[0]} → ${down.at(-1)})`);
    await consistent(page, s, '세는 도중 연달아 줌(+100,+50,−100)', { ...ZERO, red: 50 });
    s.eq(await textOf(page, 'red'), '50', '[이어서] 마지막 값 50 에 정확히 멈춤');
  });

  await scenario(4, '새로 고침 뒤 점수 유지(연출 중·저장 중 새로 고침 포함)', async (s) => {
    await clean(); resetCalls();
    const { page } = await newCtx();
    await login(page);
    await give(page, 'red', 50);
    await wait(page, () => window.__score.spinning.red === 'up');
    await page.reload(); // 연출이 도는 중에 새로 고침
    s.eq(await enterGate(page), false, '새로 고침해도 다시 안 물음');
    await waitBoard(page);
    await consistent(page, s, '연출 중 새로 고침', { ...ZERO, red: 50 });
    s.eq((await sc(page)).last, null, '새로 고치면 "방금 준 것" 기억은 없어짐(되돌리기 단추 꺼짐)');
    s.ok(await page.locator('#undoBtn').isDisabled(), '새로 고침 뒤 되돌리기 단추는 꺼짐');
    // 처음 받은 점수는 돌지 않고 바로 보임
    s.eq((await sc(page)).spinning, { red: null, blue: null, yellow: null, green: null }, '새로 고친 뒤 처음 받은 점수는 연출 없이 바로 보임');
    // 저장 중 새로 고침: 요청은 이미 나갔으므로 서버에는 들어가고, 새로 고친 화면은 서버 값과 같음
    await slowReply(page, 1500);
    await give(page, 'blue', 100, { wait: false });
    await wait(page, () => window.__score.busy && window.__score.phase === 'saving');
    s.eq((await sc(page)).phase, 'saving', '저장 중(phase=saving)에 새로 고침');
    await page.reload();
    await enterGate(page); await waitBoard(page);
    await consistent(page, s, '저장 중 새로 고침 뒤 화면=DB(서버에는 한 번만 들어감)', { ...ZERO, red: 50, blue: 100 });
    s.eq(calls('score_add').filter((c) => c.args.p_team === 'blue').length, 1, '저장 중 새로 고침해도 파랑 score_add 는 한 번(새로 고친 화면이 다시 보내지 않음)');
    // 다른 값으로 새로 고침 여러 번
    await setScores({ red: -123456, blue: 7, yellow: 1000000, green: 42 });
    await page.reload(); await enterGate(page); await waitBoard(page);
    await consistent(page, s, '새로 고침(여러 점수)', { red: -123456, blue: 7, yellow: 1000000, green: 42 });
    s.eq([await textOf(page, 'red'), await textOf(page, 'yellow')], ['−123,456', '1,000,000'], '마이너스·쉼표 표기');
    // 새 브라우저(저장소 없음)에서도 같은 점수
    const b = await newCtx();
    await login(b.page);
    await consistent(b.page, s, '다른 브라우저에서 열어도 같은 점수', { red: -123456, blue: 7, yellow: 1000000, green: 42 });
  });

  await scenario(5, '두 브라우저: 다른 쪽 점수가 5초 안에 반영(소리 없음), 동시에 줘도 합산, 연출 도중 폴링이 안 덮음', async (s) => {
    await clean(); await resetRoster(db, { picked: true }); resetCalls();
    const A = await newCtx(); const B = await newCtx(REDUCED);
    // 프레임 루프 감시: 아직 안 불린 requestAnimationFrame 예약이 연출 중에 늘 1개 이하인지(연출 끝에서 다시 맞추는 새 연출이 루프를 하나 더 만들지 않음)
    await A.page.addInitScript(() => {
      const raw = window.requestAnimationFrame.bind(window);
      const w = (window.__raf = { pending: 0, max: 0, spins: 0, was: false });
      window.requestAnimationFrame = (cb) => { w.pending++; return raw((t) => { w.pending--; cb(t); }); };
      setInterval(() => { const a = !!(window.__score && window.__score.animating); if (a && !w.was) w.spins++; w.was = a; if (a) w.max = Math.max(w.max, w.pending); }, 15);
    });
    await login(A.page); await login(B.page);
    s.eq(await A.page.evaluate(() => document.hidden), false, '준비: 시험 창이 숨김 상태가 아님(숨김이면 새로 받기를 쉼)');
    // B 가 주면 A 가 따라옴
    await give(B.page, 'red', 100);
    const t0 = Date.now();
    await wait(A.page, () => window.__score.shown.red === 100, null, 12000);
    s.ok(Date.now() - t0 <= 7000, `[반영] B 가 준 점수가 A 화면에 ${((Date.now() - t0) / 1000).toFixed(1)}초 만에 반영(5초 새로 받기)`);
    await idle(A.page);
    await consistent(A.page, s, 'A 가 B 의 점수를 반영', { ...ZERO, red: 100 });
    s.eq(await A.page.evaluate(() => window.__scoreAudio.log.length), 0, '[소리] 다른 곳에서 바뀐 점수는 A 에서 소리 요청 0건');
    s.eq(await B.page.evaluate(() => window.__scoreAudio.log.map((x) => x.dir)), ['up'], '[소리] 직접 준 B 에서만 소리 요청 1건');
    s.ok((await sc(A.page)).pollFails === 0, '새로 받기 실패 없음');
    // 동시에 줌: 서로 모르는 사이에 +10 씩 → 합산
    await Promise.all([give(A.page, 'red', 10), give(B.page, 'red', 10)]);
    s.eq((await dbScores()).red, 120, '[동시] 서로 모르는 사이에 +10 씩 줘도 120(덮어쓰지 않고 합산)');
    await wait(A.page, () => window.__score.shown.red === 120, null, 12000); await wait(B.page, () => window.__score.shown.red === 120, null, 12000);
    await idle(A.page); await idle(B.page);
    await consistent(A.page, s, 'A 최종', { ...ZERO, red: 120 }); await consistent(B.page, s, 'B 최종', { ...ZERO, red: 120 });
    // 연출 도중 폴링이 덮지 않음: A 가 파랑 +50(2초 연출) → 도는 중에 다른 곳에서 파랑 +7 → R 키로 바로 새로 받기
    await give(A.page, 'blue', 50);
    await wait(A.page, () => window.__score.spinning.blue === 'up');
    await addDirect('blue', 7);
    const n0 = (await sc(A.page)).calls.score_state;
    await A.page.keyboard.press('KeyR');
    await wait(A.page, (n) => window.__score.calls.score_state > n && window.__score.spinning.blue, n0, 3000).then(() => s.ok(true, '[연출 중 폴링] 연출이 도는 중에 점수를 새로 받아도 연출은 그대로 도는 중'), () => s.ok(false, '[연출 중 폴링] 새로 받는 사이 연출이 끊김'));
    const mid = await sc(A.page);
    s.eq([mid.shown.blue, mid.server.blue], [50, 57], '[연출 중 폴링] 도는 팀의 화면 목표(50)는 안 바뀌고 서버 값(57)만 기억');
    await wait(A.page, () => window.__score.shown.blue === 57 && !window.__score.animating, null, 8000);
    await idle(A.page);
    await consistent(A.page, s, '연출이 끝난 뒤 서버 값에 맞춤', { ...ZERO, red: 120, blue: 57 });
    const rf = await A.page.evaluate(() => ({ ...window.__raf }));
    s.ok(rf.spins >= 3 && rf.max === 1, `[프레임 루프] 연출이 도는 내내(연출 ${rf.spins}번, 끝에서 다시 맞추는 연출 포함) 예약된 프레임 요청은 최대 1개(실제 ${rf.max}개)`);
    // 내가 준 것(파랑 +50)이 아닌 변화(+7)로 파랑이 맞춰졌으니 '방금 준 것 되돌리기'는 비워짐
    const lastB = await sc(A.page);
    s.eq([lastB.last, await A.page.locator('#undoBtn').isDisabled(), (await A.page.locator('#undoWhat').innerText()).trim()], [null, true, ''], '[되돌리기] 연출이 끝나며 다른 곳의 변화(+7)로 맞춰진 팀(파랑)의 되돌리기 기록은 비워짐(단추 꺼짐·글자 없음)');
    s.eq(await A.page.evaluate(() => window.__scoreAudio.log.map((x) => x.dir)), ['up', 'up'], '[소리] A 의 소리 요청은 직접 준 2번(빨강·파랑)뿐 — 다른 곳 점수(+7)로 맞춘 것은 소리 없음');
  });

  await scenario(6, '저장 실패: 서버 거절(점수 그대로·오류 표시·다시 가능), 응답 끊김(서버 미반영), 서버엔 반영됐는데 응답만 끊김(자동 재시도 없음)', async (s) => {
    await clean(); resetCalls();
    const { page } = await newCtx(REDUCED);
    await login(page);
    await give(page, 'red', 30); await idle(page);
    // (a) 서버가 거절(400): 점수 그대로, 오류 표시, 다시 할 수 있음
    await rejectAdd(page, '시험용 저장 실패');
    await give(page, 'red', 10);
    const a = await sc(page);
    s.eq([a.shown.red, a.busy, a.errorKind, a.phase], [30, false, 'error', 'idle'], '[거절] 점수 그대로(30) · 요청 끝남 · 오류 표시(error) · 다시 할 수 있는 상태');
    s.ok(/저장하지 못했어요: 시험용 저장 실패/.test(a.error) && /점수는 그대로예요/.test(a.error), `[거절] 오류 안내: ${a.error}`);
    s.eq(await page.evaluate(() => [!document.getElementById('alert').hidden, document.getElementById('alert').dataset.kind, document.getElementById('controls').classList.contains('has-alert')]), [true, 'error', true], '[거절] 오류 상자가 조작부 위에 빨강으로 뜸');
    s.eq((await dbScores()).red, 30, '[거절] DB 그대로');
    s.eq(await page.evaluate(() => [...document.querySelectorAll('.quick, #addBtn, #subBtn')].every((b) => !b.disabled)), true, '[거절] 점수 단추가 다시 눌림');
    s.eq(page.nrpc('score_add'), 2, '[거절] 서버 요청은 한 번씩(자동 재시도 없음)');
    await page.locator('#alertClose').click();
    s.eq(await page.evaluate(() => document.getElementById('alert').hidden), true, '[거절] 닫기 단추로 오류 상자를 닫음');
    await page.unroute(/\/rpc\/score_add$/);
    await give(page, 'red', 10); await idle(page);
    await consistent(page, s, '거절 뒤 다시 줌', { ...ZERO, red: 40 });
    s.eq(await page.evaluate(() => document.getElementById('alert').hidden), true, '[거절] 다시 성공하면 오류 상자 없음');
    // 서버가 진짜 거절하는 경우: 총합 한도
    await setScores({ red: 999999995 });
    await page.reload(); await enterGate(page); await waitBoard(page);
    await give(page, 'red', 10);
    const lim = await sc(page);
    s.ok(lim.errorKind === 'error' && /너무 커져요/.test(lim.error) && lim.shown.red === 999999995, `[한도] 서버가 한도를 넘겨 거절 → 점수 그대로·오류 표시: ${lim.error}`);
    s.eq((await dbScores()).red, 999999995, '[한도] DB 그대로');
    await clean(); await page.reload(); await enterGate(page); await waitBoard(page);
    // (b) 응답 끊김(요청이 서버에 닿지 않음): 자동 재시도 없이 한 번, 서버 점수 다시 읽어 "저장 안 됐어요"
    await dropAdd(page);
    const sendsBefore = page.nrpc('score_add');
    const base1 = calls('score_add').length;
    await give(page, 'blue', 25, { wait: false });
    await wait(page, () => window.__score.verifying || window.__score.errorKind, null, 8000);
    const v = await sc(page);
    s.ok(v.verifying && v.verifying.team === 'blue' && v.errorKind === 'warn' && /저장 응답을 받지 못했어요/.test(v.error) && /같은 요청을 다시 보내지 않았어요/.test(v.error), `[끊김] 저장됐는지 모르는 상태 안내(노랑): ${v.error}`);
    s.eq(v.locked, true, '[끊김] 확인하는 동안 점수 단추는 잠김(같은 점수를 또 주지 않게)');
    await wait(page, () => !window.__score.verifying && window.__score.errorKind === 'warn' && /아직 반영되지 않았어요/.test(window.__score.error || ''), null, 10000);
    const v2 = await sc(page);
    s.ok(/아직 반영되지 않았어요\(점수 0점 그대로\)/.test(v2.error) && /늦게 반영될 수도 있으니 점수가 맞는지 확인해 주세요/.test(v2.error) && /같은 팀에 같은 점수를 2분 안에 다시 누르면\(그 사이 다른 점수를 줘도\) 두 번 들어가지 않아요/.test(v2.error) && !/저장되지 않았어요/.test(v2.error), `[끊김·서버에 안 닿음] 서버 점수를 읽어 단정하지 않고 "아직 반영되지 않았어요, 늦게 반영될 수도 있어요": ${v2.error}`);
    s.eq([v2.shown.blue, (await dbScores()).blue, page.nrpc('score_add') - sendsBefore, calls('score_add').length - base1], [0, 0, 1, 0], '[끊김·서버에 안 닿음] 점수 그대로 · score_add 는 브라우저가 한 번만 보냄(재시도 없음)');
    await sleep(1500);
    s.eq(page.nrpc('score_add') - sendsBefore, 1, '[끊김] 기다려도 score_add 를 다시 보내지 않음');
    s.eq(await page.evaluate(() => [...document.querySelectorAll('.quick, #addBtn, #subBtn')].every((b) => !b.disabled)), true, '[끊김] 확인이 끝나면 다시 줄 수 있음');
    await page.unroute(/\/rpc\/score_add$/);
    await give(page, 'blue', 25); await idle(page);
    await consistent(page, s, '끊김 뒤 다시 줌', { ...ZERO, blue: 25 });
    // (c) 서버엔 반영됐는데 응답만 끊김: 자동 재시도 없음, 확인 뒤 화면=DB(두 번 안 들어감)
    await lostReply(page);
    const sends2 = page.nrpc('score_add');
    const base2 = calls('score_add').length;
    await give(page, 'yellow', 40, { wait: false });
    await wait(page, () => window.__score.verifying, null, 8000);
    await wait(page, () => !window.__score.verifying && window.__score.errorKind, null, 10000);
    const v3 = await sc(page);
    s.ok(v3.errorKind === 'warn' && /노랑 팀 \+40은 저장돼 있었어요/.test(v3.error) && /다시 누르지 않아도 돼요/.test(v3.error), `[끊김·서버엔 반영] "저장돼 있었어요, 다시 누르지 않아도 돼요": ${v3.error}`);
    s.eq([(await dbScores()).yellow, page.nrpc('score_add') - sends2, calls('score_add').length - base2], [40, 1, 1], '[끊김·서버엔 반영] DB 는 +40 한 번만 · 브라우저는 score_add 한 번 보냄 · 서버가 받은 것도 한 번');
    await idle(page);
    await consistent(page, s, '끊김·서버엔 반영 뒤 화면=DB', { ...ZERO, blue: 25, yellow: 40 });
    s.ok(!(await page.locator('#undoBtn').isDisabled()), '[끊김·서버엔 반영] 들어간 것이 확인돼 되돌리기 단추가 켜짐');
    s.eq((await sc(page)).last, { team: 'yellow', delta: 40 }, '[끊김·서버엔 반영] 방금 준 것 기억');
    await page.unroute(/\/rpc\/score_add$/);
    await page.locator('#undoBtn').click(); await notBusy(page); await idle(page);
    s.eq((await dbScores()).yellow, 0, '[끊김·서버엔 반영] 되돌리기가 −40 으로 한 번만 들어감');
    // 점수 불러오기 실패: 처음 점수를 못 받으면 단추 잠김 + 안내, 다시 받기로 해결
    const f = await newCtx();
    let fail = 3;
    await f.page.route(/\/rpc\/score_state$/, (r) => { if (fail > 0) { fail--; return r.abort('failed'); } return r.fallback(); });
    await f.page.goto(`${server.url}/score.html`); await enterGate(f.page);
    await wait(f.page, () => window.__score.view === 'board' && window.__score.errorKind === 'error', null, 10000);
    const lf = await sc(f.page);
    s.ok(lf.ready === false && lf.locked === true && /점수를 불러오지 못했어요/.test(lf.error) && lf.shown.red === null, `[불러오기 실패] 점수를 못 받으면 단추 잠김·안내: ${lf.error}`);
    s.eq(await f.page.locator('#score-red').evaluate((e) => [e.textContent.trim(), e.getAttribute('aria-label')]), ['–', '빨강 팀 점수를 아직 못 받았어요'], '[불러오기 실패] 점수 자리에 가짜 0 이 아니라 "–"');
    await f.page.locator('#refreshBtn').click();
    await wait(f.page, () => window.__score.ready, null, 15000);
    s.eq((await sc(f.page)).errorKind, null, '[불러오기 실패] 다시 받으면 오류 상자가 사라지고 열림');
  });

  const waitDb = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn(await dbScores())) return true; await sleep(100); } return false; };
  const scoreAddCalls = () => calls('score_add');

  await scenario(6.1, '응답이 끊긴 요청이 늦게 서버에 도착: 안내 뒤 같은 점수를 다시 눌러도 한 번만(같은 요청 번호 — 그 사이 다른 점수를 줘도 번호가 남음), 다른 (팀, 점수)면 새 번호, 서버가 거절하면 번호 버림', async (s) => {
    await clean(); resetCalls();
    const { page } = await newCtx(REDUCED);
    await login(page);
    const notYet = (p) => wait(p, () => !window.__score.verifying && /아직 반영되지 않았어요/.test(window.__score.error || ''), null, 12000);
    // A. 늦은 요청이 다시 누르기 전에 서버에 도착: 같은 번호로 다시 보내도 더해지지 않음
    {
      const late = [];
      await lateArrival(page, 4000, late);
      await give(page, 'red', 50, { wait: false });
      await wait(page, () => window.__score.verifying, null, 8000);
      await notYet(page);
      const st = await sc(page);
      s.ok(st.errorKind === 'warn' && /늦게 반영될 수도 있으니 점수가 맞는지 확인해 주세요/.test(st.error) && /같은 팀에 같은 점수를 2분 안에 다시 누르면\(그 사이 다른 점수를 줘도\) 두 번 들어가지 않아요/.test(st.error) && /점수 0점 그대로/.test(st.error), `[A] 단정하지 않는 안내: ${st.error}`);
      s.eq((await dbScores()).red, 0, '[A] 안내가 뜰 때 서버 점수는 0(요청이 아직 서버에 안 닿음)');
      s.ok(await waitDb((d) => d.red === 50), '[A] 늦은 요청이 4초쯤 뒤 서버에 도착해 +50 이 반영됨');
      await page.unroute(/\/rpc\/score_add$/);
      await give(page, 'red', 50); // 안내대로 같은 점수를 다시 누름(점수판은 아직 0 이라고 믿고 있거나 막 따라온 상태)
      await idle(page);
      s.eq((await dbScores()).red, 50, '[A] 같은 점수를 다시 눌러도 DB 는 +50 한 번(100 이 아님)');
      const cs = scoreAddCalls();
      s.eq([cs.length, cs[0].args.p_req === late[0].p_req, cs[1].args.p_req === late[0].p_req, cs.map((c) => c.status)], [2, true, true, [200, 200]], '[A] 서버가 받은 두 요청의 요청 번호가 같음');
      const a = await sc(page);
      s.eq([a.shown.red, a.error, a.verifying, a.busy], [50, null, null, false], '[A] 점수판은 서버 점수 50 · 오류 상자 없음');
    }
    // B. 다시 누른 요청이 먼저 서버에 도착하고 늦은 요청이 나중에 도착: 나중 것이 더해지지 않음
    {
      await clean(); resetCalls(); await page.reload(); await enterGate(page); await waitBoard(page);
      const late = [];
      await lateArrival(page, 5000, late);
      await give(page, 'blue', 30, { wait: false });
      await wait(page, () => window.__score.verifying, null, 8000);
      await notYet(page);
      await page.unroute(/\/rpc\/score_add$/);
      await give(page, 'blue', 30);
      s.eq((await dbScores()).blue, 30, '[B] 다시 누른 요청이 먼저 반영돼 +30');
      s.ok(await waitDb(() => scoreAddCalls().length >= 2, 12000) || scoreAddCalls().length >= 2, '[B] 늦은 요청이 뒤늦게 서버에 도착');
      await sleep(300);
      const cs = scoreAddCalls();
      s.eq([cs.length, cs.every((c) => c.args.p_req === late[0].p_req), (await dbScores()).blue], [2, true, 30], '[B] 늦은 요청이 나중에 도착해도 더해지지 않음(DB 30 그대로) · 두 요청 번호 같음');
      await consistent(page, s, '[B] 끝', { ...ZERO, blue: 30 });
    }
    // C. 다른 점수를 누르면 새 번호(옛 요청은 나중에 도착해 반영될 수 있음 — 안내에 적힌 대로)
    {
      await clean(); resetCalls(); await page.reload(); await enterGate(page); await waitBoard(page);
      const late = [];
      await lateArrival(page, 6000, late);
      await give(page, 'yellow', 20, { wait: false });
      await wait(page, () => window.__score.verifying, null, 8000);
      await notYet(page);
      await page.unroute(/\/rpc\/score_add$/);
      await give(page, 'yellow', 10); // 다른 점수 → 새 번호
      const c1 = scoreAddCalls()[0];
      s.ok(c1.args.p_delta === 10 && c1.args.p_req !== late[0].p_req, `[C] 다른 점수(+10)를 누르면 새 요청 번호: ${c1.args.p_req} ≠ ${late[0].p_req}`);
      s.ok(await waitDb((d) => d.yellow === 30, 15000), '[C] (알려 둔 위험) 옛 +20 이 늦게 도착해 합계 30 — 안내가 "늦게 반영될 수도 있어요"라고 한 이유');
      await wait(page, () => window.__score.shown.yellow === 30, null, 15000);
      s.eq((await sc(page)).shown.yellow, 30, '[C] 점수판은 늦게 반영된 값(30)을 따라감');
    }
    // D. 다른 팀을 누르면 그 팀은 새 번호. 처음 팀으로 돌아와 같은 점수를 누르면 (번호가 남아 있어) 옛 번호
    {
      await clean(); resetCalls(); await page.reload(); await enterGate(page); await waitBoard(page);
      const late = [];
      await lateArrival(page, 6500, late);
      await give(page, 'green', 15, { wait: false });
      await wait(page, () => window.__score.verifying, null, 8000);
      await notYet(page);
      await page.unroute(/\/rpc\/score_add$/);
      await give(page, 'red', 15);
      await give(page, 'green', 15);
      const cs = scoreAddCalls();
      s.ok(cs.length >= 2 && cs[0].args.p_team === 'red' && cs[0].args.p_req !== late[0].p_req, `[D] 다른 팀(빨강 +15)은 새 번호: ${cs.map((c) => c.args.p_team + c.args.p_req.slice(0, 4)).join(', ')} / 옛 ${late[0].p_req.slice(0, 4)}`);
      s.ok(cs.length >= 2 && cs[1].args.p_team === 'green' && cs[1].args.p_req === late[0].p_req, '[D] 그 사이 다른 팀을 눌렀어도 처음 팀(초록 +15)을 다시 누르면 같은 번호');
      await waitDb(() => scoreAddCalls().length >= 3, 12000); await sleep(300);
      s.eq([await dbScores().then((d) => [d.red, d.green]), new Set(scoreAddCalls().map((c) => c.args.p_req)).size], [[15, 15], 2], '[D] 늦은 요청이 도착해도 초록은 +15 한 번만(DB 빨강 15·초록 15) · 번호는 두 개뿐');
      await page.reload(); await enterGate(page); await waitBoard(page); // 늦은 요청까지 끝난 뒤 정리
    }
    // F. 응답 못 받은 요청(+50, −10 둘 다)이 늦게 도착하는 사이 다른 점수를 줘도 번호가 남음: 다시 누른 요청이 먼저 서버에 도착하는 순서
    {
      await clean(); resetCalls(); await page.reload(); await enterGate(page); await waitBoard(page);
      const late = [];
      await lateArrival(page, 8000, late);
      await give(page, 'red', 50, { wait: false });
      await wait(page, () => window.__score.verifying, null, 8000);
      await notYet(page);
      await give(page, 'red', -10, { wait: false }); // 다른 점수도 끊김 → 두 번호를 함께 기억
      await wait(page, () => window.__score.verifying, null, 8000);
      await notYet(page);
      s.eq([(await sc(page)).pend, late.length, new Set(late.map((x) => x.p_req)).size], [2, 2, 2], '[F] 응답을 못 받은 (빨강 +50)·(빨강 −10) 두 요청의 번호를 따로 기억(pend 2)');
      await page.unroute(/\/rpc\/score_add$/);
      await give(page, 'red', 50); // 사이에 −10 을 줬어도 +50 은 옛 번호
      await give(page, 'red', -10);
      const cs = scoreAddCalls();
      s.ok(cs.length === 2 && cs[0].args.p_delta === 50 && cs[0].args.p_req === late[0].p_req && cs[1].args.p_delta === -10 && cs[1].args.p_req === late[1].p_req, `[F] 사이에 다른 점수를 줘도 +50 은 +50 의 옛 번호, −10 은 −10 의 옛 번호로 나감: ${cs.map((c) => c.args.p_delta + ':' + c.args.p_req.slice(0, 4)).join(', ')}`);
      s.eq([(await dbScores()).red, (await sc(page)).pend], [40, 0], '[F] 다시 보낸 요청이 성공하면 그 번호만 지워짐(pend 0) · DB 40(+50 −10)');
      s.ok(await waitDb(() => scoreAddCalls().length >= 4, 20000) || scoreAddCalls().length >= 4, '[F] 끊겼던 두 요청이 8초쯤 뒤 서버에 도착');
      await sleep(300);
      s.eq([(await dbScores()).red, scoreAddCalls().slice(0, 4).map((c) => c.status), new Set(scoreAddCalls().map((c) => c.args.p_req)).size], [40, [200, 200, 200, 200], 2], '[F] 늦게 도착한 두 요청은 더해지지 않음(DB 40 그대로) · 번호는 두 개뿐');
      await give(page, 'red', 50); await idle(page); // 번호가 지워진 뒤 새로 누른 +50 은 새 번호로 정상 반영
      const last = scoreAddCalls().at(-1);
      s.ok(last.args.p_delta === 50 && last.args.p_req !== late[0].p_req, '[F] 번호가 지워진 뒤 새로 누른 +50 은 새 번호');
      s.eq((await dbScores()).red, 90, '[F] 새 +50 은 정상 반영(90)');
    }
    // G. 같은 일이지만 늦은 요청이 먼저 서버에 도착하고 그 뒤 다시 누름
    {
      await clean(); resetCalls(); await page.reload(); await enterGate(page); await waitBoard(page);
      const late = [];
      await lateArrival(page, 3500, late);
      await give(page, 'red', 50, { wait: false });
      await wait(page, () => window.__score.verifying, null, 8000);
      await notYet(page);
      await page.unroute(/\/rpc\/score_add$/);
      s.ok(await waitDb((d) => d.red === 50, 8000), '[G] 늦은 +50 이 먼저 서버에 도착해 반영됨');
      await give(page, 'red', -10); // 다른 점수(새 번호) → 40
      await give(page, 'red', 50);  // 옛 번호 그대로 → 서버가 이미 처리한 요청이라 더하지 않음
      const cs = scoreAddCalls();
      s.ok(cs.length === 3 && cs[2].args.p_delta === 50 && cs[2].args.p_req === late[0].p_req && cs[1].args.p_req !== late[0].p_req, `[G] 사이에 −10 을 줬어도 +50 은 옛 번호: ${cs.map((c) => c.args.p_delta + ':' + c.args.p_req.slice(0, 4)).join(', ')}`);
      await idle(page);
      const g = await sc(page);
      s.eq([(await dbScores()).red, g.shown.red, g.pend], [40, 40, 0], '[G] DB 는 50 −10 = 40(+50 이 두 번 들어가지 않음) · 화면 40 · 다시 보낸 요청이 응답을 받아 번호 지워짐');
      s.ok(/이미 반영된 요청이라 다시 더하지 않았어요/.test(g.status), `[G] 안내: ${g.status}`);
      await give(page, 'red', 50); await idle(page);
      s.eq([(await dbScores()).red, scoreAddCalls().at(-1).args.p_req !== late[0].p_req], [90, true], '[G] 번호가 지워진 뒤 새 +50 은 새 번호로 정상 반영(90)');
    }
    // E. 서버가 이유를 적어 거절한 요청의 번호는 버림: 다시 누르면 새 번호
    {
      await clean(); resetCalls();
      const sent = [];
      await page.route(/\/rpc\/score_add$/, (r) => { sent.push(JSON.parse(r.request().postData())); return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '시험용 저장 실패', code: 'P0001', details: null, hint: null }) }); });
      await give(page, 'red', 10);
      await give(page, 'red', 10);
      s.ok(sent.length === 2 && sent[0].p_req !== sent[1].p_req, `[E] 서버가 거절(400)한 뒤 같은 점수를 다시 누르면 새 번호: ${sent.map((x) => x.p_req.slice(0, 6)).join(' ≠ ')}`);
      await page.unroute(/\/rpc\/score_add$/);
    }
  });

  await scenario(6.2, '요청을 22초 붙잡음(20초 시간 초과 뒤 도착): 안내 → 같은 점수를 다시 눌러도 한 번만', async (s) => {
    await clean(); resetCalls();
    const { page } = await newCtx(REDUCED);
    await login(page);
    let held = 0;
    await page.route(/\/rpc\/score_add$/, async (r) => { if (held++ === 0) await sleep(23000); await r.fallback().catch(() => {}); }); // 처음 요청만 23초 붙잡았다가 서버로 보냄(브라우저는 20초에 포기)
    await give(page, 'red', 50, { wait: false });
    await wait(page, () => window.__score.verifying, null, 30000);
    await wait(page, () => !window.__score.verifying && /아직 반영되지 않았어요/.test(window.__score.error || ''), null, 12000);
    s.eq([(await dbScores()).red, (await sc(page)).errorKind], [0, 'warn'], '[22초] 20초 시간 초과 뒤 "아직 반영되지 않았어요" 안내(서버 점수 0) — 아직 서버에 안 닿았을 때');
    await give(page, 'red', 50); // 안내대로 다시 누름(이 요청은 붙잡지 않음)
    await idle(page);
    s.eq((await dbScores()).red, 50, '[22초] 다시 누른 요청이 바로 반영돼 +50');
    s.ok(await waitDb(() => scoreAddCalls().length >= 2, 15000) || scoreAddCalls().length >= 2, '[22초] 붙잡혔던 첫 요청이 23초쯤 뒤 서버에 도착');
    await sleep(400);
    const cs = scoreAddCalls();
    s.eq([cs.length, new Set(cs.map((c) => c.args.p_req)).size, (await dbScores()).red], [2, 1, 50], '[22초] 늦게 도착한 첫 요청은 같은 번호라 더해지지 않음 → DB 50(100 아님)');
    await consistent(page, s, '[22초] 끝', { ...ZERO, red: 50 });
  });

  await scenario(6.3, 'DB 직접: score_add 요청 번호(p_req) — 같은 번호는 한 번만(동시 포함)·한도 실패한 번호는 다시 쓸 수 있음·잘못된 형식 오류·24시간 지난 줄 삭제·초기화로 안 지움·다시 적용해도 유지', async (s) => {
    await clean(); await db.query('delete from score_requests'); resetCalls();
    const r1 = await addReq('red', 10, 'req-aaaa-0001');
    const r2 = await addReq('red', 10, 'req-aaaa-0001');
    s.eq([r1.status, r1.body.red, r2.status, r2.body, (await dbScores()).red], [200, 10, 200, { ...ZERO, red: 10 }, 10], '같은 번호를 순서대로 두 번 보내면 한 번만 더하고, 두 번째 응답은 지금 점수 상태(점수 네 개)');
    s.eq((await addReq('red', 10, 'req-aaaa-0002')).body.red, 20, '다른 번호는 각각 더함');
    s.eq((await addDirect('red', 5)).body.red, 25, '번호 없이(p_req 생략) 불러도 예전처럼 더함');
    const par = await Promise.all(Array.from({ length: 12 }, () => addReq('blue', 7, 'req-bbbb-concurrent')));
    s.ok(par.every((r) => r.status === 200), '같은 번호를 동시에 12번 보내도 모두 오류 없이 답함');
    s.eq((await dbScores()).blue, 7, '같은 번호를 동시에 12번 보내도 한 번만 더함(7)');
    const mix = await Promise.all([...Array.from({ length: 6 }, () => addReq('green', 3, 'req-cccc-mixed-1')), ...Array.from({ length: 6 }, () => addReq('green', 3, 'req-cccc-mixed-2'))]);
    s.eq([mix.every((r) => r.status === 200), (await dbScores()).green], [true, 6], '번호 둘을 섞어 동시에 보내면 번호마다 한 번씩 → 6');
    // 한도 초과로 실패한 호출의 번호는 기록되지 않아 다시 보낼 수 있음
    await setScores({ yellow: 999999995 });
    const over = await addReq('yellow', 10, 'req-dddd-overflow');
    s.ok(over.status === 400 && /너무 커져요/.test(over.body.message), `한도를 넘는 호출은 거절: ${over.body.message}`);
    s.eq((await db.query("select count(*)::int n from score_requests where req = 'req-dddd-overflow'")).rows[0].n, 0, '실패한 호출의 요청 번호는 기록되지 않음(거래가 함께 취소됨)');
    await setScores({ yellow: 0 });
    const again = await addReq('yellow', 10, 'req-dddd-overflow');
    s.eq([again.status, again.body.yellow], [200, 10], '같은 번호로 다시 보내면 이번에는 더해짐');
    // 인자 검사 오류도 번호를 남기지 않음
    const badTeam = await addReq('purple', 5, 'req-eeee-badteam');
    s.eq([badTeam.status, (await db.query("select count(*)::int n from score_requests where req = 'req-eeee-badteam'")).rows[0].n], [400, 0], '팀 이름이 틀린 호출은 번호를 남기지 않음');
    // 잘못된 번호 형식
    for (const [name, req] of [['7자(너무 짧음)', 'abcdefg'], ['65자(너무 김)', 'a'.repeat(65)], ['공백 들어 있음', 'abcd efgh1234'], ['따옴표 들어 있음', "abcd'efgh1234"], ['한글', '요청번호요청번호요청번호'], ['점 들어 있음', 'abcd.efgh1234'], ['빈 글자', ''], ['줄바꿈', 'abcdefgh\n1234']]) {
      const b = await addReq('red', 1, req);
      s.ok(b.status === 400 && /요청 번호/.test(b.body.message), `형식 오류(${name}): ${b.body && b.body.message}`);
    }
    for (const [name, req] of [['정확히 8자', 'abcdefgh'], ['정확히 64자', 'A1_-'.repeat(16)], ['UUID', '3f2b8c1e-5d7a-4e0b-9a61-0c4d2e8f7a15']]) {
      const g = await addReq('red', 1, req);
      s.ok(g.status === 200, `허용 형식(${name}): ${g.status}`);
    }
    s.eq((await dbScores()).red, 3, '잘못된 형식은 점수를 바꾸지 않았고 허용된 세 개만 +1 씩(한도 시험에서 점수를 새로 맞췄으므로 0 + 3)');
    // 24시간 지난 줄은 다음 호출 때 지워짐
    await db.query("insert into score_requests (req, created_at) values ('req-old-25h-aaaa', now() - interval '25 hours'), ('req-old-23h-aaaa', now() - interval '23 hours')");
    await addReq('red', 1, 'req-ffff-cleanup');
    const left = (await reqRows()).map((r) => r.req);
    s.ok(!left.includes('req-old-25h-aaaa') && left.includes('req-old-23h-aaaa') && left.includes('req-ffff-cleanup'), `25시간 된 줄은 지워지고 23시간 된 줄은 남음: ${left.length}줄`);
    // 표 권한
    const c = await connect();
    try {
      await c.query('begin'); await c.query('set local role anon');
      let readErr = null; try { await c.query('select * from score_requests'); } catch (e) { readErr = e.code; }
      await c.query('rollback'); await c.query('begin'); await c.query('set local role anon');
      let writeErr = null; try { await c.query("insert into score_requests (req) values ('req-anon-direct')"); } catch (e) { writeErr = e.code; }
      await c.query('rollback');
      s.eq([readErr, writeErr], ['42501', '42501'], 'anon 은 score_requests 를 직접 읽지도 쓰지도 못함');
      s.eq((await c.query("select relrowsecurity from pg_class where relname = 'score_requests'")).rows[0].relrowsecurity, true, 'score_requests 는 행 수준 보안(RLS) 켜짐');
    } finally { await c.end(); }
    // 점수 초기화·전체 초기화로 번호를 지우지 않음: 초기화 뒤 늦게 온 같은 요청이 다시 더해지지 않음
    const before = (await reqRows()).length;
    await db.query("select public.admin_clear($1, 'score')", [ADMIN_CODE]);
    s.eq([(await reqRows()).length, await dbScores().then((d) => d.red)], [before, 0], "점수 초기화(admin_clear('score'))는 점수만 0으로 하고 요청 번호 기록은 그대로");
    const lateAfterReset = await addReq('red', 10, 'req-aaaa-0001');
    s.eq([lateAfterReset.status, lateAfterReset.body.red], [200, 0], '초기화 뒤 늦게 온 같은 번호의 요청은 더해지지 않음');
    await db.query('select public.admin_reset_all($1)', [ADMIN_CODE]);
    s.eq((await reqRows()).length, before, '전체 초기화(admin_reset_all)도 요청 번호 기록을 지우지 않음');
    // supabase.sql 다시 적용: 점수·번호 유지, score_add 는 하나뿐
    await setScores({ red: 321, blue: -45, yellow: 6, green: 1 });
    const rowsBefore = await reqRows();
    let r = reapplySql();
    s.eq(r.status, 0, `supabase.sql 을 다시 적용해도 오류 없음${r.status ? ': ' + r.stderr.slice(0, 300) : ''}`);
    s.eq([await dbScores(), await reqRows()], [{ red: 321, blue: -45, yellow: 6, green: 1 }, rowsBefore], 'supabase.sql 을 다시 적용해도 점수와 요청 번호 기록이 그대로');
    const sigs = async () => (await db.query("select pg_get_function_identity_arguments(oid) as a from pg_proc where proname = 'score_add' and pronamespace = 'public'::regnamespace")).rows.map((x) => x.a);
    s.eq(await sigs(), ['p_code text, p_team text, p_delta bigint, p_req text'], 'score_add 는 하나뿐(인자 네 개)');
    s.eq((await addReq('red', 1, 'req-aaaa-0001')).body.red, 321, '다시 적용한 뒤에도 옛 번호는 여전히 중복으로 처리됨');
    // 예전 세 인자 score_add 가 남아 있는 DB 에 다시 적용: 옛 함수가 지워지고 하나만 남음
    await db.query("create function public.score_add(p_code text, p_team text, p_delta bigint) returns json language sql as $$ select null::json $$");
    s.eq((await sigs()).length, 2, '(준비) 옛 세 인자 함수를 만들어 둠');
    r = reapplySql();
    s.eq(r.status, 0, `옛 세 인자 함수가 있는 DB 에 다시 적용해도 오류 없음${r.status ? ': ' + r.stderr.slice(0, 300) : ''}`);
    s.eq(await sigs(), ['p_code text, p_team text, p_delta bigint, p_req text'], '다시 적용하면 옛 세 인자 score_add 가 지워지고 네 인자 하나만 남음');
    const viaServer = await direct('score_add', { p_code: ADMIN_CODE, p_team: 'red', p_delta: 4, p_req: 'req-gggg-viaserver' });
    const noReq = await direct('score_add', { p_code: ADMIN_CODE, p_team: 'red', p_delta: 4 });
    s.eq([viaServer.body.red, noReq.body.red], [325, 329], '대리 서버(p_req 인자 이름 그대로 전달)로도 번호 있이·없이 모두 호출됨');
    s.eq(calls('score_add').filter((x) => x.args.p_req === 'req-gggg-viaserver').length, 1, '대리 서버 기록에 p_req 가 그대로 남음');
  });

  await scenario(6.4, '+N 표시와 소리·도는 방향은 내가 준 점수 기준(다른 탭이 5초 안에 같은 팀을 바꿔도), 최종 표시값은 서버가 돌려준 값', async (s) => {
    await clean(); resetCalls();
    await setScores({ red: 100, blue: 200 });
    const { page } = await newCtx();
    await login(page);
    await page.route(/\/rpc\/score_state$/, (r) => r.abort('failed')); // 5초 폴링이 끼어 화면이 먼저 따라오지 않게(다른 탭에서 방금 바뀐 상황을 만듦)
    s.eq((await sc(page)).shown.red, 100, '(준비) 점수판이 빨강 100 을 보여 줌');
    const tags = (t) => page.locator(`#tags-${t} .delta`).allInnerTexts();
    const audioLog = () => page.evaluate(() => window.__scoreAudio.log.map((l) => l.dir));
    // 다른 곳에서 빨강 +10 직후 이 탭에서 +50 → 표시는 +50(+60 아님), 소리 up, 위로 돎, 최종 160
    await db.query("update team_scores set score = 110 where team = 'red'");
    await give(page, 'red', 50, { wait: false });
    await wait(page, () => window.__score.spinning.red, null, 8000);
    s.eq([(await sc(page)).spinning.red, (await sc(page)).shown.red, await tags('red'), await audioLog()], ['up', 160, ['+50'], ['up']], '[위] 다른 곳에서 +10 된 직후 +50: +50 표시 · 위로 돎 · 올라가는 소리 1번 · 목표는 서버 값 160');
    await idle(page);
    s.eq([await textOf(page, 'red'), (await dbScores()).red, await page.locator('#status').innerText()], ['160', 160, '빨강 팀 +50 → 160점'], '[위] 최종 점수는 서버 값 160 · 상태 줄 "+50 → 160점"');
    s.eq([(await sc(page)).last, await page.locator('#undoBtn').isDisabled(), (await page.locator('#undoWhat').innerText()).trim()], [{ team: 'red', delta: 50 }, false, '빨강 +50'], '[위] 내가 준 요청의 응답으로 맞춘 것은 되돌리기를 비우지 않음(빨강 +50 되돌릴 수 있음)');
    await settled(page);
    // 화면 100, 서버가 다른 곳에서 크게 올라 300 인데 이 탭에서 −10 → 표시 −10, 소리 down, 아래로 돎(화면 100 → 서버 290 이라 값만 보면 올라가는 것처럼 보이는 경우), 최종 290
    await setScores({ red: 160, blue: 300 }); // blue: 화면 200, 서버 300(다른 탭이 +100)
    await give(page, 'blue', -10, { wait: false });
    await wait(page, () => window.__score.spinning.blue, null, 8000);
    s.eq([(await sc(page)).spinning.blue, (await sc(page)).shown.blue, await tags('blue'), (await audioLog()).slice(-1)], ['down', 290, ['−10'], ['down']], '[아래] 화면 200 · 서버 300 에서 −10: −10 표시 · 아래로 돎 · 내려가는 소리 · 목표 서버 값 290(화면 200 보다 높지만 준 점수 방향)');
    await idle(page);
    s.eq([await textOf(page, 'blue'), (await dbScores()).blue], ['290', 290], '[아래] 최종 점수는 서버 값 290');
    // 조용히 맞추는 경우(폴링)는 차이를 그대로 씀: 소리 없음
    await page.unroute(/\/rpc\/score_state$/);
    const n = (await audioLog()).length;
    await db.query("update team_scores set score = 500 where team = 'yellow'");
    await wait(page, () => window.__score.shown.yellow === 500, null, 15000);
    await idle(page);
    s.eq([(await audioLog()).length, (await tags('yellow'))[0]], [n, '+500'], '[폴링] 다른 곳에서 바뀐 점수는 차이(+500)를 표시하고 소리는 내지 않음');
  });

  await scenario(6.5, '직접 입력의 부호: 더하기는 입력한 부호 그대로, 빼기는 늘 마이너스(−50·50 모두 −50) · 입력 칸 길이(−1,000,000 이 잘리지 않음)', async (s) => {
    await clean(); resetCalls();
    const { page } = await newCtx(REDUCED);
    await login(page);
    await pick(page, 'red');
    const go = async (text, btn) => { const k = (await sc(page)).calls.score_add; await page.locator('#customAmt').fill(text); await page.locator(btn).click(); await wait(page, (n) => window.__score.calls.score_add >= n + 1 && !window.__score.busy, k); return scoreAddCalls().at(-1).args.p_delta; };
    s.eq(await go('50', '#addBtn'), 50, '50 + 더하기 → +50');
    s.eq(await go('50', '#subBtn'), -50, '50 + 빼기 → −50');
    s.eq(await go('-50', '#subBtn'), -50, '−50 + 빼기 → −50(예전에는 +50 이 들어갔음)');
    s.eq(await go('-50', '#addBtn'), -50, '−50 + 더하기 → −50(입력한 부호 그대로)');
    s.eq(await go('+50', '#subBtn'), -50, '+50 + 빼기 → −50');
    s.eq(await go('+50', '#addBtn'), 50, '+50 + 더하기 → +50');
    s.eq(await go('−50', '#subBtn'), -50, '(유니코드 마이너스 −)50 + 빼기 → −50');
    // Shift+Enter 도 같음
    const k = (await sc(page)).calls.score_add;
    await page.locator('#customAmt').fill('-50'); await page.locator('#customAmt').press('Shift+Enter');
    await wait(page, (n) => window.__score.calls.score_add >= n + 1 && !window.__score.busy, k);
    s.eq(scoreAddCalls().at(-1).args.p_delta, -50, '−50 + Shift+Enter(빼기) → −50');
    s.eq((await dbScores()).red, 50 - 50 - 50 - 50 - 50 + 50 - 50 - 50, 'DB 합계가 위 요청들과 맞음');
    // 입력 칸이 부호·쉼표까지 담음: 직접 쳐서(maxlength 적용) 확인
    await idle(page);
    const typed = async (text) => { await page.locator('#customAmt').fill(''); await page.locator('#customAmt').pressSequentially(text); return page.locator('#customAmt').inputValue(); };
    s.eq(await typed('-1,000,000'), '-1,000,000', '입력 칸에 −1,000,000(10자)이 잘리지 않고 들어감');
    s.eq(await typed('-999,999,999'), '-999,999,999', '입력 칸에 −999,999,999(12자)도 들어감(9자리 규칙의 최대)');
    s.eq(await page.locator('#customAmt').getAttribute('maxlength'), '12', '입력 칸 길이 제한은 부호+9자리+쉼표 둘 = 12자');
    await page.locator('#customAmt').fill('-1,000,000'); await page.locator('#addBtn').click(); await notBusy(page);
    s.eq(scoreAddCalls().at(-1).args.p_delta, -1000000, '−1,000,000 은 그대로 −1,000,000 으로 보내져 들어감(한 번에 허용 한도 정확히)');
    const n2 = scoreAddCalls().length;
    await page.locator('#customAmt').fill('-1,000,001'); await page.locator('#subBtn').click();
    s.ok(/1,000,000점까지/.test(await page.locator('#status').innerText()) && scoreAddCalls().length === n2, '−1,000,001 은 요청 없이 한도 안내');
    // 저장 성공 뒤 칸 비우기: 요청이 오가는 사이 다음 숫자를 쳐 두었으면 그대로 두고, 보낸 값 그대로면 비움
    await page.locator('#customAmt').fill(''); await idle(page);
    await slowAdd(page, 900);
    const k2 = scoreAddCalls().length;
    await page.locator('#customAmt').fill('5'); await page.locator('#addBtn').click();
    await wait(page, () => window.__score.busy);
    await page.locator('#customAmt').fill('7'); // 저장 중에 다음 숫자를 쳐 둠
    await notBusy(page);
    s.eq([scoreAddCalls().length - k2, scoreAddCalls().at(-1).args.p_delta, await page.locator('#customAmt').inputValue()], [1, 5, '7'], '[칸] 저장 중에 쳐 둔 다음 숫자(7)는 저장이 끝나도 남음(보낸 값은 5)');
    await page.locator('#customAmt').fill('9'); await page.locator('#addBtn').click();
    await wait(page, () => window.__score.busy);
    await notBusy(page);
    s.eq([scoreAddCalls().at(-1).args.p_delta, await page.locator('#customAmt').inputValue()], [9, ''], '[칸] 보낸 값 그대로면 저장이 끝난 뒤 비워짐');
    await page.unroute(/\/rpc\/score_add$/);
  });

  await scenario(7, '연습 모드: 입구 확인 말고는 DB 요청 0건, 점수·연출·소리는 그대로, 새로 고치면 처음으로', async (s) => {
    await setScores({ red: 11, blue: 22, yellow: 33, green: 44 }); await resetRoster(db, { picked: true }); resetCalls();
    const { page } = await newCtx();
    await page.goto(`${server.url}/score.html?practice=1`);
    s.eq(await enterGate(page), true, '연습 모드도 관리자 비밀번호를 넣어야 열림');
    await waitBoard(page);
    s.eq(server.calls.map((c) => c.fn), ['board_state'], '입구 확인 한 번(board_state)만 서버에 감');
    const st = await sc(page);
    s.eq([st.mode, st.shown, st.people], ['practice', ZERO, 29], '연습 점수는 0점에서 시작(DB 점수 11·22·33·44 는 안 보임) · 견본 이름 29명');
    s.eq(await page.evaluate(() => [document.getElementById('stage').dataset.mode, !document.getElementById('practiceBadge').hidden, !document.getElementById('watermark').hidden, document.title, document.getElementById('toPractice').hidden, document.getElementById('toLive').hidden, document.getElementById('toLive').getAttribute('href')]),
      ['practice', true, true, '연습 · 팀 점수판', true, false, 'score.html'], '연습 표시(배지·워터마크·탭 제목) · "실제 점수로" 링크');
    s.ok(/연습/.test(await page.locator('#status').innerText()) && /저장되지 않아요/.test(await page.locator('#status').innerText()), '안내: 점수는 저장되지 않아요');
    const names = await page.locator('.names').allInnerTexts();
    s.ok(names.every((t) => /견본 /.test(t)) && !names.join('').includes('견본가'), `연습 이름은 지어낸 견본 이름(견본 토끼…): ${names[0].slice(0, 30)}`);
    // 점수 주기(연출·소리는 그대로, 서버는 안 부름)
    await give(page, 'red', 100);
    await wait(page, () => window.__score.spinning.red === 'up');
    s.ok(true, '연습에서도 숫자가 위로 도는 연출');
    await idle(page);
    await give(page, 'blue', -50); await idle(page);
    await pick(page, 'yellow'); await page.locator('#customAmt').fill('1234'); await page.locator('#addBtn').click(); await notBusy(page); await idle(page);
    const p = await sc(page);
    s.eq(p.shown, { red: 100, blue: -50, yellow: 1234, green: 0 }, '연습 점수가 화면에 쌓임(마이너스 포함)');
    s.eq(await textOf(page, 'yellow'), '1,234', '연습 점수 표기');
    s.eq((await page.evaluate(() => window.__scoreAudio.log.map((x) => x.dir))), ['up', 'down', 'up'], '연습에서도 소리 요청이 남음(up·down·up)');
    await page.locator('#undoBtn').click(); await notBusy(page); await idle(page);
    s.eq((await sc(page)).shown.yellow, 0, '연습에서도 되돌리기 동작');
    await sleep(6500); // 5초 새로 받기가 한 번 돌 만큼
    s.eq(server.calls.map((c) => c.fn), ['board_state'], '연습 중 6.5초 동안에도 DB 요청은 입구 확인 한 건뿐(점수 읽기·쓰기·새로 받기 없음)');
    s.eq([page.nrpc('score_add'), page.nrpc('score_state')], [0, 0], '브라우저가 score_add·score_state 를 아예 보내지 않음');
    s.eq(await dbScores(), { red: 11, blue: 22, yellow: 33, green: 44 }, 'DB 점수는 그대로');
    // 새로 고치면 처음(0점)으로
    await page.reload();
    s.eq(await enterGate(page), false, '연습 화면도 같은 탭 새로 고침은 다시 안 묻고');
    await waitBoard(page);
    s.eq((await sc(page)).shown, ZERO, '새로 고치면 연습 점수는 처음(0점)으로 돌아감');
    s.eq(server.calls.map((c) => c.fn), ['board_state', 'board_state'], '새로 고침 뒤에도 입구 재확인 한 건만 더 감');
    s.eq(await dbScores(), { red: 11, blue: 22, yellow: 33, green: 44 }, '새로 고친 뒤에도 DB 점수 그대로');
    // 실제 화면은 DB 점수를 보여 줌(연습과 섞이지 않음)
    const live = await newCtx();
    await login(live.page);
    s.eq((await sc(live.page)).shown, { red: 11, blue: 22, yellow: 33, green: 44 }, '연습 뒤 실제 화면은 DB 점수 그대로');
  });

  await scenario(8, '관리자 페이지의 점수 초기화가 열려 있는 점수판에 반영(소리 없음)', async (s) => {
    await setScores({ red: 120, blue: -30, yellow: 0, green: 5 }); await resetRoster(db, { picked: true }); resetCalls();
    const A = await newCtx(); await login(A.page);
    s.eq((await sc(A.page)).shown, { red: 120, blue: -30, yellow: 0, green: 5 }, '준비: 점수판이 120·−30·0·5 를 보여 줌');
    const B = await newCtx({ code: true });
    B.page.on('dialog', (d) => d.accept());
    await B.page.goto(`${server.url}/board.html`);
    await B.page.locator('#glanceBody tr').nth(28).waitFor({ timeout: 10000 });
    await B.page.locator('#resetCard > summary').click();
    await B.page.locator('#resetScore').click();
    await wait(B.page, () => /점수 초기화를 마쳤어요/.test(document.querySelector('#resetMsg').textContent), null, 15000);
    s.eq(await dbScores(), ZERO, '관리자 페이지의 점수 초기화 → DB 점수 모두 0');
    const t0 = Date.now();
    await wait(A.page, () => Object.values(window.__score.shown).every((v) => v === 0), null, 12000);
    s.ok(Date.now() - t0 <= 8000, `점수판이 ${((Date.now() - t0) / 1000).toFixed(1)}초 만에 초기화 값을 따라옴`);
    await idle(A.page);
    await consistent(A.page, s, '초기화 뒤 점수판', ZERO);
    s.eq(await A.page.evaluate(() => window.__scoreAudio.log.length), 0, '초기화로 바뀐 점수는 소리 요청 없음');
    s.eq((await sc(A.page)).errorKind, null, '오류 상자 없음');
    // 초기화 뒤 다시 점수를 주면 0 에서 시작
    await give(A.page, 'red', 10); await idle(A.page);
    s.eq((await dbScores()).red, 10, '초기화 뒤 다시 주면 0 에서 시작(+10 → 10)');
    // 낡은 되돌리기: 내가 준 것(빨강 +10)이 있는 채로 다른 변화가 있으면
    await idle(A.page);
    const undoUi = async () => ({ last: (await sc(A.page)).last, off: await A.page.locator('#undoBtn').isDisabled(), what: (await A.page.locator('#undoWhat').innerText()).trim() });
    s.eq(await undoUi(), { last: { team: 'red', delta: 10 }, off: false, what: '빨강 +10' }, '[되돌리기] 내가 준 요청 직후엔 되돌리기가 켜져 있고 "빨강 +10"');
    await db.query("update team_scores set score = 77, updated_at = now() where team = 'blue'"); // 다른 팀(파랑)이 다른 곳에서 바뀜
    await wait(A.page, () => window.__score.shown.blue === 77, null, 12000); await idle(A.page);
    s.eq(await undoUi(), { last: { team: 'red', delta: 10 }, off: false, what: '빨강 +10' }, '[되돌리기] 다른 팀(파랑)의 변화로는 빨강의 되돌리기가 안 지워짐');
    resetCalls();
    await db.query("update team_scores set score = 0, updated_at = now() where team = 'red'"); // 관리자가 빨강을 0 으로(점수 초기화와 같은 결과)
    await wait(A.page, () => window.__score.shown.red === 0, null, 12000); await idle(A.page);
    s.eq(await undoUi(), { last: null, off: true, what: '' }, '[되돌리기] 빨강이 다른 곳에서 0 으로 맞춰지면 되돌리기 단추가 꺼지고 "빨강 +10" 글자도 사라짐');
    await A.page.keyboard.press('KeyU'); await sleep(250);
    await A.page.locator('#undoBtn').click({ force: true, timeout: 1000 }).catch(() => {});
    s.eq([calls('score_add').length, (await dbScores()).red, (await sc(A.page)).shown.red], [0, 0, 0], '[되돌리기] U 키를 눌러도(단추를 눌러도) 요청 0건 · 빨강 0 그대로(낡은 기록으로 −10 이 안 들어감)');
    // 관리자 페이지의 점수 초기화로 같은 팀이 맞춰지는 경우도 같음
    await give(A.page, 'green', 20); await idle(A.page);
    s.eq((await undoUi()).what, '초록 +20', '[되돌리기] 초록 +20 을 주면 다시 켜짐');
    await B.page.locator('#resetScore').click();
    await wait(B.page, () => /점수 초기화를 마쳤어요/.test(document.querySelector('#resetMsg').textContent), null, 15000);
    await wait(A.page, () => Object.values(window.__score.shown).every((v) => v === 0), null, 12000); await idle(A.page);
    s.eq(await undoUi(), { last: null, off: true, what: '' }, '[되돌리기] 관리자 페이지 점수 초기화로 초록이 0 이 되면 되돌리기도 비워짐');
  });

  await scenario(9, '움직임 줄이기(reducedMotion): 세지 않고(굴러가는 칸이 안 생기고) 바로 새 점수', async (s) => {
    await clean(); resetCalls();
    const { page } = await newCtx(REDUCED);
    await login(page);
    s.eq((await sc(page)).reduced, true, '__score.reduced = true');
    await page.evaluate(() => { // 굴러가는 칸(두 숫자가 든 strip·.roll)·세는 중 표시가 한 번이라도 생기는지 감시
      window.__seen = { spin: 0, strip: 0, animating: 0 };
      new MutationObserver(() => { for (const e of document.querySelectorAll('.score')) { if (e.dataset.spin || e.classList.contains('spinning')) window.__seen.spin++; if ([...e.querySelectorAll('.strip')].some((st) => st.children.length > 1)) window.__seen.strip++; } if (window.__score.animating) window.__seen.animating++; }).observe(document.getElementById('teams'), { subtree: true, childList: true, attributes: true });
      (function f() { if (window.__score.animating) window.__seen.animating++; requestAnimationFrame(f); })();
    });
    await recordSpin(page);
    await give(page, 'red', 100);
    s.eq(await page.locator('#score-red').evaluate((e) => [e.textContent.replace(/\s+/g, ''), e.dataset.value, e.dataset.spin]), ['100', '100', ''], '주자마자 바로 새 점수(100)가 보임 — 도는 중이 아님');
    await give(page, 'red', -250);
    s.eq(await textOf(page, 'red'), '−150', '내려가는 점수도 바로 −150');
    s.eq([(await sc(page)).display.red, await page.locator('#score-red').evaluate((e) => e.dataset.cur)], [-150, '-150'], '지금 보이는 값(display·data-cur)도 바로 −150 — 중간 값을 지나지 않음');
    await sleep(500);
    s.eq(await page.evaluate(() => window.__seen), { spin: 0, strip: 0, animating: 0 }, '굴러가는 칸·세는 중 표시·animating 이 한 번도 생기지 않음');
    s.eq(await page.evaluate(() => window.__spinRec.some((x) => x.a)), false, 'rAF 감시에서도 animating 이 한 번도 true 가 아님');
    const tag = await page.locator('#tags-red .delta').allInnerTexts();
    s.ok(tag.length >= 1 && /[+−]/.test(tag.join('')), `얼마 바뀌었는지(+100·−250) 표시는 남음: ${tag.join(',')}`);
    const au = await page.evaluate(() => window.__scoreAudio.log);
    s.eq(au.map((x) => [x.dir, x.ms]), [['up', 600], ['down', 600]], '움직임 줄이기: 소리도 짧게(600ms)');
    await consistent(page, s, '움직임 줄이기', { ...ZERO, red: -150 });
    // 화면을 켠 뒤 바뀌는 환경(prefers-reduced-motion 이 꺼진 context)에서는 돈다
    const n = await newCtx({ reducedMotion: 'no-preference' });
    await login(n.page); await give(n.page, 'blue', 10);
    s.ok((await sc(n.page)).spinning.blue === 'up' || (await sc(n.page)).animating, '(대조) 움직임 줄이기가 아니면 같은 조작에서 도는 연출이 생김');
  });

  for (const [w, h] of [[1920, 1080], [1280, 720]]) {
    await scenario(10, `${w}×${h}: 네 팀과 네 점수가 항상 화면 안 — 처음·도는 중·큰 점수·음수·오류 상자·긴 이름·이름 숨김`, async (s) => {
      await clean(); await resetRoster(db, { picked: true });
      // 이름이 많은 팀(8~10명)과 아주 긴 이름, 같은 이름(부서 표시)
      await db.query("update people set team = case when id <= 10 then 'red' when id <= 18 then 'blue' when id <= 24 then 'yellow' else 'green' end, picked_at = now()");
      await db.query("update people set name = '견본' || repeat('가나다라마바사아자차', 4) || '가나다라마바사아' where id = 1");
      await db.query("update people set name = '견본가' where id in (11, 19)"); // 같은 이름(다른 팀·부서)
      resetCalls();
      const { page } = await newCtx({ viewport: { width: w, height: h } });
      await login(page);
      const lab = `${w}x${h}`;
      await checkLayout(page, s, `${lab} 처음(0점·이름 많음)`);
      const f0 = await fontSizes(page);
      s.ok(f0.score.every((x) => x > f0.names * 3 && x > f0.controlMax * 3), `[${lab}] 점수 글자(${f0.score.map((x) => x.toFixed(0)).join('/')}px)가 이름(${f0.names.toFixed(0)}px)·조작부(${f0.controlMax.toFixed(0)}px)보다 3배 넘게 큼`);
      s.ok(f0.score.every((x) => x > f0.head), `[${lab}] 짧은 점수(0)는 팀 이름(${f0.head.toFixed(0)}px)보다도 큼`);
      s.eq(new Set(f0.score).size, 1, `[${lab}] 네 점수 글자 크기가 같음`);
      s.eq(await page.evaluate(() => ['red', 'blue', 'yellow', 'green'].map((t) => Math.round(document.getElementById(`score-${t}`).parentElement.getBoundingClientRect().top))).then((a) => new Set(a).size), 1, `[${lab}] 네 팀의 점수 칸이 같은 높이`);
      // 도는 중
      await fontSettled(page);
      await overflowProbe(page);
      await give(page, 'red', 100, { wait: false });
      await wait(page, () => window.__score.spinning.red);
      await fontSettled(page);
      s.ok((await sc(page)).spinning.red === 'up', `[${lab}] (확인) 글자 크기 전환이 끝난 뒤에도 아직 도는 중`);
      await checkLayout(page, s, `${lab} 도는 중(+100)`);
      await idle(page);
      // 자릿수가 늘고 주는 연출을 이어서(1→3→6→음수 5자리→3→음수에서 양수): 점수 숫자가 칸 밖으로 나가는 부분이 한 번도 없어야 함(허용 오차 0)
      for (const d of [900000, -1000000, 99000, 1000]) { await give(page, 'red', d); await idle(page); }
      await give(page, 'blue', 1234); await idle(page);
      const ov = await page.evaluate(() => window.__ov);
      s.eq([ov.ms, ov.max], [0, 0], `[${lab}] 자릿수가 바뀌는 내내(글자 크기 전환 포함) 네 점수가 점수 칸 밖으로 한 번도 안 나감(칸 밖으로 나간 시간 ${Math.round(ov.ms)}ms · 최대 ${((ov.max - 1) * 100).toFixed(1)}% 초과 ${JSON.stringify(ov.info || null)})`);
      await fontSettled(page);
      const f2 = await fontSizes(page);
      s.ok(f2.score.every((x) => x > f2.head && x > f2.names * 3 && x > f2.controlMax * 3), `[${lab}] 일반 점수(0~수십만)는 팀 이름(${f2.head.toFixed(0)}px)·이름(${f2.names.toFixed(0)}px)·조작부(${f2.controlMax.toFixed(0)}px)보다 훨씬 큼(점수 ${f2.score.map((x) => x.toFixed(0)).join('/')}px)`);
      // 큰 점수·음수
      await setScores({ red: 999999999, blue: -123456789, yellow: -1, green: 1000000 });
      await page.reload(); await enterGate(page); await waitBoard(page); await fontSettled(page);
      await checkLayout(page, s, `${lab} 큰 점수·음수(999,999,999 / −123,456,789 / −1 / 1,000,000)`);
      const f1 = await fontSizes(page);
      s.ok(f1.score.every((x) => x > f1.names && x > f1.controlMax), `[${lab}] 9자리·음수에서도 점수(${f1.score.map((x) => x.toFixed(0)).join('/')}px)가 이름(${f1.names.toFixed(0)}px)·조작부(${f1.controlMax.toFixed(0)}px)보다 큼`);
      if (Math.min(...f1.score) < f1.head) s.note(`[${lab}] 9자리 점수(${Math.min(...f1.score).toFixed(0)}px)가 팀 이름 글자(${f1.head.toFixed(0)}px)보다 약간 작아짐(칸 너비에 맞춰 줄어든 것 — 허용. 이름·조작부보다 큰 것은 위에서 확인)`);
      // 도는 중 + 9자리: 음수에서 더 큰 음수로 / 양수 쪽
      await give(page, 'blue', -999999, { wait: false });
      await wait(page, () => window.__score.spinning.blue);
      await fontSettled(page);
      await checkLayout(page, s, `${lab} 큰 음수가 도는 중(−124,456,788)`);
      await idle(page);
      await give(page, 'yellow', 100000, { wait: false });
      await wait(page, () => window.__score.spinning.yellow);
      await fontSettled(page);
      await checkLayout(page, s, `${lab} 음수에서 양수로 도는 중(−1 → 99,999)`);
      await idle(page); await fontSettled(page);
      s.eq(await textOf(page, 'yellow'), '99,999', `[${lab}] 도는 연출 뒤 정확한 값`);
      // 오류 상자가 떠 있을 때(점수·이름이 안 가려짐)
      await rejectAdd(page, '시험용 저장 실패: 아주 긴 오류 문구를 넣어 상자가 두 줄이 되어도 점수를 가리지 않는지 보려고 일부러 길게 적었어요');
      await give(page, 'green', 10);
      s.eq((await sc(page)).errorKind, 'error', `[${lab}] 오류 상자 뜸`);
      await checkLayout(page, s, `${lab} 오류 상자가 떠 있을 때`);
      await page.unroute(/\/rpc\/score_add$/);
      await page.locator('#alertClose').click();
      // 이름 숨김
      const boxTops = () => page.evaluate(() => ['red', 'blue', 'yellow', 'green'].map((t) => Math.round(document.getElementById(`score-${t}`).parentElement.getBoundingClientRect().top)));
      const tops0 = await boxTops();
      await page.locator('#namesBtn').click(); await fontSettled(page);
      await checkLayout(page, s, `${lab} 이름 숨김`);
      s.eq(await page.evaluate(() => getComputedStyle(document.querySelector('.names')).visibility), 'hidden', `[${lab}] 이름 숨김이면 이름이 안 보임`);
      s.eq(await boxTops(), tops0, `[${lab}] 이름을 숨겨도 점수 칸 자리가 그대로(이름 자리는 비워 둠)`);
      s.eq(new Set(tops0).size, 1, `[${lab}] 네 팀의 점수 칸이 같은 높이에 놓임`);
      await page.locator('#namesBtn').click();
      // 소리 시험·확인 상자가 떠 있을 때도 무대 안
      await page.locator('#lockBtn').click();
      const dlg = await page.locator('.dlg-box').boundingBox();
      s.ok(dlg.x >= 0 && dlg.y >= 0 && dlg.x + dlg.width <= w && dlg.y + dlg.height <= h, `[${lab}] 확인 상자가 화면 안`);
      await page.locator('#dlgCancel').click();
      // 연습 모드(견본 이름)도 같은 틀
      const pr = await newCtx({ viewport: { width: w, height: h } });
      await login(pr.page, '?practice=1');
      await checkLayout(pr.page, s, `${lab} 연습 모드`);
    });
  }

  await scenario(11, '소리 요청 관측(window.__scoreAudio): 올릴 때 up 1건·내릴 때 down 1건·소리 시험 test 1건, 끊기(cuts), 끄기, 첫 점수부터 요청', async (s) => {
    await clean(); resetCalls();
    const { page } = await newCtx();
    await login(page);
    const au = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__scoreAudio)));
    let a = await au();
    s.eq([a.log.length, a.muted, a.cuts], [0, false, 0], '들어온 직후: 소리 요청 0건 · 소리 켜짐 · 끊기 0');
    s.eq(await page.evaluate(() => [document.getElementById('soundBtn').getAttribute('aria-pressed'), document.getElementById('soundBtn').textContent]), ['true', '🔊 소리 켜짐'], '소리 단추: 켜짐이 기본');
    // 첫 점수부터 소리 요청(오디오는 입구 비밀번호 제출 때 깨워 둠)
    await recordSpin(page);
    await give(page, 'red', 50);
    a = await au();
    s.eq(a.log.map((x) => [x.dir, x.played, x.muted, x.ms]), [['up', true, false, 2000]], '[올림] 처음 점수를 줄 때부터 up 1건(소리 재생 예약됨, 도는 부분 2000ms)');
    s.ok(a.state === 'running' && a.started === true, `[올림] 오디오가 실제로 돌고 있음(state=${a.state})`);
    s.ok(Math.abs(a.log[0].at - Date.now()) < 5000, '[올림] 기록 시각이 지금 가까이');
    await idle(page);
    const ms = await spinMs(page);
    s.ok(ms >= 1800 && ms <= 2400, `[길이] 숫자가 도는 시간 ${Math.round(ms)}ms ≈ 소리의 도는 부분(${a.log[0].ms}ms), 1.8~2.4초`);
    s.ok(Math.abs(ms - a.log[0].ms) <= 400, `[길이] 연출 길이와 소리 길이가 400ms 안에서 맞음(차이 ${Math.round(Math.abs(ms - a.log[0].ms))}ms)`);
    await give(page, 'blue', -10);
    a = await au();
    s.eq(a.log.map((x) => x.dir), ['up', 'down'], '[내림] 내릴 때 down 1건');
    await idle(page);
    // 소리 시험 단추
    await page.locator('#soundTestBtn').click();
    a = await au();
    s.eq([a.log.at(-1).dir, a.log.at(-1).played, a.log.at(-1).ms, a.log.length], ['test', true, 1700, 3], '[시험] 소리 시험 단추 → test 1건(1700ms) · 점수는 안 바뀜');
    s.eq((await dbScores()).red, 50, '[시험] 소리 시험은 점수를 바꾸지 않음');
    s.ok(a.log.every((x) => x.dir !== 'end-up' && x.dir !== 'end-down'), '마무리 소리는 따로 기록하지 않음(같은 건 안에 들어 있음)');
    // 연달아 줄 때 이전 소리를 끊음
    await page.waitForTimeout(3000); // 앞 소리가 모두 끝나게
    const cuts0 = (await au()).cuts;
    await give(page, 'green', 10);            // 새 소리 시작(앞 소리는 이미 끝남 → 끊기 없음)
    s.eq((await au()).cuts, cuts0, '[끊기] 앞 소리가 이미 끝났으면 끊기(cuts) 안 늘어남');
    await give(page, 'green', 10);            // 앞 소리가 아직 나는 중 → 끊고 새로
    await give(page, 'green', -10);
    a = await au();
    s.eq(a.cuts - cuts0, 2, '[끊기] 소리가 나는 중에 다시 줄 때마다 이전 소리를 끊음(cuts +2) — 소리가 겹치지 않음');
    s.eq(a.log.slice(-3).map((x) => x.dir), ['up', 'up', 'down'], '[끊기] 소리 요청은 줄 때마다 한 건씩');
    await idle(page);
    // 소리 끄기: 요청 기록은 남고 played=false
    await page.locator('#soundBtn').click();
    a = await au();
    s.eq([a.muted, await page.locator('#soundBtn').getAttribute('aria-pressed'), await page.evaluate(() => sessionStorage.getItem('score-muted'))], [true, 'false', '1'], '[끄기] 소리 끄기 단추 → muted · aria-pressed=false · 이 탭에 기억');
    const nm = a.log.length;
    await give(page, 'red', 5);
    a = await au();
    s.eq([a.log.length - nm, a.log.at(-1).dir, a.log.at(-1).played, a.log.at(-1).muted], [1, 'up', false, true], '[끄기] 꺼진 동안에도 up 요청은 기록되지만 played=false(소리 안 냄)');
    await page.locator('#soundTestBtn').click();
    a = await au();
    s.eq([a.log.at(-1).dir, a.log.at(-1).played], ['test', false], '[끄기] 소리 시험도 꺼져 있으면 played=false');
    s.ok(/소리가 꺼져 있어서 안 들려요/.test(await page.locator('#status').innerText()), '[끄기] 소리 시험을 누르면 꺼져 있다고 안내');
    // 소리를 켜면 그 안내만 지움(다른 안내는 그대로)
    await page.locator('#soundBtn').click();
    s.eq([(await sc(page)).muted, await page.locator('#status').innerText()], [false, ''], '[안내] 소리를 켜면 "소리가 꺼져 있어서 안 들려요" 안내가 지워짐');
    await page.locator('#soundBtn').click(); await page.locator('#soundTestBtn').click();
    s.ok(/소리가 꺼져 있어서 안 들려요/.test(await page.locator('#status').innerText()), '[안내] 다시 끄고 시험하면 안내가 다시 뜸');
    await give(page, 'red', 5); await idle(page);
    const stGive = await page.locator('#status').innerText();
    await page.locator('#soundBtn').click();
    s.eq([(await sc(page)).muted, await page.locator('#status').innerText(), /→/.test(stGive)], [false, stGive, true], '[안내] 다른 안내(점수를 준 뒤 상태 줄)는 소리를 켜도 지워지지 않음');
    await page.locator('#soundBtn').click(); // 다시 끔(아래 새로 고침 시험이 끈 상태를 기대)
    await idle(page);
    await page.reload(); await enterGate(page); await waitBoard(page);
    s.eq(await au().then((x) => [x.muted, x.log.length]), [true, 0], '[끄기] 새로 고쳐도 소리 끔이 유지됨(기록은 새로 시작)');
    await page.locator('#soundBtn').click();
    s.eq(await au().then((x) => x.muted), false, '[끄기] 다시 켜면 켜짐');
    // 새로 고친 뒤 첫 점수부터 요청이 있고 오디오가 깨어남(첫 사용자 동작에서 resume)
    await give(page, 'yellow', 10);
    a = await au();
    s.eq([a.log.map((x) => x.dir), a.log[0].played, a.state], [['up'], true, 'running'], '[새로 고침 뒤] 첫 점수부터 up 요청 · 재생 예약 · 오디오 running');
    await idle(page);
    // 움직이는 점수 중 같은 요청이 두 번 기록되지 않음
    s.eq(calls('score_add').length, page.nrpc('score_add'), '요청 수 일치');
  });

  await scenario(12, '키보드(1~4·Q W E·A S·Enter·Shift+Enter·U·M·H)·되돌리기·입력 중엔 가로채지 않음·팀 안 고르고 주기', async (s) => {
    await clean(); resetCalls();
    const { page } = await newCtx(REDUCED);
    await login(page);
    // 팀을 안 고르고 주려 하면 요청 0건 + 안내
    await page.locator('#q-p10').click();
    s.ok(/먼저 팀을 골라 주세요/.test(await page.locator('#status').innerText()), '[팀 안 고름] 단추: 안내');
    s.eq(await page.locator('#picks').evaluate((e) => e.classList.contains('need')), true, '[팀 안 고름] 팀 고르는 곳을 표시');
    await page.keyboard.press('KeyQ');
    await page.locator('#customAmt').fill('5'); await page.locator('#addBtn').click();
    s.ok(/먼저 팀을 골라 주세요/.test(await page.locator('#status').innerText()), '[팀 안 고름] 직접 입력 더하기도 안내');
    s.eq([page.nrpc('score_add'), (await sc(page)).team], [0, null], '[팀 안 고름] 서버 요청 0건 · 고른 팀 없음');
    await page.locator('#customAmt').fill(''); await page.evaluate(() => document.activeElement.blur());
    // 1~4 로 팀 고르기
    for (const [i, t] of TEAMS.entries()) {
      await page.keyboard.press(`Digit${i + 1}`);
      s.eq(await page.evaluate(() => [window.__score.team, [...document.querySelectorAll('.team.sel')].map((e) => e.id), [...document.querySelectorAll('.pick[aria-checked="true"]')].map((e) => e.id)]), [t, [`team-${t}`], [`pick-${t}`]], `[키] ${i + 1} → ${KO[t]} 팀 고름`);
    }
    await page.keyboard.press('Numpad2');
    s.eq((await sc(page)).team, 'blue', '[키] 숫자 패드 2 도 파랑');
    // 점수 키
    const exp = { ...ZERO };
    await page.keyboard.press('Digit1');
    for (const [key, d] of [['KeyQ', 10], ['KeyW', 50], ['KeyE', 100], ['KeyA', -10], ['KeyS', -50]]) {
      await page.keyboard.press(key); await notBusy(page); exp.red += d;
      s.eq((await dbScores()).red, exp.red, `[키] ${key.slice(3)} → 빨강 ${d > 0 ? '+' : ''}${d}`);
    }
    // Enter → 직접 입력 칸 → 숫자 → Enter(더하기) / Shift+Enter(빼기)
    await page.keyboard.press('Digit3');
    await page.keyboard.press('Enter');
    s.eq(await page.evaluate(() => document.activeElement.id), 'customAmt', '[키] Enter → 직접 입력 칸으로 이동');
    await page.keyboard.type('25');
    await page.keyboard.press('Enter'); await notBusy(page);
    s.eq((await dbScores()).yellow, 25, '[키] 25 입력 후 Enter → 노랑 +25');
    await page.keyboard.press('Enter'); await page.keyboard.type('40'); await page.keyboard.press('Shift+Enter'); await notBusy(page);
    s.eq((await dbScores()).yellow, -15, '[키] 40 입력 후 Shift+Enter → 노랑 −40');
    s.eq(await page.evaluate(() => document.activeElement === document.body || document.activeElement.id !== 'customAmt'), true, '[키] 주고 나면 입력 칸에서 나옴(다음 키가 점수 키로 동작)');
    // 입력 중에는 가로채지 않음
    await page.keyboard.press('Digit4'); await page.keyboard.press('Enter');
    const st0 = await sc(page);
    const nIn = page.nrpc('score_add');
    await page.keyboard.type('2'); await page.keyboard.type('q'); await page.keyboard.type('m'); await page.keyboard.type('h'); await page.keyboard.type('u');
    const st1 = await sc(page);
    s.eq([await page.locator('#customAmt').inputValue(), st1.team, st1.muted, st1.namesHidden, page.nrpc('score_add')], ['2', 'green', st0.muted, st0.namesHidden, nIn], '[입력 중] 글자·숫자 키를 쳐도 팀이 안 바뀌고 소리·이름·되돌리기 키가 안 먹음(요청 수 그대로)');
    await page.keyboard.press('Escape');
    s.eq(await page.evaluate(() => [document.getElementById('customAmt').value, document.activeElement.id !== 'customAmt']), ['', true], '[입력 중] Esc 는 비우고 나감');
    // 키 반복은 점수를 안 줌 / M · H
    const nreq = page.nrpc('score_add');
    await page.evaluate(() => { for (const c of ['KeyW', 'KeyU', 'Enter']) for (let i = 0; i < 3; i++) document.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c === 'Enter' ? 'Enter' : c.slice(3).toLowerCase(), repeat: true, bubbles: true })); });
    await sleep(250);
    s.eq([page.nrpc('score_add') - nreq, await page.evaluate(() => document.activeElement.id !== 'customAmt')], [0, true], '[키 반복] W·U·Enter 를 누르고 있어도(repeat) 점수·되돌리기·입력 이동 없음');
    // 키를 누르고 있어(keyboard.down 을 거듭해 repeat 가 됨) 소리·이름이 계속 바뀌지 않음: 한 번만
    const hold = async (code, n = 4) => { for (let i = 0; i < n; i++) await page.keyboard.down(code); await page.keyboard.up(code); };
    const m0 = (await sc(page)).muted;
    await hold('KeyM');
    s.eq((await sc(page)).muted, !m0, '[키 반복] M 을 누르고 있어도(처음 1번 + repeat 3번 = 짝수 번) 소리 켜짐/꺼짐은 한 번만 바뀜');
    await hold('KeyM');
    s.eq((await sc(page)).muted, m0, '[키 반복] M 을 다시 누르고 있으면 한 번 더 바뀜(처음 상태)');
    const h0 = (await sc(page)).namesHidden;
    await hold('KeyH');
    s.eq((await sc(page)).namesHidden, !h0, '[키 반복] H 를 누르고 있어도 이름 숨김은 한 번만 바뀜');
    await hold('KeyH');
    s.eq((await sc(page)).namesHidden, h0, '[키 반복] H 를 다시 누르고 있으면 한 번 더 바뀜');
    const rs = (await sc(page)).calls.score_state;
    await hold('KeyR', 6); await sleep(300);
    s.ok((await sc(page)).calls.score_state - rs <= 1, '[키 반복] R 을 누르고 있어도 점수 새로 받기는 한 번만');
    await page.keyboard.press('KeyM');
    s.eq(await page.evaluate(() => [window.__score.muted, document.getElementById('soundBtn').getAttribute('aria-pressed')]), [true, 'false'], '[키] M → 소리 끔');
    await page.keyboard.press('KeyM');
    await page.keyboard.press('KeyH');
    s.eq(await page.evaluate(() => [window.__score.namesHidden, document.getElementById('namesBtn').getAttribute('aria-pressed'), document.getElementById('stage').dataset.names]), [true, 'true', 'off'], '[키] H → 이름 숨김');
    await page.keyboard.press('KeyH');
    // 되돌리기
    await clean(); await page.reload(); await enterGate(page); await waitBoard(page);
    resetCalls();
    await page.keyboard.press('KeyU'); await sleep(150);
    s.eq(calls('score_add').length, 0, '[되돌리기] 준 것이 없으면 U 는 아무 일도 안 함(새로 고친 뒤 서버 요청 0건)');
    s.ok(await page.locator('#undoBtn').isDisabled(), '[되돌리기] 준 것이 없으면 단추 꺼짐');
    await page.keyboard.press('Digit2'); await page.keyboard.press('KeyW'); await notBusy(page);
    s.eq([await page.locator('#undoBtn').isDisabled(), (await page.locator('#undoWhat').innerText()).trim()], [false, '파랑 +50'], '[되돌리기] 주고 나면 단추가 켜지고 "파랑 +50" 표시');
    const au0 = await page.evaluate(() => window.__scoreAudio.log.length);
    await page.keyboard.press('KeyU'); await notBusy(page);
    s.eq(await dbScores(), ZERO, '[되돌리기] U → 반대 값(−50)이 들어가 파랑 0');
    s.eq(await page.evaluate((n) => window.__scoreAudio.log.slice(n).map((x) => x.dir), au0), ['down'], '[되돌리기] 되돌리는 점수도 연출·소리가 함께(down 1건)');
    s.ok(await page.locator('#undoBtn').isDisabled(), '[되돌리기] 되돌린 뒤에는 단추가 다시 꺼짐(한 번만)');
    await page.keyboard.press('KeyU'); await sleep(200);
    s.eq(calls('score_add').map((c) => c.args.p_delta), [50, -50], '[되돌리기] U 를 또 눌러도 더 안 되돌려짐(요청은 +50, −50 두 번뿐)');
    // 단추로 되돌리기 + 두 번 빠르게 눌러도 한 번
    await page.keyboard.press('Digit3'); await page.keyboard.press('KeyE'); await notBusy(page);
    await slowAdd(page, 600);
    await page.evaluate(() => { const b = document.getElementById('undoBtn'); b.click(); b.click(); b.click(); });
    await notBusy(page);
    s.eq([(await dbScores()).yellow, calls('score_add').map((c) => c.args.p_delta).slice(2)], [0, [100, -100]], '[되돌리기] 단추를 빠르게 여러 번 눌러도 −100 한 번만(되돌리기가 중복되지 않음)');
    await page.unroute(/\/rpc\/score_add$/);
    // 되돌리기는 마지막으로 준 팀에(다른 팀을 골랐어도)
    await page.keyboard.press('Digit1'); await page.keyboard.press('KeyW'); await notBusy(page);
    await page.keyboard.press('Digit4');
    await page.keyboard.press('KeyU'); await notBusy(page);
    s.eq(await dbScores(), ZERO, '[되돌리기] 다른 팀을 골라 둔 뒤 눌러도 방금 준 팀(빨강)의 점수가 되돌려짐');
    await consistent(page, s, '키보드 시험 끝', ZERO);
  });

  await scenario(13, '이름 표시: 팀원이 팀 아래에·안 뽑힌 팀은 이름 없이·이름 숨김(새로 고침 유지)·HTML 이스케이프·새로 받기', async (s) => {
    await clean(); await resetRoster(db, { picked: true }); resetCalls();
    const rows = (await db.query('select id, name, dept, team from people order by id')).rows;
    const by = (t) => rows.filter((r) => r.team === t).map((r) => r.name).sort();
    const { page } = await newCtx(REDUCED);
    await login(page);
    const namesOf = (t) => page.locator(`#names-${t} .nm`).evaluateAll((els) => els.map((e) => e.firstChild.textContent).sort());
    for (const t of TEAMS) {
      s.eq(await namesOf(t), by(t), `[${KO[t]}] 팀원 이름이 이 팀 칸 아래에 모두 나옴(그 팀이 아닌 사람은 없음)`);
      s.eq(await page.locator(`#count-${t}`).innerText(), by(t).length ? `${by(t).length}명` : '', `[${KO[t]}] 인원 표시`);
    }
    s.eq(await page.evaluate(() => document.getElementById('score-red').closest('.team').querySelector('.names').compareDocumentPosition(document.getElementById('score-red')) & Node.DOCUMENT_POSITION_PRECEDING), 2, '이름은 점수 뒤(아래)에 있음');
    s.eq(await page.evaluate(() => ['red', 'blue', 'yellow', 'green'].map((t) => document.getElementById(`score-${t}`).getBoundingClientRect().bottom <= document.getElementById(`names-${t}`).getBoundingClientRect().top + 1)), [true, true, true, true], '이름은 화면에서도 점수 아래');
    // 안 뽑힌 팀은 이름 없이 팀만
    await db.query("update people set team = null, picked_at = null where team = 'green'");
    await wait(page, () => document.querySelector('#names-green').textContent.trim() === '', null, 12000);
    s.eq(await page.evaluate(() => [document.getElementById('names-green').textContent.trim(), document.getElementById('count-green').textContent, document.querySelector('#team-green .tn').textContent, document.getElementById('score-green').textContent.trim() !== '']), ['', '', '초록 팀', true], '[안 뽑힌 팀] 이름 없이 팀 이름·점수만(5초 새로 받기로 반영)');
    s.eq((await namesOf('red')), by('red'), '다른 팀 이름은 그대로');
    // 같은 이름은 (부서)로 구분
    await db.query("update people set name = '견본가' where id in (5, 6)"); // 부서가 다른 두 사람(id 1 과는 부서가 달라 겹치지 않음)
    await wait(page, () => document.querySelectorAll('.names small').length >= 2, null, 12000).catch(() => {});
    const small = await page.evaluate(() => [...document.querySelectorAll('.names small')].map((e) => e.textContent));
    s.ok(small.length >= 2 && small.every((t) => /^\(.+\)$/.test(t)), `같은 이름이 둘 이상이면 (부서)가 붙음: ${small.join(',')}`);
    // HTML 이 든 이름은 태그로 안 들어감
    await db.query("update people set name = '<b>견본</b>', dept = '<i>부</i>' where id = 9");
    await db.query("update people set name = '<img src=x onerror=\"window.__xss=1\">' where id = 1");
    await wait(page, () => /<b>견본<\/b>/.test(document.querySelector('#names-red').textContent), null, 12000);
    await sleep(300);
    const x = await page.evaluate(() => ({ tags: document.querySelectorAll('.names b, .names i, .names img').length, xss: window.__xss === undefined, text: document.getElementById('names-red').textContent }));
    s.eq([x.tags, x.xss], [0, true], 'HTML 이 든 이름은 글자 그대로 나오고 태그로 안 들어감(스크립트도 안 돌음)');
    s.ok(x.text.includes('<b>견본</b>') && x.text.includes('<img src=x'), `이름 글자 그대로 보임: ${x.text.slice(0, 80)}`);
    // 이름 숨기기: 스위치·유지
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    s.eq(await page.evaluate(() => [document.getElementById('namesBtn').textContent, document.getElementById('namesBtn').getAttribute('aria-pressed')]), ['이름 숨기기', 'false'], '[숨기기] 처음엔 이름이 보임(단추는 "이름 숨기기")');
    await page.locator('#namesBtn').click();
    s.eq(await page.evaluate(() => [window.__score.namesHidden, document.getElementById('namesBtn').textContent, document.getElementById('namesBtn').getAttribute('aria-pressed'), getComputedStyle(document.getElementById('names-red')).visibility, document.getElementById('stage').dataset.names]), [true, '이름 보이기', 'true', 'hidden', 'off'], '[숨기기] 누르면 이름이 안 보임');
    s.ok(((await page.locator('#score-red').boundingBox()).height) > 50, '[숨기기] 점수는 그대로 크게 보임');
    await page.reload(); await enterGate(page); await waitBoard(page);
    s.eq(await page.evaluate(() => [window.__score.namesHidden, getComputedStyle(document.getElementById('names-red')).visibility]), [true, 'hidden'], '[숨기기] 새로 고쳐도 숨김 유지(이 탭)');
    await page.locator('#namesBtn').click();
    s.eq(await page.evaluate(() => [window.__score.namesHidden, getComputedStyle(document.getElementById('names-red')).visibility]), [false, 'visible'], '[숨기기] 다시 누르면 보임');
    await page.keyboard.press('KeyH'); await page.keyboard.press('KeyH');
    s.eq(await page.evaluate(() => window.__score.namesHidden), false, '[숨기기] H 키로도 켜고 끔');
    s.eq(calls('score_add').length, 0, '이름을 시험하는 동안 점수 쓰기 요청 0건');
  });

  // ── 정리 · 보고 ──────────────────────────────────────
  await browser.close();
  await server.close();
  await db.end();
  console.log('\n══ 요약 ══');
  for (const r of results) console.log(`${r.ok ? '통과' : '실패'}  [${r.num}] ${r.name}  (${r.checks}개 확인, ${(r.ms / 1000).toFixed(1)}초)`);
  if (layoutFindings.length) {
    console.log(`\n레이아웃 점검 발견 ${layoutFindings.length}건:`);
    for (const l of [...new Set(layoutFindings)]) console.log('  - ' + l);
  }
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, results, layoutFindings };
}
