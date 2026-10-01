/** HTTP server: builds the request context, enforces same-origin form posts, and handles errors. */
import { createServer } from 'node:http';
import type { App } from '../app.ts';
import { parseCookies, parseForm, readBody, securityHeaders, send, sendJson } from './html.ts';
import type { Ctx } from './html.ts';
import { buildRouter } from './routes.ts';
import { layout, simplePage } from './views.ts';

/** Paths that legitimately receive cross-site POSTs (provider webhooks, one-click unsubscribe from mail clients). */
const CROSS_SITE_OK = [/^\/api\/webhooks\//, /^\/u\//];

export function sameOrigin(c: Pick<Ctx, 'req'>, baseUrl: string): boolean {
  const h = c.req.headers;
  const site = h['sec-fetch-site'];
  if (typeof site === 'string') return site === 'same-origin' || site === 'none';
  const host = new URL(baseUrl).host;
  const origin = h.origin as string | undefined;
  if (origin && origin !== 'null') { try { return new URL(origin).host === host; } catch { return false; } }
  const ref = h.referer as string | undefined;
  if (ref) { try { return new URL(ref).host === host; } catch { return false; } }
  return false;
}

export function makeHandler(app: App) {
  const router = buildRouter(app);
  const secure = app.cfg.baseUrl.startsWith('https://');
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    securityHeaders(res, secure);
    const url = new URL(req.url ?? '/', app.cfg.baseUrl);
    const method = (req.method ?? 'GET').toUpperCase();
    const cookieOut: string[] = [];
    const c: Ctx = {
      req, res, url, method, params: {}, cookies: parseCookies(req.headers.cookie),
      ip: (app.cfg.mode === 'live' && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress) ?? '',
      body: '', form: {}, json: null,
      setCookie(name, value, maxAge) { cookieOut.push(`${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`); res.setHeader('Set-Cookie', cookieOut); },
      clearCookie(name) { cookieOut.push(`${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`); res.setHeader('Set-Cookie', cookieOut); },
    };
    try {
      const m = router.match(method, url.pathname);
      if (!m) return send(c, 404, layout(app, { title: 'Not found', body: simplePage('Page not found', '<p><a href="/">Go to the start</a></p>') }));
      c.params = m.params;
      if (method !== 'GET' && method !== 'HEAD') {
        c.body = await readBody(req);
        const type = String(req.headers['content-type'] ?? '');
        if (type.includes('application/json')) { try { c.json = c.body ? JSON.parse(c.body) : {}; } catch { return sendJson(c, 400, { error: 'Invalid JSON' }); } }
        else c.form = parseForm(c.body);
        const isApi = url.pathname.startsWith('/api/');
        if (!CROSS_SITE_OK.some((re) => re.test(url.pathname)) && !sameOrigin(c, app.cfg.baseUrl)) {
          return isApi ? sendJson(c, 403, { error: 'Cross-site request blocked.' }) : send(c, 403, layout(app, { title: 'Blocked', body: simplePage('Request blocked', '<p>This form must be sent from Nearby itself. Go back and try again.</p>') }));
        }
      }
      if (/^\/(start|account|auth|login|ops|dev|u\/)/.test(url.pathname)) res.setHeader('Cache-Control', 'no-store');
      await m.h(c);
    } catch (e) {
      const err = e as Error & { status?: number };
      app.log('http.error', { path: url.pathname, status: err.status ?? 500, error: err.message.slice(0, 200) });
      if (!res.headersSent) send(c, err.status ?? 500, layout(app, { title: 'Something went wrong', body: simplePage('Something went wrong', '<p>Your draft is saved. Go back and try again in a moment.</p>') }));
      else res.end();
    }
  };
}

export function startServer(app: App) {
  const server = createServer(makeHandler(app));
  server.listen(app.cfg.port, () => app.log('server.listening', { port: app.cfg.port, mode: app.cfg.mode, store: app.cfg.store }));
  return server;
}
