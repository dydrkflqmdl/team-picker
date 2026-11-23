// Playwright 도우미: 브라우저에서 나가는 모든 요청을 가로채 운영 DB 로는 한 건도 못 나가게 한다.
//  - https://*.supabase.co/** → 로컬 대리 서버(server.mjs)로 보내 답을 받아 페이지에 돌려줌(운영 주소로는 연결하지 않음)
//  - 로컬 대리 서버 주소(127.0.0.1/localhost)·data:·blob:·about: → 통과
//  - 그 밖의 외부 주소 → 막고(abort) 기록. guard.assertClean() 이 기록이 있으면 시험을 실패시킨다.
//  - 방어를 한 겹 더: Chrome 이 127.0.0.1 말고는 이름 풀이를 아예 못 하게 한다(웹소켓처럼 route 에 안 잡히는 것도 막힘).
import { chromium } from 'playwright';

/** Chrome(설치된 것) 우선, 없으면 playwright 가 받은 chromium. 외부 이름 풀이는 막는다. */
export async function launchBrowser(opts = {}) {
  const args = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'];
  try { return await chromium.launch({ channel: 'chrome', args, ...opts }); }
  catch { return await chromium.launch({ args, ...opts }); }
}

/**
 * context(또는 page)에 대리 라우팅을 건다.
 * @param target   BrowserContext 또는 Page
 * @param serverUrl 대리 서버 주소(예: http://127.0.0.1:54330)
 * @returns {{ blocked: string[], proxied: {method,url,status}[], assertClean(): void }}
 */
export async function guardNetwork(target, serverUrl) {
  const local = new URL(serverUrl);
  const blocked = [];
  const proxied = [];
  await target.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (['data:', 'blob:', 'about:'].includes(u.protocol)) return route.continue();
    if (u.origin === local.origin) return route.continue();
    if (u.protocol === 'https:' && u.hostname.endsWith('.supabase.co')) {
      // 운영 주소의 경로·본문만 로컬 서버에 그대로 넘긴다(운영 쪽으로는 연결하지 않음)
      const hdr = { ...req.headers() };
      for (const k of ['host', 'origin', 'referer', 'content-length', 'accept-encoding']) delete hdr[k];
      let resp;
      try {
        resp = await fetch(local.origin + u.pathname + u.search, { method: req.method(), headers: hdr, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() ?? undefined });
      } catch (e) { blocked.push(`대리 서버 연결 실패: ${req.method()} ${req.url()} (${e.message})`); return route.abort(); }
      const headers = Object.fromEntries(resp.headers);
      delete headers['content-encoding']; delete headers['content-length'];
      proxied.push({ method: req.method(), url: req.url(), status: resp.status });
      return route.fulfill({ status: resp.status, headers: { ...headers, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: Buffer.from(await resp.arrayBuffer()) });
    }
    blocked.push(`${req.method()} ${req.url()}`);
    return route.abort('blockedbyclient');
  });
  return {
    blocked, proxied,
    assertClean() {
      if (blocked.length) throw new Error('허용되지 않은 외부 요청이 있었어요(운영 DB 접근 포함 가능):\n  ' + blocked.join('\n  '));
    },
  };
}

/** 한 번에: 브라우저 + 새 context(+가드) 만들기. 끝나면 await env.close() */
export async function openTestBrowser(serverUrl, ctxOpts = {}) {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', ...ctxOpts });
  const guard = await guardNetwork(context, serverUrl);
  return { browser, context, guard, newPage: () => context.newPage(), async close() { await browser.close(); } };
}
