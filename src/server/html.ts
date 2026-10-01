/** Minimal HTTP layer on node:http: routing, cookies, bodies, security headers. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  params: Record<string, string>;
  cookies: Record<string, string>;
  ip: string;
  body: string;
  form: Record<string, string | string[]>;
  json: any;
  setCookie(name: string, value: string, maxAgeSec: number): void;
  clearCookie(name: string): void;
}
export type Handler = (c: Ctx) => Promise<void> | void;

interface Route { method: string; re: RegExp; keys: string[]; h: Handler }
export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, h: Handler) {
    const keys: string[] = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
    this.routes.push({ method, re, keys, h });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }
  patch(p: string, h: Handler) { this.add('PATCH', p, h); }
  del(p: string, h: Handler) { this.add('DELETE', p, h); }
  match(method: string, path: string) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) return { h: r.h, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

export function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

export function parseForm(body: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
export const many = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 }); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

export function securityHeaders(res: ServerResponse, secure: boolean) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https://api.mapbox.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

export const send = (c: Ctx, status: number, body: string, type = 'text/html; charset=utf-8') => {
  c.res.statusCode = status;
  c.res.setHeader('Content-Type', type);
  c.res.end(body);
};
export const sendJson = (c: Ctx, status: number, obj: unknown) => send(c, status, JSON.stringify(obj), 'application/json; charset=utf-8');
export const redirect = (c: Ctx, to: string) => { c.res.statusCode = 303; c.res.setHeader('Location', to); c.res.end(); };
