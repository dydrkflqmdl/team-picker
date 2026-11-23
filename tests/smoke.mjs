// 연기 시험: 견본 명단 29명 → board.html 에서 보이는지, index.html 에서 견본 한 명이 로그인되는지.
import assert from 'node:assert/strict';
import { ADMIN_CODE, connect } from './db.mjs';
import { resetRoster, roster } from './seed.mjs';
import { startServer } from './server.mjs';
import { guardNetwork, openTestBrowser } from './helpers.mjs';

export async function smoke() {
  const db = await connect();
  const n = await resetRoster(db);
  await db.end();
  assert.equal(n, 29);
  const g = roster();
  assert.equal(g.filter((p) => p.gender === '남').length, 20);
  assert.equal(g.filter((p) => p.gender === '여').length, 9);
  console.log('  견본 명단 29명(남 20·여 9) 넣음');

  const server = await startServer({ port: 0 });
  const env = await openTestBrowser(server.url);
  try {
    // 1) 관리자 화면
    const board = await env.newPage();
    const errors = [];
    board.on('pageerror', (e) => errors.push(e.message));
    await board.goto(`${server.url}/board.html`);
    await board.locator('#code').fill(ADMIN_CODE);
    await board.locator('#codeForm button[type=submit]').click();
    await board.locator('#glanceBody tr').first().waitFor({ timeout: 10000 });
    const rows = await board.locator('#glanceBody tr').count();
    assert.equal(rows, 29, `관리자 화면 한눈에 보기 줄 수 ${rows} (29 기대)`);
    assert.equal(await board.locator('#peopleBody tr').count(), 29, '명단 관리 표 줄 수');
    console.log('  board.html: 시험 비밀번호로 들어가 명단 29명 확인');

    // 틀린 비밀번호는 거절되는지(실제 SQL 의 check_admin 이 돌고 있다는 증거)
    // (같은 context 는 저장된 비밀번호로 바로 들어가므로 새 context 를 쓴다)
    const badCtx = await env.browser.newContext();
    const badGuard = await guardNetwork(badCtx, server.url);
    const bad = await badCtx.newPage();
    await bad.goto(`${server.url}/board.html`);
    await bad.locator('#code').fill('틀린-비밀번호');
    await bad.locator('#codeForm button[type=submit]').click();
    await bad.locator('#codeCard').waitFor({ state: 'visible' });
    await bad.waitForTimeout(500);
    assert.equal(await bad.locator('#glanceBody tr').count(), 0, '틀린 비밀번호로 명단이 보이면 안 됨');
    badGuard.assertClean();
    await badCtx.close();

    // 2) 참가자 화면
    const idx = await env.newPage();
    idx.on('pageerror', (e) => errors.push(e.message));
    await idx.goto(`${server.url}/index.html`);
    const me = g[0];
    await idx.locator('#dept option', { hasText: me.dept }).waitFor({ state: 'attached', timeout: 10000 });
    await idx.locator('#dept').selectOption({ label: me.dept });
    await idx.locator('#name').fill(me.name);
    await idx.locator('#loginBtn').click();
    await idx.locator('#goMenu').waitFor({ state: 'visible', timeout: 10000 }); // 로그인 뒤 메인 메뉴(방·팀 뽑기는 참가자 메인에서 숨겨져 아침 메뉴 단추로 확인)
    console.log(`  index.html: 견본 한 명(${me.name})으로 로그인되어 메인 메뉴가 보임`);

    assert.deepEqual(errors, [], '페이지 오류: ' + errors.join(' | '));
    env.guard.assertClean(); // 운영·외부 주소로 나가려던 요청이 없어야 함
    assert.ok(env.guard.proxied.length > 0, '대리로 보낸 supabase 요청이 하나도 없음(화면이 DB를 안 부른 듯)');
    assert.ok(server.calls.some((c) => c.fn === 'login' && c.status === 200));
    console.log(`  운영 주소로 나간 요청 0건(supabase 요청 ${env.guard.proxied.length}건은 로컬로 돌림, 막은 외부 요청 ${env.guard.blocked.length}건)`);
  } finally {
    await env.close();
    await server.close();
  }
}
