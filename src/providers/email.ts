/** Transactional email. Resend via its REST API; console outbox for fixture mode and tests. */
import { hmac, safeEqual } from '../lib/crypto.ts';
import type { DeliveryEvent } from '../domain/ledger.ts';

export interface OutMessage { to: string; subject: string; html: string; text: string; headers?: Record<string, string>; tag: 'magic_link' | 'issue' | 'notice' | 'service' | 'waitlist' }
export interface Mailer {
  name: string;
  send(m: OutMessage): Promise<{ id: string }>;
}

export class ResendMailer implements Mailer {
  name = 'resend';
  private key: string;
  private from: string;
  private f: typeof fetch;
  constructor(key: string, from: string, f: typeof fetch = fetch) { this.key = key; this.from = from; this.f = f; }
  async send(m: OutMessage) {
    const r = await this.f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers ?? {}, tags: [{ name: 'kind', value: m.tag }] }),
    });
    if (!r.ok) throw new Error(`Resend send failed: ${r.status} ${await r.text().catch(() => '')}`);
    const j: any = await r.json();
    return { id: j.id as string };
  }
}

/** Keeps messages in memory. Never sends real email. */
export class ConsoleMailer implements Mailer {
  name = 'console';
  outbox: (OutMessage & { id: string; at: number })[] = [];
  private n = 0;
  async send(m: OutMessage) {
    const id = `console_${++this.n}`;
    this.outbox.unshift({ ...m, id, at: Date.now() });
    this.outbox = this.outbox.slice(0, 200);
    return { id };
  }
}

/**
 * Verify a Resend (Svix) webhook. Signature: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)),
 * where the secret is the base64 part after "whsec_".
 */
export function verifySvix(body: string, headers: Record<string, string | undefined>, secret: string, now = Date.now(), toleranceSec = 300): boolean {
  const id = headers['svix-id'], ts = headers['svix-timestamp'], sig = headers['svix-signature'];
  if (!id || !ts || !sig) return false;
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSec) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = hmac(key, `${id}.${ts}.${body}`, 'base64');
  return sig.split(' ').some((part) => { const [, v] = part.split(','); return !!v && safeEqual(v, expected); });
}
export function signSvix(body: string, secret: string, id: string, ts: number): Record<string, string> {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${hmac(key, `${id}.${ts}.${body}`, 'base64')}` };
}

/** Map a Resend webhook event to a delivery event. */
export function resendEvent(evt: any): { messageId: string; event: DeliveryEvent } | null {
  const id = evt?.data?.email_id;
  if (!id) return null;
  switch (evt.type) {
    case 'email.sent': return { messageId: id, event: 'accepted' };
    case 'email.delivered': return { messageId: id, event: 'delivered' };
    case 'email.bounced': return { messageId: id, event: evt.data?.bounce?.type === 'Transient' ? 'bounced_soft' : 'bounced_hard' };
    case 'email.complained': return { messageId: id, event: 'complained' };
    case 'email.failed': return { messageId: id, event: 'failed' };
    default: return null;
  }
}
