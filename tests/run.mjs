// 한 곳에서 모든 명령: node run.mjs <명령> [옵션]
//   db-up        postgres 시작 + supabase.sql 적용(DB 를 새로 만듦)
//   db-down      postgres 끄기
//   seed [--picked] [--no-gender]   견본 명단 다시 넣기
//   server [포트]                   대리 서버(Ctrl-C 로 끔)
//   dev          db-up + seed(+옵션) + server 를 한 번에 띄워 두고 Ctrl-C 로 전부 정리
//   draw [번호...]  발표용 뽑기 화면(draw.html) 통합 시험(DB 올리기 → 시나리오 → 끄기)
//   smoke        DB 올리기 → 명단 → 서버 → 브라우저 시험 → 정리(DB 끄기)까지 한 번에
//   reset        관리자 페이지 초기화 칸 통합 시험(DB 올리기 → 시나리오 → 끄기)
//   admin        관리자 페이지를 참가자 화면에 맞춘 것 시험(차량 열·분류 단추·엑셀 열·마감 안내·발표용 링크·프로젝터 보기·390px·칸 통일·칸 순서·열림 기억)
import { ADMIN_CODE, dbStop, dbUp, connect, PORT, isRunning } from './db.mjs';
import { resetRoster } from './seed.mjs';
import { startServer } from './server.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest);
const seedOpts = { picked: flags.has('--picked'), noGender: flags.has('--no-gender') };

async function seed() {
  const c = await connect();
  try { return await resetRoster(c, seedOpts); } finally { await c.end(); }
}

switch (cmd) {
  case 'db-up': {
    const warn = await dbUp();
    console.log(`postgres 127.0.0.1:${PORT} 준비됨(DB draw_test, 관리자 비밀번호 ${ADMIN_CODE}).`);
    if (warn) console.log('supabase.sql 적용 중 안내:\n' + warn);
    break;
  }
  case 'db-down':
    dbStop(); console.log('postgres 끔.'); break;
  case 'seed':
    console.log(`견본 명단 ${await seed()}명 넣음`, seedOpts); break;
  case 'server': {
    if (!isRunning()) { console.error('DB 가 꺼져 있어요: node run.mjs db-up'); process.exit(1); }
    const s = await startServer({ port: rest[0] && !rest[0].startsWith('--') ? Number(rest[0]) : undefined });
    console.log(`대리 서버 ${s.url}  Ctrl-C 로 끔`);
    const bye = async () => { await s.close(); process.exit(0); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
    break;
  }
  case 'dev': {
    await dbUp(); await seed();
    const s = await startServer();
    console.log(`준비됨: ${s.url}/index.html , ${s.url}/board.html (비밀번호 ${ADMIN_CODE})  Ctrl-C 로 서버·DB 끔`);
    const bye = async () => { await s.close(); dbStop(); process.exit(0); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
    break;
  }
  case 'smoke': {
    const { smoke } = await import('./smoke.mjs');
    let ok = false;
    try {
      console.log('[1/2] 로컬 DB 올리기'); const warn = await dbUp(); if (warn) console.log('  안내: ' + warn.split('\n').join('\n  '));
      console.log('[2/2] 연기 시험'); await smoke(); ok = true;
    } catch (e) { console.error('실패:', e.stack || e); }
    finally { dbStop(); console.log('postgres 끔.'); }
    console.log(ok ? '통과' : '실패');
    process.exit(ok ? 0 : 1);
  }
  case 'draw': { // 발표용 뽑기 화면 통합 시험: node run.mjs draw [시나리오 번호 ...]
    const { drawTests } = await import('./draw.mjs');
    let ok = false;
    try {
      console.log('[1/2] 로컬 DB 올리기'); const warn = await dbUp(); if (warn) console.log('  안내: ' + warn.split('\n').join('\n  '));
      console.log('[2/2] 발표용 뽑기 화면 시험'); ok = (await drawTests(rest.filter((x) => /^\d+(\.\d+)?$/.test(x)))).ok;
    } catch (e) { console.error('실패:', e.stack || e); }
    finally { dbStop(); console.log('postgres 끔.'); }
    console.log(ok ? '통과' : '실패');
    process.exit(ok ? 0 : 1);
  }
  case 'reset': { // 관리자 페이지 초기화 칸 시험(전체·항목별 초기화, 확인 한 번, 마감 문구, 참가자 화면, 중간 실패 뒤 이어서)
    const { resetTests } = await import('./reset.mjs');
    let ok = false;
    try {
      console.log('[1/2] 로컬 DB 올리기'); const warn = await dbUp(); if (warn) console.log('  안내: ' + warn.split('\n').join('\n  '));
      console.log('[2/2] 초기화 시험'); const r = await resetTests(); ok = r.ok; console.log(`  확인 ${r.pass}개`);
    } catch (e) { console.error('실패:', e.stack || e); }
    finally { dbStop(); console.log('postgres 끔.'); }
    console.log(ok ? '통과' : '실패');
    process.exit(ok ? 0 : 1);
  }
  case 'admin': { // 관리자 페이지 정렬 시험(한눈에 보기 차량·분류 단추·엑셀 열·마감 안내 네 칸·방/팀 안내와 링크·프로젝터 보기·390px)
    const { adminAlignTests } = await import('./admin_align.mjs');
    let ok = false;
    try {
      console.log('[1/2] 로컬 DB 올리기'); const warn = await dbUp(); if (warn) console.log('  안내: ' + warn.split('\n').join('\n  '));
      console.log('[2/2] 관리자 페이지 정렬 시험'); const r = await adminAlignTests(); ok = r.ok; console.log(`  확인 ${r.pass}개`);
    } catch (e) { console.error('실패:', e.stack || e); }
    finally { dbStop(); console.log('postgres 끔.'); }
    console.log(ok ? '통과' : '실패');
    process.exit(ok ? 0 : 1);
  }
  default:
    console.log('사용법: node run.mjs <db-up|db-down|seed|server|dev|smoke|draw|reset|admin> [--picked] [--no-gender]'); process.exit(cmd ? 1 : 0);
}
