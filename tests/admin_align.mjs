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
const DEADLINE_RE = /^참가자는 11\/25\(수\) 15시까지 .+ 수 있어요\. 그 뒤로는 여기서만 바꿀 수 있어요\. \(방법: .+\)$/;
const OPEN_KEY = 'team-picker-board-open'; // 관리자 페이지 칸 열림 기억
// 칸(모두 details.card) 순서: 한눈에 보기 → 참가자 메인 순서(일정·차량·아침·점심·자유시간) → 현장 뽑기(객실표·팀) → 관리용(명단 관리·초기화)
const CARD_ORDER = ['glanceCard', 'planCard', 'carCard', 'menuCard', 'lunchCard', 'actCard', 'roomCard', 'teamCard', 'admin', 'resetCard'];
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

  // 관리자 화면 열기(비밀번호는 저장된 것으로). opt.width: 화면 너비, opt.url: 주소 끝, opt.noCars: 차량 자료 받기를 막음
  async function openBoard({ width = 1280, url = '', noCars = false, answer } = {}) {
    const page = await env.newPage();
    await page.setViewportSize({ width, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    // 비밀번호는 저장된 것으로. 칸 열림 기억(OPEN_KEY)은 이 탭을 처음 열 때만 지움(같은 context 의 페이지끼리 localStorage 를 같이 써서 앞 시험에서 연 칸이 남지 않게. 새로 고침 뒤에는 그대로 둠)
    await page.addInitScript(([c, k]) => { try { localStorage.setItem('team-picker-admin', JSON.stringify(c)); if (!sessionStorage.getItem('fresh')) { localStorage.removeItem(k); sessionStorage.setItem('fresh', '1'); } } catch {} }, [ADMIN_CODE, OPEN_KEY]);
    if (noCars) await page.route('**/rest/v1/rpc/board_cars', (route) => route.abort());
    const seen = dialogs(page, answer);
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

    // ── 5. 마감 안내 네 칸: 같은 틀 · 제목 바로 아래 ──
    {
      const { page } = await openBoard();
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
      ok((await how('#menuDeadline')).includes('수정') && (await how('#lunchDeadline')).includes('직접 고치기') && (await how('#actDeadline')).includes('직접 고치기') && (await how('#carDeadline')).includes('직접 옮기기'), '[마감 안내] 방법이 칸에 실제 있는 흐름(수정·직접 고치기·직접 옮기기)을 가리킴');
      // 그 흐름이 실제로 있는지
      eq([await page.locator('#lunchMove').count(), await page.locator('#actMove').count(), await page.locator('#carMove').count(), await page.locator('#peopleBody [data-edit]').count()], [1, 1, 1, 29], '[마감 안내] 직접 고치기·직접 옮기기·수정 단추가 그대로 있음');
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
      await page.waitForFunction(() => document.querySelector('#copyBox').value, null, { timeout: 5000 });
      ok((await page.locator('#copyBox').inputValue()).startsWith('12/18(금) 조식: '), `[이름] 식당에 전하는 복사 글은 "조식" 그대로: ${await page.locator('#copyBox').inputValue()}`);
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
      // 객실표 안내
      const room = (await page.locator('#roomNote').innerText()).replace(/\s+/g, ' ');
      ok(room.includes('방은 현장에서 진행자가 발표용 뽑기 화면(draw.html)으로 뽑아요(남녀 따로·인원은 고르게·나머지는 무작위). 여기서는 결과를 확인하고 직접 고칠 수 있어요.') && room.includes('방을 비우면 발표용 화면에서 다시 뽑아요'), `[객실표 안내] ${room}`);
      ok(!/참가자가 .*방 뽑기|방 뽑기로 직접/.test(room), '[객실표 안내] 참가자가 직접 방을 뽑는다는 말이 없음');
      seen.length = 0;
      await page.locator('#roomAuto').click(); // 이미 방이 정해진 사람이 있어 확인 상자가 뜸 → 취소
      await page.waitForTimeout(300);
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
      for (const sel of ['#glanceCard', '#carCard', '#tvWarn', '#teamNote', '#drawLink', '#drawLinkTeam', '#roomCard', '#admin', '#resetCard', '.glance-sum']) {
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
      for (const id of ['#drawLink', '#drawLinkTeam', '#drawLinkRoom']) ok(await page.locator(id).isVisible(), `[390px] ${id} 보임`);
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
      eq(st.ids, CARD_ORDER, '[칸] 순서: 한눈에 보기 → 일정표 → 탑승 차량 → 아침 메뉴 → 점심 → 자유시간 → 객실표 → 팀 → 명단 관리 → 초기화');
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
        actCount: /^6\/29명 고름 · 스키 3 · 휴식 3$/, roomCount: /^10\/29명 배정 · 남자 5실 · 여자 2실$/, teamCount: /^12\/29명 뽑음$/, totalCount: /^총 29명$/,
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
      await page.waitForFunction(() => document.querySelector('#copyBox').value.startsWith('12/18(금) 조식: '), null, { timeout: 5000 });
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
      await page.waitForTimeout(300);
      ok(seen.length === 1 && /전부 새로 나눌까요/.test(seen[0].msg), '[접고 편 뒤·객실표] 자동으로 나누기 → 확인(취소)');
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
