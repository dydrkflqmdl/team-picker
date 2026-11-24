// 관리자 페이지(board.html)를 지금 참가자 화면(아침 메뉴·점심·자유시간·탑승 차량은 11/25 15시 마감, 팀·방은 현장 발표용 뽑기 화면)에 맞춘 것 시험:
// 한눈에 보기의 차량 열·타일, 분류 단추(차량·아침 메뉴·점심·자유시간·방·팀), 엑셀 파일·백업 파일의 열, 마감 안내 네 칸의 같은 틀,
// 팀·객실표 안내와 발표용 뽑기 화면 링크(버튼 모양), 프로젝터 보기 경고, 프로젝터 보기(?tv=1), 휴대폰 너비(390px)에서 가로로 안 넘치는지,
// 칸 통일(모든 칸이 같은 접는 칸·같은 제목 줄·순서·접힌 제목 줄 숫자·열림 기억·5초 새로고침·저장소 막힘·접고 편 뒤 기능).
// 사용: node run.mjs admin   (DB 올리기 → 시험 → DB 끄기). 운영 DB 에는 닿지 않음(helpers.mjs 의 guardNetwork).
// 견본 이름은 seed.mjs 의 지어낸 이름('견본○'), 관리자 비밀번호는 시험용 값.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ADMIN_CODE, connect } from './db.mjs';
import { resetRoster } from './seed.mjs';
import { startServer } from './server.mjs';
import { openTestBrowser, guardNetwork } from './helpers.mjs';

const CARS = [{ id: 'car1', name: '1호차', label: '견본 문구', driver: 29 }, { id: 'car2', name: '2호차', label: '' }]; // 운전자: 견본고(id 29)
const DEADLINE_RE = /^참가자는 11\/25\(수\) 15시까지 .+ 수 있어요\. 그 뒤로는 여기서만 바꿀 수 있어요\. \(방법: .+\)$/; // 마감 전
const CLOSED_RE = /^마감됐어요\(11\/25\(수\) 15시\)\. 지금은 여기서만 바꿀 수 있어요\. \(방법: .+\)$/; // 마감 뒤
const T_BEFORE = Date.parse('2026-11-25T14:00:00+09:00'); // 마감(11/25 15시) 한 시간 전 — 화면 시계를 이 시각으로
const T_AFTER = Date.parse('2026-11-25T15:00:01+09:00');  // 마감 1초 뒤
const DEADLINE_SPEC = [ // [칸 이름, 안내 id, 방법에 들어 있어야 할 말]
  ['아침 메뉴', '#menuDeadline', '직접 고치기'], ['점심', '#lunchDeadline', '직접 고치기'], ['자유시간', '#actDeadline', '직접 고치기'], ['탑승 차량', '#carDeadline', '직접 옮기기'],
];
const OPEN_KEY = 'team-picker-board-open'; // 관리자 페이지 칸 열림 기억
// 칸(모두 details.card) 순서: 한눈에 보기 → 참가자 메인 순서(일정·차량·아침·점심·자유시간) → 현장 뽑기(객실표·팀) → 관리용(명단 관리·초기화)
const CARD_ORDER = ['glanceCard', 'planCard', 'carCard', 'menuCard', 'lunchCard', 'actCard', 'roomCard', 'teamCard', 'scoreCard', 'admin', 'resetCard'];
const CSV_HEAD = ['부서', '이름', '직급', '성별', '구분', '탑승 차량', '아침 메뉴', '점심', '자유시간', '객실', '팀'];

