// 시험용 대리 서버: 저장소 루트의 정적 파일을 내주고, POST /rest/v1/rpc/<함수> 를 로컬 postgres 의 실제 SQL 함수로 이어 준다(PostgREST 흉내).
// 사용: node server.mjs [포트]   또는   import { startServer } from './server.mjs'
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import pg from 'pg';
import { DB, PORT as PGPORT, ROOT } from './db.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': '*' };

export async function startServer({ port = Number(process.env.TEST_SERVER_PORT || 54330) } = {}) {
  const pool = new pg.Pool({ host: '127.0.0.1', port: PGPORT, user: 'postgres', database: DB, max: 10 });
  const sigCache = new Map();
  const calls = []; // 받은 rpc 기록 {fn, args, status, ms}

  async function signature(client, fn) {
    if (sigCache.has(fn)) return sigCache.get(fn);
    const { rows } = await client.query(
      `select p.proargnames as names, p.proretset as is_set, p.prorettype::regtype::text as ret,
              (select array_agg(format_type(o, null) order by ord) from unnest(p.proargtypes::oid[]) with ordinality t(o, ord)) as types
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`, [fn]);
    const sig = rows[0] || null; // (이 앱은 함수 이름이 겹치지 않음)
    if (sig) sigCache.set(fn, sig);
    return sig;
  }

  const notFound = (message) => ({ status: 404, body: { code: 'PGRST202', message, details: null, hint: null } });

  async function rpc(fn, body) {
    const client = await pool.connect();
    try {
      const sig = await signature(client, fn);
      if (!sig) return notFound(`Could not find the function public.${fn} in the schema cache`);
      const names = sig.names || [];
      const args = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      const used = Object.keys(args);
      if (used.some((k) => !names.includes(k))) return notFound(`Could not find the function public.${fn}(${used.join(', ')}) in the schema cache`);
      const params = []; const parts = [];
      for (const k of used) {
        const t = sig.types[names.indexOf(k)];
        let v = args[k];
        if (v !== null && v !== undefined && (t === 'jsonb' || t === 'json')) v = JSON.stringify(v);
        params.push(v === undefined ? null : v);
        parts.push(`${k} := $${params.length}::${t}`);
      }
      const call = `public.${fn}(${parts.join(', ')})`;
      const sql = sig.ret === 'void' ? `select ${call}`
        : sig.is_set ? `select coalesce(json_agg(x), '[]'::json) as r from ${call} x`
        : `select to_json(${call}) as r`;
      await client.query('begin');
      try {
        await client.query('set local role anon');
        await client.query("set local statement_timeout = '8s'"); // PostgREST 가 anon 의 rolconfig 를 적용하는 것과 같게
        const { rows } = await client.query(sql, params);
        await client.query('commit');
        return sig.ret === 'void' ? { status: 204, body: undefined } : { status: 200, body: rows[0].r };
      } catch (e) {
        await client.query('rollback').catch(() => {});
        if (e.code === '42883') return notFound(e.message);
        return { status: 400, body: { message: e.message, code: e.code || null, details: e.detail || null, hint: e.hint || null } };
      }
    } finally { client.release(); }
  }

  const json = (res, status, obj) => { res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...CORS, 'access-control-allow-headers': req.headers['access-control-request-headers'] || '*', 'access-control-max-age': '600' });
        return res.end();
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
        if (!m) return json(res, 404, { code: 'PGRST202', message: '함수 이름은 [a-z_]+ 만 쓸 수 있어요', details: null, hint: null });
        if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(); }
        const chunks = []; for await (const c of req) chunks.push(c);
        let body;
        try { const t = Buffer.concat(chunks).toString('utf8'); body = t ? JSON.parse(t) : {}; }
        catch { return json(res, 400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null }); }
        const t0 = Date.now();
        const r = await rpc(m[1], body);
        calls.push({ fn: m[1], args: body, status: r.status, ms: Date.now() - t0 });
        if (r.body === undefined) { res.writeHead(r.status, CORS); return res.end(); }
        return json(res, r.status, r.body);
      }
      // 정적 파일(저장소 루트). tests/ 와 점(.)으로 시작하는 폴더·파일(.git 등)은 내주지 않는다.
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, CORS); return res.end(); }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = normalize(join(ROOT, rel));
      const inRoot = file.startsWith(ROOT + sep);
      const top = inRoot ? file.slice(ROOT.length + 1).split(sep)[0] : '';
      if (!inRoot || top === 'tests' || top.startsWith('.')) { res.writeHead(404, CORS); return res.end('not found'); }
      const s = await stat(file).catch(() => null);
      if (!s || !s.isFile()) { res.writeHead(404, CORS); return res.end('not found'); }
      res.writeHead(200, { ...CORS, 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (e) {
      json(res, 500, { message: String(e.message || e), code: null, details: null, hint: null });
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}`, port: addr.port, calls,
    async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await pool.end(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startServer({ port: process.argv[2] ? Number(process.argv[2]) : undefined });
  console.log(`대리 서버: ${s.url}  (index.html / board.html, POST /rest/v1/rpc/<함수>)  끄기: Ctrl-C`);
  const bye = async () => { await s.close(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
