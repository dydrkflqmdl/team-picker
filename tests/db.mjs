// 로컬 시험용 postgres 를 따로 띄우고 끄는 도구. 운영 DB(Supabase)와는 아무 관계가 없다.
// - 데이터 폴더: tests/.pgdata (gitignore), 포트: 기본 54329(환경변수 PGTEST_PORT), 127.0.0.1 만 듣는다(유닉스 소켓 없음).
// - 이미 돌고 있는 다른 postgres 는 건드리지 않는다(포트가 이미 쓰이면 멈춘다).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const PGDATA = join(HERE, '.pgdata');
export const PGLOG = join(HERE, '.pgdata.log');
export const PORT = Number(process.env.PGTEST_PORT || 54329);
export const DB = 'draw_test';
export const ADMIN_CODE = 'test-admin-code-0000'; // 시험용 관리자 비밀번호(운영 값 아님)
const BIN = process.env.PGBIN || '/opt/homebrew/bin';
const bin = (n) => join(BIN, n);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

export function isRunning() {
  if (!existsSync(join(PGDATA, 'postmaster.pid'))) return false;
  return spawnSync(bin('pg_ctl'), ['-D', PGDATA, 'status'], { encoding: 'utf8' }).status === 0;
}

export async function portBusy() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
}

export function connect(database = DB) {
  const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', database });
  return c.connect().then(() => c);
}

/** 데이터 폴더 만들기(없을 때만) + 시작 + anon 등 Supabase 역할 만들기 */
export async function dbStart() {
  if (!isRunning()) {
    if (await portBusy()) throw new Error(`포트 ${PORT} 를 이미 다른 프로그램이 쓰고 있어요. PGTEST_PORT 로 다른 포트를 지정하세요.`);
    if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
      run(bin('initdb'), ['-D', PGDATA, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C.UTF-8']);
    }
    run(bin('pg_ctl'), ['-D', PGDATA, '-l', PGLOG, '-w', '-t', '30',
      '-o', `-p ${PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off -c max_connections=100`, 'start']);
  }
  const c = await connect('postgres');
  try {
    // supabase.sql 이 기대하는 Supabase 쪽 역할(로그인 못 하는 역할)
    for (const r of ['anon', 'authenticated', 'service_role']) {
      await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='${r}') then create role ${r} nologin; end if; end $$`);
    }
  } finally { await c.end(); }
}

export function dbStop() {
  if (!existsSync(join(PGDATA, 'postmaster.pid'))) return;
  spawnSync(bin('pg_ctl'), ['-D', PGDATA, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8' });
}

/** 데이터베이스를 지우고 다시 만든 뒤 supabase.sql 을 그대로 적용(비밀번호 줄만 시험용 값으로 치환). 경고 문구를 돌려준다. */
export async function buildSchema() {
  const c = await connect('postgres');
  try {
    await c.query(`drop database if exists ${DB} with (force)`);
    await c.query(`create database ${DB}`);
  } finally { await c.end(); }
  const PLACEHOLDER = "values ('admin_code', '여기를-바꾸세요')";
  let sql = readFileSync(join(ROOT, 'supabase.sql'), 'utf8');
  if (!sql.includes(PLACEHOLDER)) throw new Error('supabase.sql 에서 admin_code 입력 줄을 못 찾았어요(치환 규칙을 고쳐야 해요).');
  sql = sql.replace(PLACEHOLDER, `values ('admin_code', '${ADMIN_CODE}')`);
  const r = spawnSync(bin('psql'), ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-f', '-'],
    { input: sql, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('supabase.sql 적용 실패:\n' + r.stderr);
  return r.stderr.trim();
}

/** 한 번에: 시작 + 스키마 새로 만들기 */
export async function dbUp() {
  await dbStart();
  return buildSchema();
}