// 확인·입력 상자를 모아 두고 대답함: answer(d) 가 true 면 확인(prompt 는 text), 아니면 취소
function dialogs(page, answer = () => false) {
  const seen = [];
  page.on('dialog', async (d) => {
    seen.push({ type: d.type(), msg: d.message() });
    const a = answer(d);
    if (a) await d.accept(typeof a === 'string' ? a : undefined); else await d.dismiss();
  });
  return seen;
}
// 확인 상자가 n개 뜰 때까지 기다림(고정 대기 대신 — 확인 전에 새로 받기 왕복이 들어가 느린 환경에서도 안 흔들리게). 취소가 끝난 뒤 잠깐 더 둠
async function waitDialogs(page, seen, n = 1, ms = 15000) {
  const end = Date.now() + ms;
  while (seen.length < n && Date.now() < end) await page.waitForTimeout(50);
  await page.waitForTimeout(100);
}
// CSV 글 → 칸 배열(따옴표로 감싼 칸만 씀)
const parseCsv = (text) => text.replace(/^﻿/, '').split(/\r?\n/).map((l) => [...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')));

export async function adminAlignTests() {
  const db = await connect();
  const server = await startServer({ port: 0 });
  const env = await openTestBrowser(server.url);
  let pass = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log('  통과: ' + msg); };
  const eq = (a, b, msg) => { assert.deepEqual(a, b, `${msg}\n    기대: ${JSON.stringify(b)}\n    실제: ${JSON.stringify(a)}`); pass++; console.log('  통과: ' + msg); };
  const errors = [];

  // 팀·아침 메뉴 12명, 방 10명, 점심 8명, 자유시간 6명(seed --picked) + 차량 목록·운전자(견본고) + 차량 손님 5명(id 1~5)
  async function fill() {
    await resetRoster(db, { picked: true });
    await db.query('select public.admin_set_cars($1, $2::jsonb)', [ADMIN_CODE, JSON.stringify(CARS)]);
    await db.query("update public.people set car = case when id % 2 = 0 then 'car1' else 'car2' end, car_at = now() - (10 - id) * interval '1 second' where id <= 5");
  }
  const people = async () => (await db.query('select id, name, team, menu, lunch, activity, room, car from public.people order by id')).rows;

  // 관리자 화면 열기(비밀번호는 저장된 것으로). opt.width: 화면 너비, opt.url: 주소 끝, opt.noCars: 차량 자료 받기를 막음,
  // opt.fixed: 화면 시계를 그 시각(ms)으로 고정(마감 전·후 문구 시험), opt.install: 화면 시계를 그 시각부터 흐르게 하고 page.clock.fastForward 로 건너뜀(열어 둔 채 마감 넘기기)
  async function openBoard({ width = 1280, url = '', noCars = false, answer, fixed, install } = {}) {
    const page = await env.newPage();
    await page.setViewportSize({ width, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    // 비밀번호는 저장된 것으로. 칸 열림 기억(OPEN_KEY)은 이 탭을 처음 열 때만 지움(같은 context 의 페이지끼리 localStorage 를 같이 써서 앞 시험에서 연 칸이 남지 않게. 새로 고침 뒤에는 그대로 둠)
    await page.addInitScript(([c, k]) => { try { localStorage.setItem('team-picker-admin', JSON.stringify(c)); if (!sessionStorage.getItem('fresh')) { localStorage.removeItem(k); sessionStorage.setItem('fresh', '1'); } } catch {} }, [ADMIN_CODE, OPEN_KEY]);
    if (noCars) await page.route('**/rest/v1/rpc/board_cars', (route) => route.abort());
    const seen = dialogs(page, answer);
    if (fixed) await page.clock.setFixedTime(new Date(fixed));
    if (install) await page.clock.install({ time: new Date(install) });
    await page.goto(`${server.url}/board.html${url}`);
    if (!/tv=1/.test(url)) await page.locator('#glanceBody tr').nth(28).waitFor({ timeout: 10000 });
    return { page, seen };
  }
  const tiles = (page) => page.locator('#glanceSum .gs').allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, ' ').trim()));
  const facetNames = (page) => page.locator('#facets .facet-name').evaluateAll((els) => els.map((e) => e.textContent.trim())); // 칸이 접혀 있어도 읽음
  const facetBtn = (page, title, label) => page.locator(`#facets .facet[aria-label="${title}"] button`).filter({ hasText: new RegExp(`^${label}(\\s|$)`) });
  // 칸 펴기(이미 펴져 있으면 그대로) — 제목 줄을 실제로 눌러서
  const openCard = async (page, id) => { if (!(await page.locator(`#${id}`).evaluate((d) => d.open))) await page.locator(`#${id} > summary`).click(); };
  // 팀을 아직 안 뽑은 사람의 이름 누르기: 먼저 화면 안으로 옮기고 잠깐 기다린 뒤 누름(넓은 화면에서는 화면이 움직이면 이름 메뉴가 닫히므로, 누른 직후의 자동 스크롤에 닫히지 않게)
  const clickWho = async (page) => { const b = page.locator('#waiting .who').first(); await b.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await b.click(); await page.locator('#sheet').waitFor(); };
  const body = (page) => page.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('script, style').forEach((e) => e.remove()); return c.textContent.replace(/\s+/g, ' '); });

  try {
    await fill();
    const all = await people();

    // ── 1. 한눈에 보기: 열 순서·차량 열·차량 타일 ──
    {
      const { page } = await openBoard();
      await page.waitForFunction(() => /차량 6\/29/.test(document.querySelector('#glanceSum').textContent), null, { timeout: 15000 });
      eq((await page.locator('.glance thead th').allInnerTexts()).map((t) => t.trim()), ['부서', '이름', '차량', '아침 메뉴', '점심', '자유시간', '방', '팀'], '[한눈에] 열 순서: 부서·이름·차량·아침 메뉴·점심·자유시간·방·팀');
      const t = await tiles(page);
      eq(t.map((x) => x.match(/^(차량|아침 메뉴|점심|자유시간|방|팀)/)[1]), ['차량', '아침 메뉴', '점심', '자유시간', '방', '팀'], '[한눈에] 요약 타일 순서');
      ok(/^차량 6\/29/.test(t[0]) && t[0].includes('운전자 1명 포함'), `[한눈에] "차량 6/29" 타일(손님 5 + 운전자 1): ${t[0]}`);
      ok(/^아침 메뉴 12\/29/.test(t[1]) && /^점심 8\/29/.test(t[2]) && /^자유시간 6\/29/.test(t[3]) && /^방 10\/29/.test(t[4]) && /^팀 12\/29/.test(t[5]), `[한눈에] 나머지 타일 숫자: ${t.join(' | ')}`);
      const row = (name) => page.locator('#glanceBody tr').filter({ hasText: name });
      const cells = async (name) => (await row(name).locator('td').allInnerTexts()).map((x) => x.trim());
      const c1 = await cells('견본가'); // id 1: 2호차 손님, 아침·점심·자유시간·방·팀 모두 있음
      eq([c1[2], c1[7] !== '아직'], ['2호차', true], `[한눈에] 손님은 차량 이름: ${c1.join(' / ')}`);
      const c29 = await cells('견본고'); // id 29: 1호차 운전자
      ok(c29[2].startsWith('1호차') && c29[2].includes('운전'), `[한눈에] 운전자는 "1호차 운전": ${c29[2]}`);
      const c20 = await cells('견본버'); // id 20: 차량 없음
      eq(c20[2], '아직', '[한눈에] 차량 없는 사람은 다른 열처럼 "아직"');
      eq(await page.locator('#glanceBody tr:first-child td').count(), 8, '[한눈에] 첫 줄 칸 수 8');
      // 차량으로 줄 세우기: 1호차 → 2호차 → 차량 없음(맨 뒤), 한 번 더 누르면 거꾸로
      await page.locator('.glance th button[data-gsort="car"]').click();
      const col = async () => (await page.locator('#glanceBody tr td:nth-child(3)').allInnerTexts()).map((x) => x.trim());
      let c = await col();
      ok(c.slice(0, 3).every((x) => x.startsWith('1호차')) && c.slice(3, 6).every((x) => x === '2호차') && c.slice(6).every((x) => x === '아직'), `[한눈에·차량 정렬] 1호차 3 → 2호차 3 → 아직 23: ${c.slice(0, 8).join(',')}…`);
      eq(await page.locator('.glance th[aria-sort] button').innerText(), '차량', '[한눈에·차량 정렬] 정렬 중인 머리글 표시');
      await page.locator('.glance th button[data-gsort="car"]').click();
      c = await col();
      ok(c[0] === '아직' && c[c.length - 1].startsWith('1호차'), `[한눈에·차량 거꾸로] 차량 없는 사람이 앞: ${c[0]} … ${c[c.length - 1]}`);
      await page.close();
    }

    // ── 2. 차량 자료를 못 받았을 때: 표·타일은 "-", 분류 단추 없음, 표는 그대로 ──
    {
      const { page } = await openBoard({ noCars: true });
      await page.waitForTimeout(2500); // car-board.js 의 첫 받기(0.8초 뒤)가 실패할 시간
      eq(await page.locator('#glanceBody tr').count(), 29, '[차량 없음] 한눈에 보기 줄 수 그대로');
      eq(await page.locator('#glanceBody tr td:nth-child(3)').allInnerTexts().then((a) => [...new Set(a.map((x) => x.trim()))]), ['-'], '[차량 없음] 차량 칸은 모두 "-"(빨간 "아직"이 아님)');
      ok(/^차량 -\/29/.test((await tiles(page))[0]), `[차량 없음] 타일: ${(await tiles(page))[0]}`);
      ok(!(await facetNames(page)).includes('차량'), '[차량 없음] 분류 단추에 차량 줄이 없음');
      await page.locator('.glance th button[data-gsort="car"]').click(); // 정렬을 눌러도 깨지지 않음
      eq(await page.locator('#glanceBody tr').count(), 29, '[차량 없음] 차량으로 정렬해도 표가 그대로');
      // 엑셀 파일: 차량 칸은 비어 있고 그 사실을 알림
      await page.locator('#admin > summary').click();
      const dl = page.waitForEvent('download');
      await page.locator('#exportBtn').click();
      const rows = parseCsv(fs.readFileSync(await (await dl).path(), 'utf8'));
      eq(rows[0], CSV_HEAD, '[차량 없음] 엑셀 파일 머리글');
      ok(rows.slice(1).every((r) => r[5] === ''), '[차량 없음] 엑셀 파일의 탑승 차량 칸은 빈칸');
      ok(/탑승 차량 정보를 받지 못해/.test(await page.locator('#exportMsg').innerText()), `[차량 없음] 그 사실을 알림: ${await page.locator('#exportMsg').innerText()}`);
      await page.close();
    }

    // ── 3. 분류 단추: 차량·아침 메뉴·점심·자유시간·방·팀 ──
    {
      const { page } = await openBoard();
      await page.waitForFunction(() => document.querySelector('#facets .facet[aria-label="차량"]'), null, { timeout: 15000 });
      await page.locator('#admin > summary').click();
      eq(await facetNames(page), ['부서', '성별', '구분', '직급', '차량', '아침 메뉴', '점심', '자유시간', '방', '팀'], '[분류] 분류 줄 이름·순서');
      const n = (f) => all.filter(f).length;
      const shown = async () => (await page.locator('#shown').innerText()).trim();
      const rowsN = () => page.locator('#peopleBody tr').count();
      const countOf = async (title, label) => Number((await facetBtn(page, title, label).locator('b').innerText()).trim());
      // 단추의 인원수가 DB 와 맞는지
      eq([await countOf('점심', '안 고름'), await countOf('점심', '일반 설렁탕'), await countOf('점심', '얼큰 설렁탕')],
        [n((p) => !p.lunch), n((p) => p.lunch === 'plain'), n((p) => p.lunch === 'spicy')], '[분류·점심] 단추 인원수');
      eq([await countOf('자유시간', '안 고름'), await countOf('자유시간', '스키'), await countOf('자유시간', '휴식')],
        [n((p) => !p.activity), n((p) => p.activity === 'ski'), n((p) => p.activity === 'rest')], '[분류·자유시간] 단추 인원수');
      eq([await countOf('차량', '1호차'), await countOf('차량', '2호차'), await countOf('차량', '안 뽑음')], [3, 3, 23], '[분류·차량] 1호차(손님 2 + 운전자 1)·2호차 3·안 뽑음 23');
      eq([await countOf('방', '안 뽑음'), await countOf('방', '남자 1호실')], [n((p) => !p.room), n((p) => p.room === 'm1')], '[분류·방] 단추 인원수');
      eq(await countOf('아침 메뉴', '안 고름'), n((p) => !p.menu), '[분류·아침 메뉴] 안 고름 인원수');
      // 누르면 그 사람들만 보이고, 한 번 더 누르면 풀림
      await facetBtn(page, '점심', '안 고름').click();
      eq([await rowsN(), await shown()], [n((p) => !p.lunch), `29명 중 ${n((p) => !p.lunch)}명`], '[분류·점심] "안 고름"을 누르면 그 사람들만 보임');
      eq(await facetBtn(page, '점심', '안 고름').getAttribute('aria-pressed'), 'true', '[분류·점심] 눌린 단추 표시');
      await facetBtn(page, '점심', '안 고름').click();
      eq(await rowsN(), 29, '[분류·점심] 한 번 더 누르면 풀림');
      await facetBtn(page, '자유시간', '스키').click();
      eq(await rowsN(), n((p) => p.activity === 'ski'), '[분류·자유시간] 스키');
      await page.locator('#clearView').click();
      await facetBtn(page, '차량', '1호차').click();
      eq(await rowsN(), 3, '[분류·차량] 1호차를 누르면 손님·운전자 3명');
      const names1 = (await page.locator('#peopleBody tr td:nth-child(2)').allInnerTexts()).map((x) => x.trim()).sort();
      eq(names1, ['견본고', '견본나', '견본라'], '[분류·차량] 1호차는 견본나·견본라(손님)·견본고(운전자)');
      await page.locator('#clearView').click();
      await facetBtn(page, '차량', '안 뽑음').click();
      eq(await rowsN(), 23, '[분류·차량] 안 뽑음(운전자·손님 제외)');
      await page.locator('#clearView').click();
      await facetBtn(page, '방', '안 뽑음').click();
      eq(await rowsN(), n((p) => !p.room), '[분류·방] 안 뽑음');
      // 분류끼리는 함께 걸림: 점심 안 고름 + 방 안 뽑음, 조건 지우기가 전부 풂
      await facetBtn(page, '점심', '안 고름').click();
      eq(await rowsN(), n((p) => !p.room && !p.lunch), '[분류·함께] 방 안 뽑음 + 점심 안 고름');
      await facetBtn(page, '아침 메뉴', '안 고름').click();
      eq(await rowsN(), n((p) => !p.room && !p.lunch && !p.menu), '[분류·함께] + 아침 메뉴 안 고름');
      await page.locator('#clearView').click();
      eq([await rowsN(), await page.locator('#facets button[aria-pressed="true"]').count(), await page.locator('#clearView').isHidden()], [29, 0, true], '[분류] 조건 지우기가 새 분류까지 모두 풂');
      ok((await page.locator('.people thead th').allInnerTexts()).map((x) => x.trim()).includes('아침 메뉴'), '[분류] 명단 표 머리글 "아침 메뉴"');
      eq((await page.locator('.people thead th').allInnerTexts()).map((x) => x.trim()).filter(Boolean), ['부서', '이름', '직급', '성별', '팀', '아침 메뉴'], '[분류] 명단 표 열은 그대로(열을 더하지 않음)');
      await page.close();
    }

    // ── 4. 엑셀 파일 · 백업 파일의 열 ──
    {
      const { page } = await openBoard({ answer: (d) => (d.type() === 'prompt' ? '삭제' : false) });
      await page.waitForFunction(() => document.querySelector('#facets .facet[aria-label="차량"]'), null, { timeout: 15000 });
      await page.locator('#admin > summary').click();
      await facetBtn(page, '차량', '1호차').click();
      const dl = page.waitForEvent('download');
      await page.locator('#exportBtn').click();
      const d = await dl;
      ok(/^워크숍_명단_3명\.csv$/.test(d.suggestedFilename()), `[엑셀] 파일 이름: ${d.suggestedFilename()}`);
      const rows = parseCsv(fs.readFileSync(await d.path(), 'utf8'));
      eq(rows[0], CSV_HEAD, '[엑셀] 머리글: 부서·이름·직급·성별·구분·탑승 차량·아침 메뉴·점심·자유시간·객실·팀');
      eq(rows.length, 4, '[엑셀] 보이는 3명만');
      const r29 = rows.find((r) => r[1] === '견본고'), r2 = rows.find((r) => r[1] === '견본나');
      ok(r29[5] === '1호차 · 견본 문구(운전)', `[엑셀] 운전자 차량 칸: ${r29[5]}`);
      ok(r2[5] === '1호차 · 견본 문구', `[엑셀] 손님 차량 칸: ${r2[5]}`);
      // id 2(견본나): 팀·아침·점심(id<=8)·자유시간(id<=6)·방 모두 있음 → 칸이 비지 않음
      ok(r2.slice(6).every((x) => x !== ''), `[엑셀] 아침 메뉴·점심·자유시간·객실·팀 칸이 채워짐: ${r2.slice(6).join(' / ')}`);
      ok(r29.slice(6).every((x) => x === ''), `[엑셀] 아무것도 안 고른 사람은 빈칸: ${r29.slice(6).join(' / ')}`);
      ok(!rows[0].includes('조식'), '[엑셀] 머리글에 "조식"이 없음');
      eq(await page.locator('#exportMsg').innerText(), '', '[엑셀] 차량 자료가 있으면 안내 없음');
      // 차량 자료가 이미 있으면 통신을 기다리지 않고 바로 파일을 만듦(차량 자료 요청을 4초 늦춰도 그 안에 받아짐)
      await page.route('**/rest/v1/rpc/board_cars', async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue().catch(() => {}); });
      const t0 = Date.now();
      const dl2 = page.waitForEvent('download', { timeout: 3000 });
      await page.locator('#exportBtn').click();
      const d2 = await dl2;
      ok(Date.now() - t0 < 3000 && /^워크숍_명단_3명\.csv$/.test(d2.suggestedFilename()), `[엑셀·바로] 차량 요청이 늦어도 기다리지 않고 바로 받아짐(${Date.now() - t0}ms): ${d2.suggestedFilename()}`);
      eq(await page.locator('#exportMsg').innerText(), '', '[엑셀·바로] 안내 없음');
      await page.unroute('**/rest/v1/rpc/board_cars');
      // 명단 전체 삭제 전의 백업 파일도 같은 열(삭제는 하지 않고 상자만 보고 취소)
      await page.locator('#clearView').click();
      await page.locator('#removeAll').click();
      await page.locator('#backupBox').waitFor({ state: 'visible' });
      const bk = parseCsv(await page.locator('#bkText').inputValue());
      eq(bk[0], CSV_HEAD, '[백업] 머리글이 엑셀 파일과 같음');
      eq(bk.length, 30, '[백업] 명단 29명 전체');
      ok(/탑승 차량·아침 메뉴·점심·자유시간·객실·팀 포함/.test(await page.locator('#bkWhat').innerText()), `[백업] 상자 안내: ${(await page.locator('#bkWhat').innerText()).slice(0, 60)}…`);
      await page.locator('#bkNo').click();
      eq((await people()).length, 29, '[백업] 취소하면 명단 그대로');
      await page.close();
    }

    // ── 5. 마감 안내 네 칸: 같은 틀 · 제목 바로 아래(화면 시계는 마감 전으로 고정 — 시험을 언제 돌려도 같게) ──
    {
      const { page } = await openBoard({ fixed: T_BEFORE });
      const spec = [
        ['아침 메뉴', '#menuDeadline', '#menuCard > summary'],
        ['점심', '#lunchDeadline', '#lunchCard > summary'],
        ['자유시간', '#actDeadline', '#actCard > summary'],
        ['탑승 차량', '#carDeadline', '#carCard > summary'],
      ];
      for (const [name, sel, head] of spec) {
        const text = (await page.locator(sel).textContent()).replace(/\s+/g, ' ').trim();
        ok(DEADLINE_RE.test(text), `[마감 안내·${name}] 같은 틀: ${text}`);
        ok(await page.evaluate(([s, h]) => document.querySelector(h).nextElementSibling === document.querySelector(s), [sel, head]), `[마감 안내·${name}] 제목 바로 아래`);
      }
      ok(await page.evaluate(() => document.querySelector('#menuDeadline').compareDocumentPosition(document.querySelector('#menus')) & Node.DOCUMENT_POSITION_FOLLOWING), '[마감 안내·아침 메뉴] 목록(#menus)보다 위');
      const how = async (sel) => (await page.locator(sel).textContent()).match(/\(방법: (.+)\)$/)[1];
      ok((await how('#menuDeadline')).includes('직접 고치기') && (await how('#lunchDeadline')).includes('직접 고치기') && (await how('#actDeadline')).includes('직접 고치기') && (await how('#carDeadline')).includes('직접 옮기기'), '[마감 안내] 방법이 칸에 실제 있는 흐름(직접 고치기·직접 옮기기)을 가리킴');
      // 그 흐름이 실제로 있는지
      eq([await page.locator('#menuMove').count(), await page.locator('#lunchMove').count(), await page.locator('#actMove').count(), await page.locator('#carMove').count(), await page.locator('#peopleBody [data-edit]').count()], [1, 1, 1, 1, 29], '[마감 안내] 아침 메뉴·점심·자유시간 직접 고치기, 직접 옮기기, 명단 관리의 수정 단추가 그대로 있음');
      const note = (await page.locator('#carNote').textContent()).replace(/\s+/g, ' ');
      ok(/운전자는 뽑지 않고/.test(note) && /반씩/.test(note) && /마감 전에는 차량을 비우면 .*다시 뽑을 수 있어요/.test(note), `[마감 안내·탑승 차량] 핵심 안내(운전자 고정·반씩·마감 전 다시 뽑기): ${note}`);
      eq(await page.locator('#carCard > p.hint-line').count(), 2, '[마감 안내·탑승 차량] 안내는 두 문단');
      ok(await page.locator('#actDeadline + p.note').count() === 1, '[마감 안내·자유시간] 마감 안내 바로 뒤에 술 금지 안내가 그대로 있음');
      await page.close();
    }

    // ── 6. 아침 메뉴 이름 · 팀 숫자 · 대신 정하기 문구 · 방·팀 안내와 링크 ──
    {
      const { page, seen } = await openBoard();
      await page.waitForFunction(() => document.querySelector('#facets .facet[aria-label="차량"]'), null, { timeout: 15000 });
      const text = await body(page);
      ok(!text.includes('조식'), '[이름] 관리자 화면 글에 "조식"이 없음(복사해 식당에 전하는 글만 예외)');
      eq((await page.locator('#menuCard > summary .sum-t').textContent()).trim(), '12/18(금) 아침 메뉴', '[이름] 칸 제목');
      eq((await page.locator('#stats').innerText()).replace(/\s+/g, ' '), '전체 29명 · 팀 뽑음 12명 · 팀 남음 17명', '[팀 숫자] 맨 위 숫자');
      ok((await page.locator('#waitBox > h3').textContent()).trim().startsWith('팀을 아직 안 뽑은 사람'), '[팀 숫자] 팀 칸 안 "팀을 아직 안 뽑은 사람" 제목');
      eq((await page.locator('#waitingCount').textContent()).trim(), '17명', '[팀 숫자] 남은 사람 수');
      await openCard(page, 'menuCard');
      await openCard(page, 'teamCard');
      // 아침 메뉴 복사 글은 식당과 쓰는 말 "조식"을 그대로 둠
      await page.locator('#menuCopy').click();
      await page.waitForFunction(() => document.querySelector('#menuCopyBox').value, null, { timeout: 5000 });
      ok((await page.locator('#menuCopyBox').inputValue()).startsWith('12/18(금) 조식: '), `[이름] 식당에 전하는 복사 글은 "조식" 그대로: ${await page.locator('#menuCopyBox').inputValue()}`);
      // 팀 대신 정하기: 표의 단추와 이름 메뉴(실제로 팀을 정하지는 않고 문구만 봄)
      const c0 = server.calls.length;
      const proxyBtn = page.locator('#peopleBody [data-proxy]').first();
      eq((await proxyBtn.textContent()).trim(), '팀 대신 정하기', '[대신 정하기] 표의 단추 이름');
      await clickWho(page);
      let sheet = (await page.locator('#sheet').innerText()).replace(/\s+/g, ' ');
      ok(sheet.includes('팀 대신 정하기') && sheet.includes('팀은 원래 발표용 뽑기 화면에서 뽑아요') && !sheet.includes('대신 뽑기'), `[대신 정하기] 이름 메뉴: ${sheet}`);
      await page.locator('#sheet [data-sa="proxy"]').click();
      sheet = (await page.locator('#sheet').innerText()).replace(/\s+/g, ' ');
      ok(sheet.includes('현장 뽑기 대신') && sheet.includes('발표용 뽑기 화면') && sheet.includes('아침 메뉴는 안 골라도') && !sheet.includes('조식'), `[대신 정하기] 확인 상자 문구: ${sheet}`);
      await page.locator('#sheet [data-sa="back"]').click();
      await page.keyboard.press('Escape');
      eq(server.calls.slice(c0).filter((c) => c.fn === 'pick').length, 0, '[대신 정하기] 문구만 보고 닫음 — 팀을 정하는 호출 없음');
      // 팀 칸 안내 + 링크 세 곳
      ok(/팀은 참가자가 직접 뽑지 않고 현장에서 발표용 뽑기 화면으로 뽑아요/.test(await page.locator('#teamNote').innerText()), '[팀 안내] 한 줄 안내');
      await page.locator('#roomCard > summary').click();
      for (const id of ['#drawLink', '#drawLinkTeam', '#drawLinkRoom']) {
        const a = page.locator(id);
        ok(await a.isVisible() && /(^|\/)draw\.html$/.test(await a.getAttribute('href')), `[링크] ${id} 보임 · 주소 ${await a.getAttribute('href')}`);
        const st = await a.evaluate((el) => { const s = getComputedStyle(el); return { fs: s.fontSize, h: el.getBoundingClientRect().height, border: s.borderTopWidth, bg: s.backgroundColor, deco: s.textDecorationLine }; });
        ok(st.fs === '14px' && st.h >= 36 && st.border === '1px' && st.deco === 'none', `[링크] ${id} 버튼 모양(14px·높이 ${Math.round(st.h)}px·테두리·밑줄 없음)`);
      }
      eq(await page.locator('a[href="draw.html"]').count(), 3, '[링크] draw.html 링크는 맨 위·팀 칸·객실표 칸 세 곳');
      // 발표용 점수판 링크: 맨 위(뽑기 화면 링크 옆)와 팀 점수 칸 안 두 곳, 뽑기 화면 링크와 같은 버튼 모양
      await page.locator('#scoreCard > summary').click();
      const look = (el) => { const s = getComputedStyle(el); return { fs: s.fontSize, h: el.getBoundingClientRect().height, border: s.borderTopWidth, deco: s.textDecorationLine, tag: el.tagName, cls: el.className }; };
      const drawLook = await page.locator('#drawLink').evaluate(look);
      for (const id of ['#scoreLink', '#scoreLinkCard']) {
        const a = page.locator(id);
        ok(await a.isVisible() && /(^|\/)score\.html$/.test(await a.getAttribute('href')), `[점수판 링크] ${id} 보임 · 주소 ${await a.getAttribute('href')}`);
        const st = await a.evaluate(look);
        ok(st.tag === 'A' && /(^| )btn( |$)/.test(st.cls) && st.fs === '14px' && st.h >= 36 && st.border === '1px' && st.deco === 'none', `[점수판 링크] ${id} a.btn 버튼 모양(14px·높이 ${Math.round(st.h)}px·테두리·밑줄 없음)`);
      }
      eq(await page.locator('#scoreLink').evaluate(look).then((x) => [x.fs, x.border, x.deco, Math.round(x.h)]), [drawLook.fs, drawLook.border, drawLook.deco, Math.round(drawLook.h)], '[점수판 링크] #scoreLink 와 #drawLink 의 글자 크기·테두리·높이가 같음');
      const [db1, sb1] = await Promise.all([page.locator('#drawLink').boundingBox(), page.locator('#scoreLink').boundingBox()]);
      ok(sb1.x > db1.x && Math.abs(sb1.y - db1.y) < 4, `[점수판 링크] #scoreLink 는 #drawLink 오른쪽 옆(같은 줄): draw (${Math.round(db1.x)},${Math.round(db1.y)}) score (${Math.round(sb1.x)},${Math.round(sb1.y)})`);
      eq(await page.locator('a[href="score.html"]').count(), 2, '[점수판 링크] score.html 링크는 맨 위·팀 점수 칸 두 곳');
      eq(await page.locator('a[href="draw.html"]').count(), 3, '[점수판 링크] 뽑기 화면 링크는 그대로 세 곳');
      ok(await page.locator('#scoreLink').evaluate((el) => el.closest('.admin-only') === el), '[점수판 링크] 맨 위 링크는 관리자 전용(admin-only)');
      // 객실표 안내
      const room = (await page.locator('#roomNote').innerText()).replace(/\s+/g, ' ');
      ok(room.includes('방은 현장에서 진행자가 발표용 뽑기 화면(draw.html)으로 뽑아요(남녀 따로·인원은 고르게·나머지는 무작위). 여기서는 결과를 확인하고 직접 고칠 수 있어요.') && room.includes('방을 비우면 발표용 화면에서 다시 뽑아요'), `[객실표 안내] ${room}`);
      ok(!/참가자가 .*방 뽑기|방 뽑기로 직접/.test(room), '[객실표 안내] 참가자가 직접 방을 뽑는다는 말이 없음');
      seen.length = 0;
      await page.locator('#roomAuto').click(); // 이미 방이 정해진 사람이 있어 확인 상자가 뜸 → 취소
      await waitDialogs(page, seen);
      ok(seen.length === 1 && seen[0].msg.includes('발표용 뽑기 화면에서 뽑은 방 포함') && !seen[0].msg.includes('참가자가 직접'), `[객실표 확인 문구] ${seen[0] && seen[0].msg.split('\n')[0]}`);
      eq((await people()).filter((p) => p.room).length, 10, '[객실표 확인 문구] 취소하면 방 그대로');
      // 프로젝터 보기 경고
      const warn = page.locator('#tvWarn');
      eq((await warn.innerText()).trim(), '발표용 뽑기 화면으로 뽑는 중이면 이 화면을 프로젝터에 띄우지 마세요. 결과가 미리 보여요.', '[프로젝터 경고] 문구');
      ok(await warn.isVisible(), '[프로젝터 경고] 평소 화면에서 보임');
      const [wb, tb] = await Promise.all([warn.boundingBox(), page.locator('#tvBtn').boundingBox()]);
      ok(Math.abs(wb.y - tb.y) < 60 && wb.y >= tb.y, `[프로젝터 경고] 프로젝터 보기 단추 바로 아래(세로 간격 ${Math.round(wb.y - tb.y)}px)`);
      ok(await page.locator('#tvBtn').isVisible() && (await page.locator('#tvBtn').innerText()) === '프로젝터 보기', '[프로젝터 경고] 확인 상자를 새로 넣지 않음 — 단추는 그대로 한 번에 바뀜');
      await page.close();
    }

    // ── 7. 프로젝터 보기(?tv=1): 그대로 열리고 관리용 칸·차량·경고는 안 보임 ──
    {
      const { page } = await openBoard({ url: '?tv=1' });
      await page.locator('#columns .col').first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(1500);
      eq(await page.locator('#columns .col').count(), 4, '[프로젝터] 팀 열 4개');
      eq(await page.evaluate(() => document.body.classList.contains('tv')), true, '[프로젝터] tv 모양');
      for (const sel of ['#glanceCard', '#carCard', '#tvWarn', '#teamNote', '#drawLink', '#drawLinkTeam', '#scoreLink', '#scoreLinkCard', '#scoreCard', '#roomCard', '#admin', '#resetCard', '.glance-sum']) {
        ok(!(await page.locator(sel).first().isVisible()), `[프로젝터] ${sel} 안 보임`);
      }
      ok(await page.locator('#menuCard').isVisible() && await page.locator('#waiting').isVisible(), '[프로젝터] 아침 메뉴·팀을 아직 안 뽑은 사람 칸은 그대로 보임');
      ok(!(await page.locator('#menuDeadline').isVisible()), '[프로젝터] 마감 안내는 관리자용이라 안 보임');
      eq((await page.locator('#tvBtn').innerText()).trim(), '관리자 페이지로', '[프로젝터] 단추 글');
      eq(await page.locator('#glanceBody tr').count(), 0, '[프로젝터] 한눈에 보기(차량 포함)는 그리지 않음');
      // 칸을 접는 칸으로 바꾼 뒤에도 프로젝터 보기는 예전처럼: 팀 열 → 팀을 아직 안 뽑은 사람 → 아침 메뉴, 모두 펼친 채, 꺾쇠·팀 칸 제목 줄 없음, 큰 글씨
      eq(await page.evaluate(() => ['teamCard', 'menuCard'].map((id) => document.getElementById(id).open)), [true, true], '[프로젝터] 팀·아침 메뉴 칸은 펼친 채');
      ok(!(await page.locator('#teamCard > summary').isVisible()), '[프로젝터] 팀 칸은 제목 줄 없이 팀 열이 바로 나옴');
      const ys = await page.evaluate(() => ['#columns', '#waitBox', '#menuCard'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)));
      ok(ys[0] < ys[1] && ys[1] < ys[2], `[프로젝터] 예전 순서: 팀 열 → 팀을 아직 안 뽑은 사람 → 아침 메뉴 (${ys.join(' < ')})`);
      eq(await page.evaluate(() => getComputedStyle(document.querySelector('#menuCard > summary'), '::after').display), 'none', '[프로젝터] 접는 꺾쇠 없음');
      eq(await page.evaluate(() => [getComputedStyle(document.querySelector('#columns .col .count')).fontSize, getComputedStyle(document.querySelector('#menuCard > summary')).fontSize, getComputedStyle(document.querySelector('#waitBox > h3')).fontSize, getComputedStyle(document.querySelector('#waitBox')).borderTopWidth]),
        ['56px', '20px', '20px', '1px'], '[프로젝터] 큰 글씨 그대로(팀 인원 56px · 제목 20px) · 팀을 아직 안 뽑은 사람은 테두리 상자');
      await page.evaluate(() => document.querySelector('#menuCard > summary').click()); // 눌려도(키보드 등) 다시 펼쳐짐
      await page.waitForTimeout(200);
      eq(await page.evaluate(() => document.getElementById('menuCard').open), true, '[프로젝터] 제목 줄이 눌려도 접히지 않음');
      eq(await page.evaluate((k) => localStorage.getItem(k), OPEN_KEY), null, '[프로젝터] 펼친 상태를 저장하지 않음');
      // 관리자 화면 → 프로젝터 보기 → 되돌아오기
      await page.locator('#tvBtn').click();
      await page.waitForFunction(() => !document.body.classList.contains('tv'));
      await page.waitForFunction(() => document.querySelectorAll('#glanceBody tr').length === 29, null, { timeout: 5000 });
      ok(await page.locator('#tvWarn').isVisible() && await page.locator('#glanceCard').isVisible(), '[프로젝터] 관리자 페이지로 돌아오면 경고·한눈에 보기가 다시 보임');
      eq(await page.evaluate(() => [...document.querySelectorAll('#boardView > details.card')].filter((d) => d.open).map((d) => d.id)), ['glanceCard'], '[프로젝터] 돌아오면 칸은 저장된(처음) 상태로 — 팀·아침 메뉴는 다시 접힘');
      await page.locator('#tvBtn').click();
      await page.waitForFunction(() => document.body.classList.contains('tv'));
      ok(!(await page.locator('#tvWarn').isVisible()), '[프로젝터] 다시 프로젝터 보기로 가면 경고가 숨음');
      await page.close();
    }

    // ── 8. 휴대폰 너비(390px): 가로로 넘치지 않음 ──
    {
      const { page } = await openBoard({ width: 390 });
      await page.waitForFunction(() => document.querySelector('#facets .facet[aria-label="차량"]'), null, { timeout: 15000 });
      const over = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      let o;
      // 모든 칸을 접은 채: 제목 줄(제목 + 숫자 + 꺾쇠)이 겹치거나 넘치지 않음
      await page.evaluate(() => document.querySelectorAll('#boardView > details.card').forEach((d) => { d.open = false; }));
      await page.waitForTimeout(300);
      const sumBad = () => page.evaluate(() => [...document.querySelectorAll('#boardView > details.card > summary')].map((s) => {
        const r = s.getBoundingClientRect(), t = s.querySelector('.sum-t').getBoundingClientRect(), n = s.querySelector('.sum-n').getBoundingClientRect();
        const cross = !(t.right <= n.left + 0.5 || n.right <= t.left + 0.5 || t.bottom <= n.top + 0.5 || n.bottom <= t.top + 0.5);
        return (cross || r.right > innerWidth || Math.max(t.right, n.right) > r.right - 27) ? `${s.parentNode.id}: 겹침 ${cross} · 오른쪽 ${Math.round(Math.max(t.right, n.right))}/${Math.round(r.right)}` : '';
      }).filter(Boolean));
      eq(await sumBad(), [], '[390px] 접힌 칸 제목 줄: 제목·숫자가 겹치지 않고 꺾쇠 자리·화면 오른쪽을 넘지 않음');
      o = await over();
      ok(o.sw <= o.cw, `[390px] 모든 칸을 접은 채로도 가로로 넘치지 않음(${o.sw} ≤ ${o.cw})`);
      await page.evaluate(() => document.querySelectorAll('#boardView > details.card').forEach((d) => { d.open = true; }));
      await page.waitForTimeout(500);
      eq(await sumBad(), [], '[390px] 편 칸 제목 줄도 겹치거나 넘치지 않음');
      o = await over();
      ok(o.sw <= o.cw, `[390px] 모든 칸을 펴도 가로로 넘치지 않음(scrollWidth ${o.sw} ≤ ${o.cw})`);
      const out = await page.evaluate(() => [...document.querySelectorAll('#boardView .card, #teamNote, .head, .glance-sum, #facets')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.id || e.className));
      eq(out, [], '[390px] 카드·머리·타일·분류가 화면 오른쪽을 넘지 않음');
      const sum = await page.evaluate(() => [...document.querySelectorAll('#glanceSum .gs')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }));
      ok(sum.length === 6 && sum.every(([l, r]) => l >= 0 && r <= 390), `[390px] 요약 타일 6개가 화면 안에 놓임: ${JSON.stringify(sum)}`);
      for (const id of ['#drawLink', '#drawLinkTeam', '#drawLinkRoom', '#scoreLink']) ok(await page.locator(id).isVisible(), `[390px] ${id} 보임`);
      ok(await page.locator('#tvWarn').isVisible(), '[390px] 프로젝터 경고 보임');
      await page.setViewportSize({ width: 1280, height: 900 });
      o = await over();
      ok(o.sw <= o.cw, `[1280px] 모든 칸을 펴도 가로로 넘치지 않음(${o.sw} ≤ ${o.cw})`);
      await page.close();
    }

    // ── 9. 칸 통일: 모든 칸이 같은 접는 칸 · 순서 · 접힌 제목 줄 숫자 · 열림 기억 · 5초 새로고침 · 접고 편 뒤 기능 · 저장소 막힘 ──
    {
      await fill();
      await db.query("select public.admin_set($1, 'schedule', $2)", [ADMIN_CODE, 'Day 1 · 12/17(목)\n10:00 출발\n12:30 점심\n\nDay 2 · 12/18(금)\n09:00 특강']);
      const { page, seen } = await openBoard();
      const openIds = () => page.evaluate(() => [...document.querySelectorAll('#boardView > details.card')].filter((d) => d.open).map((d) => d.id));
      await page.waitForFunction(() => /^6\/29명 정해짐/.test(document.querySelector('#carCount').textContent), null, { timeout: 15000 });

      // 구조: #boardView 바로 아래 칸은 모두 details.card, 제목 줄은 제목(.sum-t) + 숫자(small.sum-n#…Count)뿐(단추 없음), 모양이 모두 같음
      const st = await page.evaluate(() => {
        const bv = document.querySelector('#boardView');
        const cards = [...bv.children].filter((e) => e.matches('.card, section, details'));
        return {
          ids: cards.map((e) => e.id),
          tags: cards.map((e) => `${e.tagName}.${e.className}`),
          h2: bv.querySelectorAll('h2').length,
          sums: cards.map((d) => { const s = d.querySelector(':scope > summary'); return s ? `${[...s.children].map((c) => `${c.tagName}.${c.className}${c.id ? '#' + c.id : ''}`).join(' ')} 단추${s.querySelectorAll('button, a, input, select, textarea').length}` : '없음'; }),
          look: cards.map((d) => { const s = d.querySelector(':scope > summary'), c = getComputedStyle(s), a = getComputedStyle(s, '::after'), k = getComputedStyle(d);
            return [c.fontSize, c.fontWeight, c.lineHeight, c.paddingRight, c.display, c.cursor, a.borderRightWidth, a.width, a.right, k.borderRadius, k.paddingTop, k.marginBottom, getComputedStyle(s.querySelector('small')).fontSize].join(' '); }),
        };
      });
      eq(st.ids, CARD_ORDER, '[칸] 순서: 한눈에 보기 → 일정표 → 탑승 차량 → 아침 메뉴 → 점심 → 자유시간 → 객실표 → 팀 → 팀 점수 → 명단 관리 → 초기화');
      ok(st.tags.every((t) => /^DETAILS\.card( admin-only)?$/.test(t)), `[칸] 모두 접고 펴는 칸(details.card): ${st.tags.join(', ')}`);
      eq(st.h2, 0, '[칸] 늘 펼쳐진 칸(h2 제목)이 남아 있지 않음');
      ok(st.sums.every((x) => /^SPAN\.sum-t SMALL\.sum-n#\w+Count 단추0$/.test(x)), `[칸] 제목 줄 구성 같음(제목 + 숫자, 단추 없음): ${[...new Set(st.sums.map((x) => x.replace(/#\w+/, '#…')))].join(' | ')}`);
      eq([...new Set(st.look)].length, 1, `[칸] 제목 줄·꺾쇠·여백·글자 크기가 모든 칸에서 같음: ${st.look[0]}`);
      ok(await page.locator('#glanceSum').isVisible() && !(await page.locator('#glanceSum').evaluate((e) => !!e.closest('details'))), '[칸] 요약 타일은 칸 밖에서 늘 보임');
      eq(await openIds(), ['glanceCard'], '[칸] 처음 들어오면 한눈에 보기만 펼침');

      // 접힌 칸의 제목 줄 숫자("N/M명 …" 꼴)
      const WANT = {
        glanceCount: /^29명 · 머리글을 누르면 줄 세우기$/, planCount: /^2일 · 일정 3개 · 참가자 화면에도 보여요$/, carCount: /^6\/29명 정해짐$/,
        menuCount: /^12\/29명 고름 · 우거지 해장국 4 · 소고기 미역국 4 · 버섯 황태 해장국 4$/, lunchCount: /^8\/29명 고름 · 일반 설렁탕 4 · 얼큰 설렁탕 4$/,
        actCount: /^6\/29명 고름 · 스키 3 · 휴식 3$/, roomCount: /^10\/29명 배정 · 남자 5실 · 여자 2실$/, teamCount: /^12\/29명 뽑음$/, scoreCount: /^빨강 0 · 파랑 0 · 노랑 0 · 초록 0$/, totalCount: /^총 29명$/,
        resetCount: /^12\/29명 기록 있음 · 뽑거나 고른 결과 비우기$/,
      };
      for (const [id, re] of Object.entries(WANT)) {
        const el = page.locator(`#${id}`);
        const t = (await el.textContent()).trim();
        ok(re.test(t) && await el.isVisible(), `[제목 줄 숫자] #${id}${id === 'glanceCount' ? '' : '(접힌 채 보임)'}: ${t}`);
      }

      // 열고 닫은 상태를 이 브라우저에 기억 → 새로 고침 뒤에도 그대로
      await page.locator('#glanceCard > summary').click();
      await page.locator('#lunchCard > summary').click();
      await page.locator('#admin > summary').click();
      await page.waitForTimeout(100);
      eq(await openIds(), ['lunchCard', 'admin'], '[열림 기억] 한눈에 보기 접고 점심·명단 관리 폄');
      const saved = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), OPEN_KEY));
      ok(saved.glanceCard === false && saved.lunchCard === true && saved.admin === true, `[열림 기억] 저장 키 ${OPEN_KEY}: ${JSON.stringify(saved)}`);
      await page.reload();
      await page.locator('#glanceBody tr').nth(28).waitFor({ state: 'attached', timeout: 10000 });
      await page.waitForTimeout(300);
      eq(await openIds(), ['lunchCard', 'admin'], '[열림 기억] 새로 고침 뒤에도 그대로');

      // 5초 새로고침: 열린 칸·입력하던 값·초점이 그대로이고, 접힌 칸의 제목 줄 숫자는 바뀜
      await openCard(page, 'teamCard');
      await openCard(page, 'planCard');
      await page.locator('#planEditBtn').click();
      await page.locator('#planInput').fill('적던 일정 10:00 출발');
      await page.locator('#q').fill('견본');
      await page.locator('#quickInput').fill('견본늦, 시험영업부');
      await page.locator('#rosterInput').fill('견본새, 시험영업부');
      const openBefore = await openIds();
      const c0 = server.calls.length;
      await db.query("update public.people set activity = 'ski' where id = 20");
      await db.query("update public.people set car = 'car1', car_at = now() where id = 21");
      await page.waitForFunction(() => /^7\/29명 고름/.test(document.querySelector('#actCount').textContent) && /^7\/29명 정해짐/.test(document.querySelector('#carCount').textContent), null, { timeout: 15000 });
      await page.waitForTimeout(5500); // 한 번 더 돌게
      ok(server.calls.slice(c0).filter((c) => c.fn === 'board_state').length >= 2 && server.calls.slice(c0).filter((c) => c.fn === 'board_cars').length >= 2, '[5초] 그사이 자동 새로고침이 돌았음(board_state·board_cars)');
      eq(await page.evaluate(() => [document.getElementById('actCard').open, document.getElementById('carCard').open]), [false, false], '[5초] 자유시간·탑승 차량 칸은 접힌 채로 제목 줄 숫자만 바뀜(7/29명)');
      ok(/자유시간 7\/29/.test(await page.locator('#glanceSum').innerText()) && /차량 7\/29/.test((await page.locator('#glanceSum').innerText()).replace(/\s+/g, ' ')), '[5초] 맨 위 타일도 바뀜(자유시간·차량 7/29)');
      eq(await openIds(), openBefore, '[5초] 열어 둔 칸이 그대로');
      eq(await page.evaluate(() => ['#planInput', '#q', '#quickInput', '#rosterInput'].map((s) => document.querySelector(s).value).concat(document.activeElement.id, String(document.getElementById('planEdit').hidden))),
        ['적던 일정 10:00 출발', '견본', '견본늦, 시험영업부', '견본새, 시험영업부', 'rosterInput', 'false'], '[5초] 입력하던 값·초점·일정 고치기 상자가 그대로');
      await page.locator('#planCancel').click();
      await page.locator('#q').fill('');
      await page.locator('#quickInput').fill('');
      await page.locator('#rosterInput').fill('');

      // 각 칸을 접었다 편 뒤에도 기능이 그대로
      const reopen = async (id) => { await openCard(page, id); await page.locator(`#${id} > summary`).click(); await page.locator(`#${id} > summary`).click(); eq(await page.locator(`#${id}`).evaluate((d) => d.open), true, `[접고 편 뒤] #${id} 다시 펼침`); };
      await reopen('glanceCard');
      await page.locator('.glance th button[data-gsort="name"]').click();
      eq(await page.locator('.glance th[aria-sort] button').innerText(), '이름', '[접고 편 뒤·한눈에 보기] 머리글 눌러 줄 세우기');
      await reopen('planCard');
      await page.locator('#planEditBtn').click();
      ok(await page.locator('#planInput').isVisible(), '[접고 편 뒤·일정표] 일정 고치기 열림');
      await page.locator('#planCancel').click();
      await reopen('carCard');
      await page.locator('#carMove').check();
      ok(await page.locator('#carView select.car-sel').count() > 0, '[접고 편 뒤·탑승 차량] 직접 옮기기 → 고르는 칸');
      await page.locator('#carMove').uncheck();
      await page.locator('#carEditBtn').click();
      ok(await page.locator('#carEdit').isVisible() && await page.locator('#carEditRows .car-row').count() === 2, '[접고 편 뒤·탑승 차량] 차량 목록 고치기 열림');
      await page.locator('#carCancel').click();
      await page.locator('#carCopy').click();
      await page.waitForFunction(() => /1호차/.test(document.querySelector('#carCopyBox').value), null, { timeout: 5000 });
      ok(true, '[접고 편 뒤·탑승 차량] 차량별 탑승자 복사');
      await reopen('menuCard');
      await page.locator('#menuCopy').click();
      await page.waitForFunction(() => document.querySelector('#menuCopyBox').value.startsWith('12/18(금) 조식: '), null, { timeout: 5000 });
      ok(true, '[접고 편 뒤·아침 메뉴] 복사(칸 안 아래쪽 단추)');
      await reopen('lunchCard');
      await page.locator('#lunchMove').check();
      ok(await page.locator('#lunches select.seat').count() === 29, '[접고 편 뒤·점심] 직접 고치기 → 고르는 칸 29개');
      await page.locator('#lunchMove').uncheck();
      await page.locator('#lunchCopy').click();
      await page.waitForFunction(() => document.querySelector('#lunchCopyBox').value.startsWith('12/18(금) 점심: '), null, { timeout: 5000 });
      ok(true, '[접고 편 뒤·점심] 복사');
      await reopen('actCard');
      await page.locator('#actMove').check();
      ok(await page.locator('#acts select.seat').count() === 29, '[접고 편 뒤·자유시간] 직접 고치기 → 고르는 칸 29개');
      await page.locator('#actMove').uncheck();
      await reopen('roomCard');
      await page.locator('#roomMove').check();
      ok(await page.locator('#rooms select.seat, #roomless select.seat').count() === 29, '[접고 편 뒤·객실표] 직접 옮기기 → 고르는 칸 29개');
      await page.locator('#roomMove').uncheck();
      seen.length = 0;
      await page.locator('#roomAuto').click();
      await waitDialogs(page, seen);
      ok(seen.length === 1 && /^방 전부 새로 섞기: 지금 \d+명의 방 기록/.test(seen[0].msg), '[접고 편 뒤·객실표] 방 전부 새로 섞기 → 확인(취소)');
      await reopen('teamCard');
      await clickWho(page);
      ok(await page.locator('#sheet').isVisible() && /팀 대신 정하기/.test(await page.locator('#sheet').innerText()), '[접고 편 뒤·팀] 이름 누르기 메뉴');
      await page.keyboard.press('Escape');
      await reopen('admin');
      await facetBtn(page, '점심', '안 고름').click();
      eq(await page.locator('#peopleBody tr').count(), 21, '[접고 편 뒤·명단 관리] 분류 단추');
      await page.locator('#clearView').click();
      await page.locator('#peopleBody [data-edit]').first().click();
      ok(await page.locator('#peopleBody tr.editing input[name="name"]').isVisible(), '[접고 편 뒤·명단 관리] 수정 줄 열림');
      await page.keyboard.press('Escape');
      await reopen('resetCard');
      seen.length = 0;
      await page.locator('#resetTeam').click();
      await page.waitForFunction(() => !document.querySelector('#resetCard button:disabled'), null, { timeout: 15000 });
      await page.waitForTimeout(300);
      ok(seen.length === 1 && /^팀 초기화: 팀 12명/.test(seen[0].msg), `[접고 편 뒤·초기화] 팀 초기화 → 확인(취소): ${seen[0] && seen[0].msg.split('\n')[0]}`);
      eq((await people()).filter((p) => p.team).length, 12, '[접고 편 뒤] 취소한 것들은 DB 그대로(팀 12명)');
      // 명단 표의 수정 → 접힌 명단 관리를 펴고 그 줄로(이름 메뉴의 수정)
      await page.locator('#admin > summary').click();
      eq(await page.locator('#admin').evaluate((d) => d.open), false, '[명단 관리] 접음');
      await clickWho(page);
      await page.locator('#sheet [data-sa="edit"]').click();
      ok(await page.locator('#admin').evaluate((d) => d.open) && await page.locator('#peopleBody tr.editing input[name="name"]').isVisible(), '[명단 관리] 이름 메뉴의 수정이 접힌 명단 관리를 펴고 수정 줄을 엶');
      await page.keyboard.press('Escape');
      await page.close();
    }

    // ── 10. 저장소(localStorage)가 막혀 있어도 오류 없이 동작(기억만 못 함) ──
    {
      const ctx = await env.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
      const g = await guardNetwork(ctx, server.url);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('시험: 저장소 막힘', 'SecurityError'); } }); });
      await page.goto(`${server.url}/board.html`);
      await page.locator('#code').fill(ADMIN_CODE);
      await page.locator('#codeForm button[type=submit]').click();
      await page.locator('#glanceBody tr').nth(28).waitFor({ timeout: 10000 });
      eq(await page.evaluate(() => [...document.querySelectorAll('#boardView > details.card')].filter((d) => d.open).map((d) => d.id)), ['glanceCard'], '[저장소 막힘] 처음 상태(한눈에 보기만 펼침)로 열림');
      await page.locator('#carCard > summary').click();
      await page.locator('#glanceCard > summary').click();
      await page.waitForFunction(() => /정해짐/.test(document.querySelector('#carCount').textContent), null, { timeout: 15000 });
      eq(await page.evaluate(() => [document.getElementById('carCard').open, document.getElementById('glanceCard').open]), [true, false], '[저장소 막힘] 접고 펴기는 그대로 됨');
      ok(await page.locator('#carView .room').count() >= 2, '[저장소 막힘] 탑승 차량 칸 내용도 그려짐');
      g.assertClean();
      await ctx.close();
    }

    // ── 11. 마감 안내: 마감 전(지금 문구) · 마감 뒤(마감됐어요) · 화면을 열어 둔 채 마감을 넘기면 저절로 바뀜 ──
    {
      await fill();
      const textOf = async (page, sel) => (await page.locator(sel).textContent()).replace(/\s+/g, ' ').trim();
      const how = (t) => t.match(/\(방법: (.+)\)$/)[1];
      // 마감 전: 지금과 같은 모양, 탑승 차량 칸의 마감 전 문장
      const before = await openBoard({ fixed: T_BEFORE });
      let hows = {};
      for (const [name, sel, key] of DEADLINE_SPEC) {
        const t = await textOf(before.page, sel);
        ok(DEADLINE_RE.test(t) && !t.includes('마감됐어요'), `[마감 전·${name}] ${t}`);
        hows[sel] = how(t);
        ok(how(t).includes(key), `[마감 전·${name}] 방법에 "${key}"`);
      }
      const noteBefore = await textOf(before.page, '#carNote');
      ok(/마감 전에는 차량을 비우면 그 사람이 다시 뽑을 수 있어요\.$/.test(noteBefore) && !/마감이 지나/.test(noteBefore), `[마감 전·탑승 차량] 안내: ${noteBefore}`);
      await before.page.close();

      // 마감 뒤: 네 칸 모두 "마감됐어요(11/25(수) 15시). 지금은 여기서만 바꿀 수 있어요. (방법: …)" — 방법은 마감 전과 같고, "참가자는 …까지"는 없음
      const after = await openBoard({ fixed: T_AFTER });
      for (const [name, sel, key] of DEADLINE_SPEC) {
        const t = await textOf(after.page, sel);
        ok(CLOSED_RE.test(t) && !t.includes('참가자는') && !t.includes('까지'), `[마감 뒤·${name}] ${t}`);
        eq(how(t), hows[sel], `[마감 뒤·${name}] 방법은 마감 전과 같음`);
        ok(await after.page.evaluate(([s, h]) => document.querySelector(h).nextElementSibling === document.querySelector(s), [sel, sel.replace('Deadline', 'Card') + ' > summary']), `[마감 뒤·${name}] 제목 바로 아래(같은 틀)`);
      }
      const noteAfter = await textOf(after.page, '#carNote');
      ok(/참가자는 다시 뽑을 수 없어서 진행자가 직접 넣어요\.$/.test(noteAfter) && !/마감 전에는|다시 뽑을 수 있어요/.test(noteAfter), `[마감 뒤·탑승 차량] 마감 전 전용 문장이 바뀜: ${noteAfter}`);
      ok(/운전자는 뽑지 않고/.test(noteAfter) && /반씩/.test(noteAfter), '[마감 뒤·탑승 차량] 앞의 핵심 안내(운전자 고정·반씩)는 그대로');
      eq(await after.page.locator('#carCard > p.hint-line').count(), 2, '[마감 뒤·탑승 차량] 안내는 여전히 두 문단');
      await after.page.close();

      // 열어 둔 채 마감을 넘김: 칸을 펴고 입력하던 값을 둔 채 시계를 마감 뒤로 건너뛰면 저절로 바뀌고, 칸·입력은 그대로
      const live = await openBoard({ install: T_BEFORE });
      const p = live.page;
      for (const [, sel] of DEADLINE_SPEC) ok(DEADLINE_RE.test(await textOf(p, sel)), `[마감 넘김] 넘기기 전 ${sel}은 마감 전 문구`);
      await openCard(p, 'carCard');
      await openCard(p, 'lunchCard');
      await openCard(p, 'teamCard');
      await p.locator('#quickInput').fill('적던 이름, 시험영업부');
      await p.locator('#lunchMove').check();
      const openBefore = await p.evaluate(() => [...document.querySelectorAll('#boardView > details.card')].filter((d) => d.open).map((d) => d.id));
      await p.clock.fastForward(61 * 60 * 1000); // 14:00 → 15:01
      await p.waitForFunction(() => /^마감됐어요/.test(document.querySelector('#menuDeadline').textContent.trim()), null, { timeout: 5000 });
      for (const [name, sel] of DEADLINE_SPEC) ok(CLOSED_RE.test(await textOf(p, sel)), `[마감 넘김] 화면을 연 채 마감을 넘기면 ${name} 안내가 바뀜: ${await textOf(p, sel)}`);
      ok(/참가자는 다시 뽑을 수 없어서 진행자가 직접 넣어요\.$/.test(await textOf(p, '#carNote')), '[마감 넘김] 탑승 차량의 마감 전 전용 문장도 바뀜');
      eq(await p.evaluate(() => [...document.querySelectorAll('#boardView > details.card')].filter((d) => d.open).map((d) => d.id)), openBefore, '[마감 넘김] 열어 둔 칸이 그대로(열림 상태가 풀리지 않음)');
      eq(await p.evaluate(() => [document.querySelector('#quickInput').value, document.querySelector('#lunchMove').checked]), ['적던 이름, 시험영업부', true], '[마감 넘김] 입력하던 값·체크도 그대로');
      await p.close();
    }

    // ── 12. 자유시간 복사 단추: 칸 안 아래 도구 줄, 복사 글에 스키·휴식 명단과 안 고른 사람 ──
    {
      await fill();
      const { page } = await openBoard();
      await openCard(page, 'actCard');
      eq(await page.locator('#actCard > summary button, #actCard > summary a').count(), 0, '[자유시간 복사] 제목 줄 안에는 단추가 없음');
      ok(await page.evaluate(() => { const b = document.querySelector('#actCopy'); const row = b.closest('.tools2'); return !!row && row.parentNode.id === 'actCard' && b.textContent.trim() === '복사' && getComputedStyle(b).marginLeft !== '0px' && row.contains(document.querySelector('#actMove')) && row.compareDocumentPosition(document.querySelector('#acts')) & Node.DOCUMENT_POSITION_PRECEDING; }), '[자유시간 복사] 복사 단추가 점심 칸처럼 칸 안 아래 도구 줄(직접 고치기 옆, 오른쪽 끝)에 있음');
      const acts = (await db.query('select name, activity from public.people order by id')).rows;
      const nameSet = (f) => acts.filter(f).map((r) => r.name).sort();
      await page.locator('#actCopy').click();
      await page.waitForFunction(() => document.querySelector('#actCopyBox').value, null, { timeout: 5000 });
      const text = await page.locator('#actCopyBox').inputValue();
      const lines = text.split('\n');
      eq(lines[0], '12/18(금) 저녁 자유시간: 스키 3 · 휴식 3 (아직 안 고름 23) / 총 29명', '[자유시간 복사] 첫 줄은 아침 메뉴·점심 복사와 같은 인원 한 줄');
      eq(lines.length, 4, '[자유시간 복사] 줄 수: 인원 한 줄 + 스키 + 휴식 + 아직 안 고름');
      const listOf = (line, head) => { assert.ok(line.startsWith(head), `${head} 줄: ${line}`); return line.slice(head.length).split(', ').sort(); };
      eq(listOf(lines[1], '스키(3): '), nameSet((r) => r.activity === 'ski'), '[자유시간 복사] 스키 명단(이름 그대로)');
      eq(listOf(lines[2], '휴식(3): '), nameSet((r) => r.activity === 'rest'), '[자유시간 복사] 휴식 명단');
      eq(listOf(lines[3], '아직 안 고름(23): '), nameSet((r) => !r.activity), '[자유시간 복사] 안 고른 사람 명단');
      ok(await page.locator('#actCopyBox').isVisible() || /복사했어요/.test(await page.locator('#actCopyMsg').innerText()), '[자유시간 복사] 복사됐다고 알리거나(클립보드) 직접 복사할 상자를 보임');
      // 클립보드 허용: 복사된 글이 위 글 그대로, 안내줄에는 첫 줄만
      await env.context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.locator('#actCopy').click();
      await page.waitForFunction(() => /^복사했어요/.test(document.querySelector('#actCopyMsg').textContent), null, { timeout: 5000 });
      eq(await page.evaluate(() => navigator.clipboard.readText()), text, '[자유시간 복사] 클립보드에 복사된 글이 같음');
      ok(/^복사했어요: 12\/18\(금\) 저녁 자유시간: .+ 총 29명 …/.test(await page.locator('#actCopyMsg').innerText()) && !(await page.locator('#actCopyBox').isVisible()), '[자유시간 복사] 안내줄은 첫 줄만 보임·상자는 숨김');
      // 클립보드가 막히면 직접 복사할 상자(다른 칸의 복사와 같은 방식)
      await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('시험: 막힘')) }); });
      await page.locator('#actCopy').click();
      await page.waitForFunction(() => !document.querySelector('#actCopyBox').hidden, null, { timeout: 5000 });
      eq(await page.locator('#actCopyBox').inputValue(), text, '[자유시간 복사] 클립보드가 막히면 같은 글을 직접 복사할 상자로 보여 줌');
      // 다른 칸의 복사와 섞이지 않음
      eq([await page.locator('#menuCopyBox').inputValue(), await page.locator('#lunchCopyBox').inputValue()].some((v) => v.includes('자유시간')), false, '[자유시간 복사] 아침 메뉴·점심 복사 상자와 섞이지 않음');
      await page.close();
    }

    // ── 13. 휴대폰(390px) 정리: 누르는 자리 40px 이상 · 한눈에 보기 표가 옆으로 안 밀림(모든 열) · 넓은 화면 모양은 그대로 ──
    {
      await fill();
      const { page } = await openBoard({ width: 390, answer: (d) => (d.type() === 'prompt' ? '삭제' : false) });
      await page.waitForFunction(() => document.querySelector('#facets .facet[aria-label="차량"]'), null, { timeout: 15000 });
      for (const id of ['glanceCard', 'carCard', 'menuCard', 'lunchCard', 'actCard', 'teamCard', 'scoreCard', 'admin', 'resetCard']) await openCard(page, id);
      await page.waitForTimeout(300);
      // 한눈에 보기 표: 8열이 모두 화면 안에 보이고, 표 칸 안에서도 옆으로 밀 필요가 없음(페이지 전체도 안 넘침)
      const g = await page.evaluate(() => {
        const w = document.querySelector('.glance-wrap'), ths = [...document.querySelectorAll('.glance thead th')].map((t) => t.getBoundingClientRect());
        return { sw: w.scrollWidth, cw: w.clientWidth, cols: ths.length, minL: Math.min(...ths.map((r) => r.left)), maxR: Math.max(...ths.map((r) => r.right)), doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth], names: [...document.querySelectorAll('.glance thead th')].map((t) => t.textContent.trim()), tds: document.querySelectorAll('#glanceBody tr:first-child td').length };
      });
      ok(g.sw <= g.cw, `[390px·한눈에 보기] 표가 옆으로 밀리지 않음(${g.sw} ≤ ${g.cw})`);
      ok(g.cols === 8 && g.tds === 8 && g.minL >= 0 && g.maxR <= 390, `[390px·한눈에 보기] 열 8개가 모두 화면 안(${Math.round(g.minL)}~${Math.round(g.maxR)}px)`);
      eq(g.names, ['부서', '이름', '차량', '아침 메뉴', '점심', '자유시간', '방', '팀'], '[390px·한눈에 보기] 열 머리글은 그대로(없앤 열 없음)');
      ok(g.doc[0] <= g.doc[1], `[390px] 페이지 전체도 가로로 안 넘침(${g.doc[0]} ≤ ${g.doc[1]})`);
      const row = await page.locator('#glanceBody tr').filter({ hasText: '견본마' }).locator('td').allInnerTexts();
      eq(row.map((x) => x.replace(/\s+/g, ' ').trim()), ['시험관리부', '견본마', '2호차', '버섯 황태 해장국', '얼큰 설렁탕', '휴식', '남자 1호실', '빨강'], '[390px·한눈에 보기] 줄바꿈이 돼도 칸의 글은 그대로');
      // 누르는 자리: 분류 단추·작은 단추·링크 단추·머리글 단추 높이 40px 이상
      const h = (sel) => page.locator(sel).evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10));
      for (const [name, sel] of [['분류 단추', '#facets .chip.pick'], ['작은 단추(복사·고치기)', '#carCopy, #carEditBtn, #lunchCopy, #actCopy, #menuCopy, #planEditBtn'], ['초기화 단추', '#resetCard button.sm'], ['발표용 링크', '#drawLink, #drawLinkTeam, #scoreLink'], ['한눈에 보기 머리글', '.glance th button'], ['명단 표 머리글', '.people th button'], ['프로젝터 보기 단추', '#tvBtn'], ['표 안 수정·삭제', '#peopleBody tr:first-child button']]) {
        const hs = await h(sel);
        ok(hs.length > 0 && hs.every((x) => x >= 39.5), `[390px·누르는 자리] ${name} 높이 40px 이상: ${[...new Set(hs)].join(', ')}`);
      }
      // 칸 안 도구 줄·확인 상자: 화면 안에서 깨지지 않음
      const rowsOk = await page.evaluate(() => [...document.querySelectorAll('.tools2, .tools, .quick, .draw-ref')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => { const r = e.getBoundingClientRect(), kids = [...e.children].filter((c) => c.getBoundingClientRect().height > 0).map((c) => c.getBoundingClientRect()); return kids.some((k) => k.left < r.left - 1 || k.right > innerWidth + 1) ? (e.id || e.className) : ''; }).filter(Boolean));
      eq(rowsOk, [], '[390px] 칸 안 도구 단추 줄의 단추가 화면 밖으로 나가지 않음');
      await page.locator('#removeAll').scrollIntoViewIfNeeded();
      await page.locator('#removeAll').click();
      await page.locator('#backupBox').waitFor({ state: 'visible' });
      const bx = await page.evaluate(() => { const b = document.querySelector('#backupBox .box').getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, btn: [...document.querySelectorAll('#backupBox .acts button')].map((x) => [Math.round(x.getBoundingClientRect().height), x.getBoundingClientRect().right <= innerWidth]), doc: document.documentElement.scrollWidth }; });
      ok(bx.l >= 0 && bx.r <= 390 && bx.doc <= 390 && bx.btn.every(([hh, inside]) => hh >= 40 && inside), `[390px·확인 상자] 백업 확인 상자가 화면 안(${Math.round(bx.l)}~${Math.round(bx.r)}px), 단추 높이 ${bx.btn.map((x) => x[0]).join('·')}px`);
      await page.locator('#bkNo').click();
      // 이름 메뉴(화면 아래 판)
      await clickWho(page);
      const sh = await page.evaluate(() => { const b = document.querySelector('#sheet').getBoundingClientRect(); return { l: b.left, r: b.right, btn: [...document.querySelectorAll('#sheet button')].map((x) => Math.round(x.getBoundingClientRect().height)) }; });
      ok(sh.l >= 0 && sh.r <= 390 && sh.btn.every((x) => x >= 40), `[390px·이름 메뉴] 화면 안, 단추 높이 ${sh.btn.join('·')}px`);
      await page.keyboard.press('Escape');
      await page.locator('#glanceCard').scrollIntoViewIfNeeded();
      // 넓은 화면(1280px) 모양은 그대로: 누르는 자리를 키우는 규칙이 700px 이하에서만 적용됨
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(200);
      const wide = await page.evaluate(() => ({
        chip: Math.round(document.querySelector('#facets .chip.pick').getBoundingClientRect().height), sm: Math.round(document.querySelector('#carCopy').getBoundingClientRect().height),
        glanceFont: getComputedStyle(document.querySelector('.glance td')).fontSize, glanceWrap: getComputedStyle(document.querySelector('.glance td')).whiteSpace, thBtn: Math.round(document.querySelector('.glance th button').getBoundingClientRect().height),
        wrapMargin: getComputedStyle(document.querySelector('.glance-wrap')).marginLeft, cw: [document.querySelector('.glance-wrap').scrollWidth, document.querySelector('.glance-wrap').clientWidth],
      }));
      ok(wide.chip < 36 && wide.sm === 36, `[1280px·그대로] 분류 단추 ${wide.chip}px(40 미만) · 작은 단추 ${wide.sm}px`);
      eq([wide.glanceFont, wide.glanceWrap, wide.wrapMargin, wide.cw[0] <= wide.cw[1], wide.thBtn < 30], ['14px', 'nowrap', '0px', true, true], '[1280px·그대로] 한눈에 보기 표는 14px · 줄바꿈 없음 · 여백 그대로');
      await page.close();
    }

    // ── 14. 늦게 온 사람 빠른 추가: 오류는 맨 위 #error 가 아니라 입력칸 아래 #quickMsg 에 보임 ──
    {
      await fill();
      const { page } = await openBoard({ width: 390 });
      await openCard(page, 'teamCard');
      await page.locator('#quickInput').fill('견본가, 시험영업부'); // 이미 있는 사람
      await page.locator('#quickBtn').click();
      await page.waitForFunction(() => document.querySelector('#quickMsg').textContent, null, { timeout: 5000 });
      eq((await page.locator('#quickMsg').innerText()).trim(), '시험영업부의 견본가 님은 이미 명단에 있어요.', '[빠른 추가·오류] 같은 이름·부서 오류가 입력칸 아래 안내줄에 나옴');
      eq(await page.locator('#error').innerText(), '', '[빠른 추가·오류] 맨 위 #error 에는 안 나옴');
      ok(await page.locator('#quickMsg').isVisible() && await page.locator('#quickMsg').evaluate((e) => e.classList.contains('err') && getComputedStyle(e).color === getComputedStyle(document.querySelector('.error')).color), '[빠른 추가·오류] 안내줄이 보이고 오류 색(빨강)');
      eq(await page.locator('#quickInput').inputValue(), '견본가, 시험영업부', '[빠른 추가·오류] 입력칸은 그대로 둠');
      await page.locator('#quickInput').fill('이름만');
      await page.locator('#quickBtn').click();
      await page.waitForFunction(() => /이름, 부서 순서/.test(document.querySelector('#quickMsg').textContent), null, { timeout: 5000 });
      eq(await page.locator('#error').innerText(), '', '[빠른 추가·오류] 형식 오류도 #quickMsg(#error 는 비어 있음)');
      // 성공하면 같은 자리에 성공 문구(빨강 아님)
      await page.locator('#quickInput').fill('견본신, 시험영업부');
      await page.locator('#quickBtn').click();
      await page.waitForFunction(() => /추가했어요/.test(document.querySelector('#quickMsg').textContent), null, { timeout: 5000 });
      ok(!(await page.locator('#quickMsg').evaluate((e) => e.classList.contains('err'))) && (await people()).length === 30, '[빠른 추가·성공] 추가되고 성공 문구는 오류 색이 아님');
      eq(await page.locator('#error').innerText(), '', '[빠른 추가·성공] #error 는 비어 있음');
      await page.close();
      await fill(); // 시험용으로 넣은 사람 정리
    }

    // ── 15. 프로젝터 보기에서는 차량 자료 받기(board_cars)를 쉬고, 관리자 페이지로 돌아오면 곧바로 받음 ──
    {
      await fill();
      const calls = (fn, from) => server.calls.slice(from).filter((c) => c.fn === fn).length;
      const c0 = server.calls.length;
      const { page } = await openBoard({ url: '?tv=1' });
      await page.locator('#columns .col').first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(7000); // 5초 새로고침이 한 번 이상, 차량 첫 받기(0.8초 뒤)도 지나는 시간
      ok(calls('board_state', c0) >= 1, `[프로젝터·차량] 그사이 5초 새로고침은 돌았음(board_state ${calls('board_state', c0)}번)`);
      eq(calls('board_cars', c0), 0, '[프로젝터·차량] 프로젝터 보기에서는 board_cars 를 한 번도 안 받음');
      const c1 = server.calls.length;
      await page.locator('#tvBtn').click(); // 관리자 페이지로
      await page.waitForFunction(() => !document.body.classList.contains('tv'));
      const t0 = Date.now();
      while (calls('board_cars', c1) === 0 && Date.now() - t0 < 2500) await page.waitForTimeout(100);
      ok(calls('board_cars', c1) >= 1, `[프로젝터·차량] 관리자 페이지로 돌아오면 곧바로(${Date.now() - t0}ms, 5초 기다리지 않고) 차량 자료를 받음`);
      await page.waitForFunction(() => /^차량 6\/29/.test(document.querySelector('#glanceSum').textContent.replace(/\s+/g, ' ')) || /차량 \d+\/29/.test(document.querySelector('#glanceSum').textContent), null, { timeout: 5000 });
      ok(/차량 [^-]/.test((await tiles(page))[0]) && !/^차량 -/.test((await tiles(page))[0]), `[프로젝터·차량] 돌아온 뒤 차량 타일이 채워짐: ${(await tiles(page))[0]}`);
      // 다시 프로젝터 보기로 가면 또 쉼
      await page.locator('#tvBtn').click();
      await page.waitForFunction(() => document.body.classList.contains('tv'));
      const c2 = server.calls.length;
      await page.waitForTimeout(6500);
      eq(calls('board_cars', c2), 0, '[프로젝터·차량] 다시 프로젝터 보기로 가면 또 받지 않음');
      await page.close();
    }

    // ── 16~20. 아침 메뉴·점심·자유시간 세 칸이 같은 구성 + 직접 고치기 토글 + 복사 + 프로젝터 보기(아침 메뉴 예전 모양 그대로) + 390px ──
    const CHOICES = [ // 세 칸의 시험 값. n0 = 견본 명단(--picked)에서 이미 고른 사람 수, to/other = 바꿀 값, stId = 참가자 메인의 상태 줄
      { key: 'menu', card: 'menuCard', list: '#menus', what: 'menu', col: 'menu', head: '12/18(금) 조식', title: '아침 메뉴', n0: 12, to: 'miyeok', toName: '소고기 미역국', other: 'hwangtae', none: '안 고름', opts: ['안 고름', '우거지 해장국', '소고기 미역국', '버섯 황태 해장국'], stId: '#stMenu' },
      { key: 'lunch', card: 'lunchCard', list: '#lunches', what: 'lunch', col: 'lunch', head: '12/18(금) 점심', title: '점심', n0: 8, to: 'spicy', toName: '얼큰 설렁탕', other: 'plain', none: '안 고름', opts: ['안 고름', '일반 설렁탕', '얼큰 설렁탕'], stId: '#stLunch' },
      { key: 'act', card: 'actCard', list: '#acts', what: 'activity', col: 'activity', head: '12/18(금) 저녁 자유시간', title: '자유시간', n0: 6, to: 'ski', toName: '스키', other: 'rest', none: '안 고름', opts: ['안 고름', '스키', '휴식'], stId: '#stAct' },
    ];
    const norm = (t) => t.replace(/\s+/g, ' ').trim();
    const waitCalls = async (fn, from, n, ms = 15000) => { const end = Date.now() + ms; while (server.calls.slice(from).filter((c) => c.fn === fn).length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); };
    const waitDb = async (id, col, want, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = (await db.query(`select ${col} as v from public.people where id = $1`, [id])).rows[0].v; if (v === want) return v; await new Promise((r) => setTimeout(r, 50)); } return v; };

    // ── 16. 세 칸의 구성(요소 순서·id/클래스 대응·도구 줄·이름표 모양)이 같음 ──
    {
      await fill();
      const { page } = await openBoard();
      for (const c of CHOICES) await openCard(page, c.card);
      const sig = await page.evaluate((keys) => Object.fromEntries(keys.map(([card, key]) => {
        const d = document.getElementById(card);
        const tag = (e) => `${e.tagName}${[...e.classList].filter((x) => x !== 'admin-only').sort().map((x) => '.' + x).join('')}`;
        const kids = [...d.children].filter((e) => !e.matches('p.note')); // 자유시간만 있는 술 금지 안내는 따로 확인
        const row = d.querySelector(':scope > .tools2');
        const first = d.querySelector('.menu-group');
        const none = d.querySelector('.menu-group.none');
        const cs = (e, ...ps) => ps.map((p) => getComputedStyle(e)[p]).join(' ');
        return [card, {
          kids: kids.map(tag),
          ids: [':scope > .hint-line', ':scope > p.msg:not(.hint-line)', ':scope > textarea', ':scope > .tools2 input', ':scope > .tools2 button', ':scope > summary .sum-n'].map((q) => d.querySelector(q).id.replace(key, '§')),
          sum: [...d.querySelector(':scope > summary').children].map(tag),
          row: [...row.children].map((e) => `${tag(e)}|${e.textContent.trim()}|${e.querySelector('input') ? e.querySelector('input').type : ''}`),
          groupKids: [...first.children].map(tag), chipTag: tag(first.querySelector('.chip')), chipKids: [...first.querySelector('.chip').children].map(tag),
          noneTitle: none ? none.querySelector('p').textContent.replace(/\d+/, 'N').trim() : '',
          noneLast: !!none && d.querySelector(':scope > div:not(.row) > .menu-group:last-child') === none,
          titleShape: [...d.querySelectorAll('.menu-group > p')].map((p) => p.textContent.replace(/\d+명/, 'N명').trim()),
          look: [cs(d.querySelector(':scope > .hint-line'), 'fontSize', 'color', 'marginTop', 'marginBottom'), cs(row, 'marginTop', 'paddingTop', 'borderTopWidth', 'columnGap', 'rowGap', 'display'),
            cs(row.querySelector('label'), 'fontSize', 'color', 'display'), cs(row.querySelector('button'), 'height', 'fontSize', 'paddingTop', 'borderTopWidth', 'borderRadius'),
            cs(first.querySelector('p'), 'fontSize', 'fontWeight'), cs(first.querySelector('.chip'), 'fontSize', 'borderRadius', 'paddingTop')].join(' | '),
          pos: [d.querySelector(':scope > summary').nextElementSibling.id.replace(key, '§'), d.querySelector(':scope > .hint-line').compareDocumentPosition(d.querySelector(':scope > div')) & Node.DOCUMENT_POSITION_FOLLOWING ? 'deadline→list' : '?',
            row.compareDocumentPosition(d.querySelector(':scope > p.msg:not(.hint-line)')) & Node.DOCUMENT_POSITION_FOLLOWING ? 'row→msg' : '?',
            d.querySelector(':scope > p.msg:not(.hint-line)').nextElementSibling.tagName, d.querySelector(`.copybox`).hidden],
          copyBtnRight: Math.round(row.getBoundingClientRect().right - row.querySelector('button').getBoundingClientRect().right),
          count: d.querySelector(':scope > summary .sum-n').textContent.trim().replace(/\d+/g, 'N'),
        }];
      })), CHOICES.map((c) => [c.card, c.key]));
      const [m, l, a] = CHOICES.map((c) => sig[c.card]);
      for (const [name, x] of [['점심', l], ['자유시간', a]]) {
        for (const f of ['kids', 'ids', 'sum', 'row', 'groupKids', 'chipTag', 'chipKids', 'noneTitle', 'noneLast', 'pos', 'copyBtnRight']) eq(x[f], m[f], `[칸 구성] 아침 메뉴와 ${name}의 ${f}가 같음`);
        eq(x.look, m.look, `[칸 구성] 아침 메뉴와 ${name}의 글자 크기·색·여백·도구 줄·이름표 모양이 같음`);
      }
      eq(m.kids, ['SUMMARY', 'P.hint-line.msg', 'DIV', 'DIV.row.tools2', 'P.msg', 'TEXTAREA.copybox'], '[칸 구성] 위에서 아래: 제목 줄 → 마감 안내 → 목록 → 도구 줄 → 안내줄 → 복사 상자');
      eq(m.row, ['LABEL.check|직접 고치기|checkbox', 'BUTTON.push.sm|복사|'], '[칸 구성] 도구 줄: 왼쪽 직접 고치기 토글, 오른쪽 끝 복사 단추');
      eq(m.ids, ['§Deadline', '§CopyMsg', '§CopyBox', '§Move', '§Copy', '§Count'], '[칸 구성] id 이름 짝: ○Deadline · ○CopyMsg · ○CopyBox · ○Move · ○Copy · ○Count');
      ok([m, l, a].every((x) => /^N\/N명 고름 · .+ N$/.test(x.count)), `[칸 구성] 제목 줄 숫자 같은 꼴 "N/N명 고름 · 항목별 인원": ${m.count} / ${l.count} / ${a.count}`);
      eq([l.count, a.count].map((x) => x.split(' · ')[0]), [m.count.split(' · ')[0], m.count.split(' · ')[0]], '[칸 구성] 제목 줄 숫자 앞부분 "N/N명 고름"이 같음');
      ok(m.titleShape.every((t) => /^.+ N명$/.test(t)) && l.titleShape.at(-1) === '아직 안 고른 사람 N명' && m.titleShape.at(-1) === '아직 안 고른 사람 N명' && a.titleShape.at(-1) === '아직 안 고른 사람 N명', `[칸 구성] 묶음 제목 "이름 N명"과 맨 끝 "아직 안 고른 사람": ${m.titleShape.join(' / ')}`);
      eq([m.pos[0], l.pos[0], a.pos[0]], ['§Deadline', '§Deadline', '§Deadline'], '[칸 구성] 마감 안내가 제목 줄 바로 아래');
      eq(await page.locator('#actDeadline + p.note').count(), 1, '[칸 구성] 자유시간만 마감 안내 아래에 스키 술 금지 안내가 더 있음(그대로)');
      eq(await page.locator('#menuCard > p.note, #lunchCard > p.note').count(), 0, '[칸 구성] 아침 메뉴·점심에는 그 안내가 없음');
      // 아침 메뉴 칸 안 관리용 요소는 모두 admin-only(프로젝터 보기에서 숨김)
      eq(await page.evaluate(() => ['#menuDeadline', '#menuCard > .tools2', '#menuMove', '#menuCopy', '#menuCopyMsg', '#menuCopyBox'].map((s) => !!document.querySelector(s).closest('.admin-only'))), [true, true, true, true, true, true], '[칸 구성] 아침 메뉴 칸의 마감 안내·도구 줄·직접 고치기·복사·안내줄·복사 상자는 admin-only(프로젝터 보기에서 숨김)');
      // 이름표: 세 칸 모두 "이름 직급 · 부서", 직급 높은 순(견본가=대표이사가 앞, 견본다=이사)
      for (const c of CHOICES) {
        const chip = norm(await page.locator(`${c.list} .chip`).filter({ hasText: '견본가' }).first().innerText());
        eq(chip, '견본가 대표이사 · 시험영업부', `[칸 구성·${c.title}] 이름표는 이름 직급 · 부서`);
      }
      eq(await page.locator('#menus .menu-group').nth(0).locator('.chip').first().innerText().then(norm), '견본다 이사 · 시험생산부', '[칸 구성·아침 메뉴] 한 묶음 안은 직급 높은 순(점심·자유시간과 같음)');
      eq(await page.locator('#menus .menu-group > p').allInnerTexts().then((a) => a.map(norm)), ['우거지 해장국 4명', '소고기 미역국 4명', '버섯 황태 해장국 4명', '아직 안 고른 사람 17명'], '[칸 구성·아침 메뉴] 묶음: 메뉴 3개 + 아직 안 고른 사람');
      await page.close();
    }

    // ── 17. 직접 고치기 토글(세 칸 같음): 꺼짐 기본 → 켜면 고르는 칸 → 바꾸면 admin_assign 한 번 → 비우기 → 마감 뒤 → 참가자 화면 → 실패 되돌림 → 5초 새로고침 ──
    for (const c of CHOICES) {
      await fill();
      const base = (await db.query(`select id, ${c.col} as v from public.people order by id`)).rows;
      const { page } = await openBoard();
      await openCard(page, c.card);
      const sel = (id) => page.locator(`${c.list} select.seat[data-id="${id}"]`);
      eq([await page.locator(`#${c.key}Move`).isChecked(), await page.locator(`${c.list} select.seat`).count()], [false, 0], `[직접 고치기·${c.title}] 처음엔 꺼짐 — 고르는 칸 없음(보기만)`);
      await page.locator(`#${c.key}Move`).check();
      eq(await page.locator(`${c.list} select.seat`).count(), 29, `[직접 고치기·${c.title}] 켜면 사람마다 고르는 칸 29개`);
      eq(await sel(20).locator('option').allInnerTexts(), c.opts, `[직접 고치기·${c.title}] 고르는 칸 항목: ${c.opts.join('·')}`);
      eq(await sel(20).inputValue(), '', `[직접 고치기·${c.title}] 안 고른 사람은 "안 고름"`);
      eq(await sel(1).inputValue(), base[0].v, `[직접 고치기·${c.title}] 고른 사람은 그 값`);
      // 바꾸면 바로 저장(admin_assign 한 번, 그 항목·그 사람만)
      let c0 = server.calls.length;
      await sel(20).selectOption(c.to);
      await waitCalls('admin_assign', c0, 1);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      const calls = server.calls.slice(c0).filter((x) => x.fn !== 'board_state' && x.fn !== 'board_cars' && x.fn !== 'score_state');
      eq(calls.map((x) => x.fn), ['admin_assign'], `[직접 고치기·${c.title}] 바꾸면 쓰기 호출은 admin_assign 한 번뿐`);
      eq([calls[0].args.p_what, calls[0].args.p_rows], [c.what, [{ id: 20, value: c.to }]], `[직접 고치기·${c.title}] admin_assign(${c.what}) 그 사람 한 명만`);
      eq(await waitDb(20, c.col, c.to), c.to, `[직접 고치기·${c.title}] DB에 반영됨`);
      const rows = (await db.query(`select id, ${c.col} as v from public.people order by id`)).rows;
      eq(rows.filter((r, i) => r.v !== base[i].v).map((r) => Number(r.id)), [20], `[직접 고치기·${c.title}] 그 사람 하나만 바뀜`);
      await page.waitForFunction(([id, n]) => new RegExp(`^${n}/29명 고름`).test(document.getElementById(id).textContent), [`${c.key}Count`, c.n0 + 1], { timeout: 10000 });
      const groupsOf = () => page.evaluate((list) => Object.fromEntries([...document.querySelectorAll(`${list} .menu-group`)].map((g) => [g.querySelector('p').textContent.replace(/\s*\d+명$/, '').trim(), [...g.querySelectorAll('.chip')].map((x) => x.firstChild.textContent.trim())])), c.list);
      await page.waitForFunction(([list, n]) => [...document.querySelectorAll(`${list} .menu-group`)].some((g) => g.querySelector('p').textContent.startsWith(n) && [...g.querySelectorAll('.chip')].some((x) => x.firstChild.textContent.trim() === '견본버')), [c.list, c.toName], { timeout: 10000 });
      const gr = await groupsOf();
      ok(gr[c.toName].includes('견본버'), `[직접 고치기·${c.title}] 화면에서 그 사람이 ${c.toName} 묶음으로 옮겨 감`);
      ok(!gr['아직 안 고른 사람'].includes('견본버'), `[직접 고치기·${c.title}] 아직 안 고른 사람에서는 빠짐`);
      // 참가자 화면: 같은 사람이 로그인하면 그 값이 반영
      {
        const pctx = await env.browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ko-KR' });
        const pg = await guardNetwork(pctx, server.url);
        const login = async () => {
          const idx = await pctx.newPage();
          idx.on('pageerror', (e) => errors.push(e.message));
          await idx.goto(`${server.url}/index.html`);
          if (await idx.locator('#goMenu').isHidden()) {
            await idx.locator('#dept option', { hasText: '시험개발부' }).waitFor({ state: 'attached', timeout: 10000 });
            await idx.locator('#dept').selectOption({ label: '시험개발부' });
            await idx.locator('#name').fill('견본버');
            await idx.locator('#loginBtn').click();
          }
          await idx.locator('#goMenu').waitFor({ state: 'visible', timeout: 10000 });
          return idx;
        };
        const idx = await login();
        await idx.waitForFunction(([s, n]) => document.querySelector(s).textContent.includes(n), [c.stId, c.toName], { timeout: 10000 });
        ok(true, `[직접 고치기·${c.title}] 참가자 화면(index.html, 견본버 로그인)에 "${c.toName}"이 나옴`);
        await idx.close();
        // 비우기("안 고름")
        c0 = server.calls.length;
        await sel(20).selectOption('');
        await waitCalls('admin_assign', c0, 1);
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        eq(server.calls.slice(c0).filter((x) => x.fn === 'admin_assign').map((x) => [x.args.p_what, x.args.p_rows]), [[c.what, [{ id: 20, value: '' }]]], `[직접 고치기·${c.title}] "안 고름"으로 되돌리면 admin_assign 한 번(빈 값)`);
        eq(await waitDb(20, c.col, null), null, `[직접 고치기·${c.title}] DB에서 비워짐`);
        const idx2 = await login();
        await idx2.waitForFunction(([s, n]) => !document.querySelector(s).textContent.includes(n), [c.stId, c.toName], { timeout: 10000 });
        ok(true, `[직접 고치기·${c.title}] 참가자 화면에서도 비워짐(다시 고를 수 있음)`);
        await idx2.close();
        pg.assertClean();
        await pctx.close();
      }
      eq(await sel(20).inputValue(), '', `[직접 고치기·${c.title}] 화면의 고르는 칸도 "안 고름"`);
      // 끄면 보기만
      await page.locator(`#${c.key}Move`).uncheck();
      eq(await page.locator(`${c.list} select.seat`).count(), 0, `[직접 고치기·${c.title}] 끄면 고르는 칸이 사라지고 보기만`);
      await page.locator(`#${c.key}Move`).check();

      // 저장 실패: 고르는 칸이 저장된 값으로 되돌아오고 오류가 보임, DB는 그대로
      await page.route('**/rest/v1/rpc/admin_assign', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '시험: 저장 실패', code: null, details: null, hint: null }) }));
      const cFail = server.calls.length;
      await sel(20).selectOption(c.to);
      await page.waitForFunction(() => /시험: 저장 실패/.test(document.querySelector('#error').textContent), null, { timeout: 10000 });
      await page.waitForFunction(([s]) => document.querySelector(s).value === '', [`${c.list} select.seat[data-id="20"]`], { timeout: 5000 });
      ok(true, `[직접 고치기·${c.title}] 저장이 실패하면 오류 안내 + 고르는 칸이 저장된 값("안 고름")으로 되돌아옴`);
      eq(server.calls.slice(cFail).filter((x) => x.fn === 'admin_assign').length, 0, `[직접 고치기·${c.title}] 가로챈 저장 요청은 서버에 닿지 않음(서버 기록에 admin_assign 호출 없음)`);
      eq(await waitDb(20, c.col, null, 500), null, `[직접 고치기·${c.title}] DB 값도 그대로`);
      await page.unroute('**/rest/v1/rpc/admin_assign');
      await page.evaluate(() => { document.querySelector('#error').textContent = ''; });

      // 5초 새로고침: 고르는 칸을 잡고 있는 동안 칸이 닫히지 않고 값·초점이 튀지 않음. 다른 사람·같은 사람 값이 DB에서 바뀌어도 그대로, 나오면 맞춤
      await sel(20).focus();
      const b0 = server.calls.length;
      await db.query(`update public.people set ${c.col} = $1 where id = 21`, [c.to]);
      await db.query(`update public.people set ${c.col} = $1 where id = 20`, [c.other]);
      await page.waitForFunction(([id, n]) => new RegExp(`^${n}/29명 고름`).test(document.getElementById(id).textContent), [`${c.key}Count`, c.n0 + 2], { timeout: 15000 }); // 제목 줄 숫자는 곧바로 바뀜 = 새로 받기가 돌았음
      await waitCalls('board_state', b0, 2);
      eq(await page.evaluate(([card, move, list]) => [document.getElementById(card).open, document.querySelector(move).checked, document.activeElement.dataset.seat + ':' + document.activeElement.dataset.id, document.activeElement.value, document.querySelectorAll(`${list} select.seat`).length], [c.card, `#${c.key}Move`, c.list]),
        [true, true, `${c.what}:20`, '', 29], `[직접 고치기·${c.title}] 5초 새로고침이 돌아도 칸 열림·토글·초점·고르는 칸 값("안 고름")이 그대로`);
      await page.evaluate(() => document.activeElement.blur());
      await page.waitForFunction(([s, v]) => document.querySelector(s).value === v, [`${c.list} select.seat[data-id="20"]`, c.other], { timeout: 5000 });
      ok(true, `[직접 고치기·${c.title}] 칸에서 나오면 저장된 값(${c.other})으로 맞춤`);
      await page.close();

      // 마감 뒤(화면 시계 고정)에도 진행자는 바꿀 수 있음
      await fill();
      const late = await openBoard({ fixed: T_AFTER });
      await openCard(late.page, c.card);
      ok(CLOSED_RE.test(norm(await late.page.locator(`#${c.key}Deadline`).textContent())), `[직접 고치기·${c.title}·마감 뒤] 마감 안내는 "마감됐어요(…)" + 방법에 직접 고치기`);
      await late.page.locator(`#${c.key}Move`).check();
      await late.page.locator(`${c.list} select.seat[data-id="20"]`).selectOption(c.to);
      eq(await waitDb(20, c.col, c.to), c.to, `[직접 고치기·${c.title}·마감 뒤] 마감 뒤에도 바뀜`);
      await late.page.close();
    }

    // ── 18. 복사 글: 세 칸 모두 같은 틀의 한 줄(아침 메뉴 "조식", 점심 "점심"), 복사 단추·안내줄·직접 복사 상자 ──
    {
      await fill();
      await env.context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const { page } = await openBoard();
      const WANT_FIRST = {
        menu: '12/18(금) 조식: 우거지 해장국 4 · 소고기 미역국 4 · 버섯 황태 해장국 4 (아직 안 고름 17) / 총 29명',
        lunch: '12/18(금) 점심: 일반 설렁탕 4 · 얼큰 설렁탕 4 (아직 안 고름 21) / 총 29명',
        act: '12/18(금) 저녁 자유시간: 스키 3 · 휴식 3 (아직 안 고름 23) / 총 29명',
      };
      for (const c of CHOICES) {
        await openCard(page, c.card);
        eq(await page.locator(`#${c.card} > summary button, #${c.card} > summary a`).count(), 0, `[복사·${c.title}] 제목 줄에는 단추가 없음`);
        await page.locator(`#${c.key}Copy`).click();
        await page.waitForFunction((s) => /^복사했어요/.test(document.querySelector(s).textContent), `#${c.key}CopyMsg`, { timeout: 5000 });
        const text = await page.evaluate(() => navigator.clipboard.readText());
        eq(text.split('\n')[0], WANT_FIRST[c.key], `[복사·${c.title}] 첫 줄(인원 한 줄)`);
        ok(text.startsWith(c.head + ': '), `[복사·${c.title}] 머리말 "${c.head}"`);
        ok(!(await page.locator(`#${c.key}CopyBox`).isVisible()), `[복사·${c.title}] 복사되면 직접 복사 상자는 숨김`);
        ok((await page.locator(`#${c.key}CopyMsg`).innerText()).startsWith('복사했어요: '), `[복사·${c.title}] 복사했다고 알림`);
        // 클립보드가 막히면 같은 글을 직접 복사할 상자로
        await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('시험: 막힘')) }); });
        await page.locator(`#${c.key}Copy`).click();
        await page.waitForFunction((s) => !document.querySelector(s).hidden, `#${c.key}CopyBox`, { timeout: 5000 });
        eq(await page.locator(`#${c.key}CopyBox`).inputValue(), text, `[복사·${c.title}] 클립보드가 막히면 같은 글을 직접 복사할 상자로`);
        await page.evaluate(() => { delete navigator.clipboard.writeText; }); // 원래 함수로 되돌림
      }
      const boxes = await Promise.all(CHOICES.map((c) => page.locator(`#${c.key}CopyBox`).inputValue()));
      ok(boxes[0].startsWith('12/18(금) 조식') && boxes[1].startsWith('12/18(금) 점심') && boxes[2].startsWith('12/18(금) 저녁 자유시간') && !boxes[0].includes('점심') && !boxes[1].includes('조식'), '[복사] 세 상자가 섞이지 않음(아침 메뉴는 "조식", 점심은 "점심")');
      // 직접 고친 뒤의 인원이 복사 글에 반영
      await page.locator('#menuMove').check();
      await page.locator('#menus select.seat[data-id="20"]').selectOption('miyeok');
      await page.waitForFunction(() => /^13\/29명 고름/.test(document.querySelector('#menuCount').textContent), null, { timeout: 10000 });
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.locator('#menuCopy').click();
      await page.waitForFunction(() => /소고기 미역국 5/.test(document.querySelector('#menuCopyBox').value), null, { timeout: 5000 });
      eq((await page.locator('#menuCopyBox').inputValue()).split('\n')[0], '12/18(금) 조식: 우거지 해장국 4 · 소고기 미역국 5 · 버섯 황태 해장국 4 (아직 안 고름 16) / 총 29명', '[복사·아침 메뉴] 직접 고친 인원이 복사 글에 반영');
      await page.close();
    }

    // ── 19. 프로젝터 보기(?tv=1): 아침 메뉴는 예전 모양 그대로, 새 요소(직접 고치기·복사·안내줄·고르는 칸)는 안 보임 ──
    {
      await fill();
      const { page } = await openBoard();
      await openCard(page, 'menuCard');
      await page.locator('#menuMove').check(); // 직접 고치기를 켜 둔 채 프로젝터 보기로 가도 보이지 않아야 함
      await page.locator('#menus select.seat').first().waitFor();
      await page.locator('#tvBtn').click();
      await page.waitForFunction(() => document.body.classList.contains('tv'));
      await page.locator('#columns .col').first().waitFor();
      for (const sel of ['#menuMove', '#menuCopy', '#menuCopyMsg', '#menuCopyBox', '#menuDeadline', '#menuCard .tools2', '#lunchCard', '#actCard']) ok(!(await page.locator(sel).first().isVisible()), `[프로젝터] ${sel} 안 보임`);
      eq(await page.locator('#menus select').count(), 0, '[프로젝터] 아침 메뉴에 고르는 칸이 없음(직접 고치기를 켜 둔 채여도)');
      ok(await page.locator('#menuCard').isVisible() && await page.locator('#menuCard > summary').isVisible() && await page.locator('#menus').isVisible(), '[프로젝터] 아침 메뉴 칸은 그대로 보임');
      eq(norm(await page.locator('#menuCount').innerText()), '12/29명 고름 · 우거지 해장국 4 · 소고기 미역국 4 · 버섯 황태 해장국 4', '[프로젝터] 제목 줄 숫자는 그대로');
      const deptOf = Object.fromEntries((await db.query('select id, dept, name, menu from public.people')).rows.map((r) => [r.id, r]));
      const byName = (a, b) => a.dept.localeCompare(b.dept, 'ko') || a.name.localeCompare(b.name, 'ko');
      const rowsAll = Object.values(deptOf);
      const want = [
        ...['ugeoji', 'miyeok', 'hwangtae'].map((k, i) => [`${['우거지 해장국', '소고기 미역국', '버섯 황태 해장국'][i]} 4명`, rowsAll.filter((r) => r.menu === k).sort(byName).map((r) => `${r.name} ${r.dept}`)]),
        ['아직 안 고른 사람 17명', rowsAll.filter((r) => !r.menu).sort(byName).map((r) => `${r.name} ${r.dept}`)],
      ];
      const got = await page.evaluate(() => [...document.querySelectorAll('#menus > .menu-group')].map((g) => [g.querySelector('p').textContent.replace(/\s+/g, ' ').trim(), [...g.querySelectorAll('.chips > *')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()), [...g.querySelectorAll('.chips > *')].map((c) => c.tagName + '.' + c.className).filter((x, i, a) => a.indexOf(x) === i), g.className.trim()]));
      eq(got.map((g) => [g[0], g[1]]), want, '[프로젝터] 아침 메뉴 이름표: 메뉴별 묶음 + 아직 안 고른 사람, 이름·부서만(직급 없음), 부서·이름순(예전 그대로)');
      ok(got.every((g) => g[2].every((x) => x === 'SPAN.chip' || x === 'SPAN.empty')) && got.at(-1)[3] === 'menu-group none', `[프로젝터] 이름표는 예전처럼 span.chip(누르는 단추 아님): ${JSON.stringify(got.map((g) => g[2]))}`);
      eq(await page.evaluate(() => [getComputedStyle(document.querySelector('#menus .chip')).fontSize, getComputedStyle(document.querySelector('#menus .menu-group p')).fontSize, getComputedStyle(document.querySelector('#menus .menu-group p b')).fontSize, getComputedStyle(document.querySelector('#menuCard > summary')).fontSize]), ['18px', '18px', '24px', '20px'], '[프로젝터] 큰 글씨 그대로(이름표 18px · 묶음 제목 18/24px · 제목 줄 20px)');
      // 관리자 페이지로 돌아오면 직접 고치기(켜 둔 채)가 다시 보임
      await page.locator('#tvBtn').click();
      await page.waitForFunction(() => !document.body.classList.contains('tv'));
      await page.waitForFunction(() => document.querySelectorAll('#menus select.seat').length === 29, null, { timeout: 5000 });
      ok(await page.locator('#menuMove').isChecked() && await page.locator('#menuCopy').isVisible(), '[프로젝터] 관리자 페이지로 돌아오면 직접 고치기·복사가 다시 보임');
      await page.close();
    }

    // ── 20. 휴대폰(390px): 세 칸이 같은 모양 · 가로로 안 넘침 · 누르는 자리 40px 이상 · 도구 줄이 화면 안 ──
    {
      await fill();
      const { page } = await openBoard({ width: 390 });
      for (const c of CHOICES) { await openCard(page, c.card); await page.locator(`#${c.key}Move`).check(); }
      await page.waitForFunction(() => document.querySelectorAll('#menus select.seat, #lunches select.seat, #acts select.seat').length === 87, null, { timeout: 5000 });
      const m = await page.evaluate((keys) => Object.fromEntries(keys.map(([card, key, list]) => {
        const d = document.getElementById(card), row = d.querySelector(':scope > .tools2'), lab = row.querySelector('label'), btn = row.querySelector('button');
        const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.height)]; };
        const seats = [...d.querySelectorAll(`${list} select.seat`)], chips = [...d.querySelectorAll(`${list} .chip`)];
        return [card, { label: r(lab), btn: r(btn), rowH: Math.round(row.getBoundingClientRect().height), kids: [...row.children].every((k) => k.getBoundingClientRect().left >= -1 && k.getBoundingClientRect().right <= innerWidth + 1),
          seatH: [...new Set(seats.map((s) => Math.round(s.getBoundingClientRect().height)))], seatsIn: seats.every((s) => s.getBoundingClientRect().right <= innerWidth && s.getBoundingClientRect().left >= 0), chipsIn: chips.every((c) => c.getBoundingClientRect().right <= innerWidth + 1),
          cb: lab.querySelector('input').getBoundingClientRect().width, doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth] }];
      })), CHOICES.map((c) => [c.card, c.key, c.list]));
      const [a, b, d] = CHOICES.map((c) => m[c.card]);
      eq([b.label, b.btn, b.rowH], [a.label, a.btn, a.rowH], '[390px·세 칸] 점심의 직접 고치기·복사 단추 자리와 크기가 아침 메뉴와 같음');
      eq([d.label, d.btn, d.rowH], [a.label, a.btn, a.rowH], '[390px·세 칸] 자유시간의 직접 고치기·복사 단추 자리와 크기가 아침 메뉴와 같음');
      for (const [name, x] of [['아침 메뉴', a], ['점심', b], ['자유시간', d]]) {
        ok(x.label[2] >= 40 && x.btn[2] >= 40 && x.seatH.every((h) => h >= 40) && x.cb >= 20, `[390px·${name}] 누르는 자리 40px 이상(직접 고치기 ${x.label[2]}px · 복사 ${x.btn[2]}px · 고르는 칸 ${x.seatH.join('/')}px)`);
        ok(x.kids && x.seatsIn && x.chipsIn && x.doc[0] <= x.doc[1], `[390px·${name}] 도구 줄·이름표·고르는 칸이 화면 안, 가로로 안 넘침(${x.doc[0]} ≤ ${x.doc[1]})`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(150);
      const wide = await page.evaluate(() => ['menuCard', 'lunchCard', 'actCard'].map((id) => { const row = document.querySelector(`#${id} > .tools2`); return [Math.round(row.getBoundingClientRect().height), Math.round(row.querySelector('button').getBoundingClientRect().height), Math.round(row.querySelector('label').getBoundingClientRect().height)]; }));
      eq(wide[1], wide[0], '[1280px·세 칸] 점심 도구 줄 크기가 아침 메뉴와 같음');
      eq(wide[2], wide[0], '[1280px·세 칸] 자유시간 도구 줄 크기가 아침 메뉴와 같음');
      eq(wide[0][1], 36, '[1280px] 복사 단추 높이 36px(넓은 화면 모양 그대로)');
      await page.close();
    }

    // ── 21. 팀 점수 칸: 제목 줄 숫자 `빨강 N · 파랑 N · 노랑 N · 초록 N` · 네 팀 점수 · 5초 새로고침 · 안 건드림 · 점수판 링크 목적지 ──
    {
      await fill();
      await db.query('update public.team_scores set score = 0');
      await db.query("update public.team_scores set score = case team when 'red' then 1250 when 'blue' then -30 when 'yellow' then 5 else 0 end");
      const { page } = await openBoard();
      const fmt = (n) => Number(n).toLocaleString('ko-KR');
      await page.waitForFunction(() => /1,250/.test(document.querySelector('#scoreCount').textContent), null, { timeout: 15000 });
      eq((await page.locator('#scoreCount').innerText()).trim(), `빨강 ${fmt(1250)} · 파랑 ${fmt(-30)} · 노랑 5 · 초록 0`, '[팀 점수] 접힌 제목 줄 숫자 "빨강 N · 파랑 N · 노랑 N · 초록 N"(마이너스도 그대로)');
      ok(await page.locator('#scoreCount').isVisible() && !(await page.locator('#scoreCard').evaluate((d) => d.open)), '[팀 점수] 칸은 접힌 채 제목 줄 숫자가 보임');
      await page.locator('#scoreCard > summary').click();
      const cols = (await page.locator('#scoreView .col').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
      eq(cols.length, 4, '[팀 점수] 칸 안에 네 팀 열');
      ok(cols[0].startsWith('빨강') && cols[0].includes('1,250') && cols[1].startsWith('파랑') && cols[1].includes('30') && cols[2].includes('5') && cols[3].startsWith('초록'), `[팀 점수] 칸 안 네 팀 점수: ${cols.join(' | ')}`);
      eq((await page.locator('#resetScore').textContent()).trim(), '점수 초기화', '[팀 점수] 맨 아래 초기화 칸에 점수 초기화 단추');
      // 다른 곳에서 바뀐 점수가 5초 새로고침에 따라옴(열린 칸은 그대로)
      const c0 = server.calls.length;
      await db.query("update public.team_scores set score = 77 where team = 'green'");
      await page.waitForFunction(() => /초록 77$/.test(document.querySelector('#scoreCount').textContent.trim()), null, { timeout: 15000 });
      ok(server.calls.slice(c0).some((c) => c.fn === 'score_state'), '[팀 점수] 5초 새로고침이 score_state 를 부름');
      eq(await page.locator('#scoreCard').evaluate((d) => d.open), true, '[팀 점수] 새로 받아도 열어 둔 칸은 그대로');
      // 이 칸은 점수를 주지 않음: 읽기뿐, 쓰기 함수 호출 없음
      ok(server.calls.slice(c0).every((c) => !/^score_add$|^admin_/.test(c.fn)), '[팀 점수] 이 칸은 읽기만 함(score_add·admin_* 호출 없음)');
      eq(await page.locator('#scoreView input, #scoreView button, #scoreCard textarea').count(), 0, '[팀 점수] 점수를 줄 입력·단추는 이 칸에 없음(점수는 점수판 화면에서)');
      await db.query('update public.team_scores set score = 0');
      await page.close();
    }

    // ── 22. 점수 받기가 느려도 명단 그리기는 안 늦고, 늦게 온 예전 답이 새 화면을 덮지 않음 ──
    //   (자동 새로고침의 score_state 만 3초 늦게 → 그 사이 DB 에서 한 명이 팀을 정함 → 초기화 칸의 '점수 초기화'로 refresh(true) → 3초 뒤 예전 새로고침이 끝나도 명단이 되돌아가지 않음)
    {
      await fill();
      await db.query('update public.team_scores set score = 0');
      const { page, seen } = await openBoard();
      await page.waitForFunction(() => /팀 뽑음 12명/.test(document.querySelector('#stats').textContent), null, { timeout: 15000 });
      await openCard(page, 'resetCard');
      let slowed = 0;
      await page.route('**/rest/v1/rpc/score_state', async (route) => { if (slowed++ === 0) await new Promise((r) => setTimeout(r, 3000)); await route.fallback(); }); // 처음 한 번만 3초 늦춤(= 다음 자동 새로고침의 점수 받기)
      await page.waitForRequest((r) => /rpc\/score_state$/.test(r.url()), { timeout: 15000 }); // 자동 새로고침이 점수 받기를 보냄(명단 받기도 같이 나감)
      await page.waitForTimeout(400); // 명단 받기는 이미 끝남(예전 12명 그대로)
      await db.query('update public.people set team = \'red\', picked_at = now() where id = (select min(id) from public.people where team is null)');
      const n0 = seen.length;
      const t0 = Date.now();
      await page.locator('#resetScore').click(); // refresh(true) → 확인 창(취소)
      await page.waitForFunction(() => /팀 뽑음 13명/.test(document.querySelector('#stats').textContent), null, { timeout: 5000 });
      const reached = Date.now() - t0;
      const samples = [];
      while (Date.now() - t0 < 4500) { samples.push((await page.locator('#stats').innerText()).replace(/\s+/g, ' ')); await page.waitForTimeout(80); } // 예전 새로고침이 끝나는 3초 뒤를 지나 계속 봄
      eq([...new Set(samples)], ['전체 29명 · 팀 뽑음 13명 · 팀 남음 16명'], `[느린 점수] 명단(팀 뽑음 13명)이 새로 그려진 뒤 3초 늦은 예전 새로고침이 끝나도 12명으로 되돌아가지 않음(${samples.length}번 확인)`);
      ok(reached < 2500, `[느린 점수] 점수 받기가 3초 늦어도 명단은 안 늦음(${reached}ms 만에 13명)`);
      await waitDialogs(page, seen, n0 + 1);
      ok(seen.length === n0 + 1 && /점수 \d+팀/.test(seen[n0].msg), `[느린 점수] 확인 문구는 점수 팀 수를 지금 것으로 보여 줌(취소함): ${(seen[n0] || {}).msg}`);
      await page.close();
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
