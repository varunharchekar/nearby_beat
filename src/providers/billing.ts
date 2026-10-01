/** Hosted billing through Stripe's REST API. Prices are read from Stripe, never hard-coded. */
import { hmac, safeEqual } from '../lib/crypto.ts';
import type { StripeEvent } from '../domain/billing.ts';

export interface PriceInfo { id: string; plan: 'monthly' | 'annual'; amount: number; currency: string; interval: string; taxBehavior: string | null }
export interface BillingProvider {
  name: string;
  prices(): Promise<PriceInfo[]>;
  createCheckout(o: { accountId: string; email: string; plan: 'monthly' | 'annual'; customerId: string | null; successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  portal(o: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  verifyWebhook(body: string, signatureHeader: string | undefined, now?: number): StripeEvent | null;
  /** Stop renewal; access continues to the end of the paid term. */
  cancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<void>;
  /** Immediate cancellation, used only when an account is deleted. */
  cancelNow(subscriptionId: string): Promise<void>;
}

function form(o: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null) p.set(k, String(v));
  return p;
}

/** Stripe-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)> */
export function verifyStripeSignature(body: string, header: string | undefined, secret: string, now = Date.now(), toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter((x) => x.length === 2));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = hmac(secret, `${t}.${body}`, 'hex');
  return header.split(',').filter((kv) => kv.startsWith('v1=')).some((kv) => safeEqual(kv.slice(3), expected));
}
export const signStripe = (body: string, secret: string, t: number) => `t=${t},v1=${hmac(secret, `${t}.${body}`, 'hex')}`;

export class StripeBilling implements BillingProvider {
  name = 'stripe';
  private key: string; private webhookSecret: string; private priceIds: { monthly: string; annual: string }; private f: typeof fetch; private base: string;
  constructor(o: { key: string; webhookSecret: string; priceMonthly: string; priceAnnual: string; fetch?: typeof fetch; base?: string }) {
    this.key = o.key; this.webhookSecret = o.webhookSecret; this.priceIds = { monthly: o.priceMonthly, annual: o.priceAnnual }; this.f = o.fetch ?? fetch; this.base = o.base ?? 'https://api.stripe.com';
  }
  private async call(method: string, path: string, body?: URLSearchParams) {
    const r = await this.f(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`Stripe ${path} failed: ${j?.error?.message ?? r.status}`);
    return j;
  }
  async prices() {
    const out: PriceInfo[] = [];
    for (const plan of ['monthly', 'annual'] as const) {
      const p = await this.call('GET', `/v1/prices/${this.priceIds[plan]}`);
      out.push({ id: p.id, plan, amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval ?? '', taxBehavior: p.tax_behavior ?? null });
    }
    return out;
  }
  async createCheckout(o: { accountId: string; email: string; plan: 'monthly' | 'annual'; customerId: string | null; successUrl: string; cancelUrl: string }) {
    const s = await this.call('POST', '/v1/checkout/sessions', form({
      mode: 'subscription', 'line_items[0][price]': this.priceIds[o.plan], 'line_items[0][quantity]': 1,
      success_url: o.successUrl, cancel_url: o.cancelUrl, client_reference_id: o.accountId,
      customer: o.customerId, customer_email: o.customerId ? null : o.email,
      'metadata[account_id]': o.accountId, 'subscription_data[metadata][account_id]': o.accountId, 'subscription_data[metadata][plan]': o.plan,
      'automatic_tax[enabled]': 'false',
    }));
    return { url: s.url as string };
  }
  async portal(o: { customerId: string; returnUrl: string }) {
    const s = await this.call('POST', '/v1/billing_portal/sessions', form({ customer: o.customerId, return_url: o.returnUrl }));
    return { url: s.url as string };
  }
  verifyWebhook(body: string, header: string | undefined, now = Date.now()) {
    if (!verifyStripeSignature(body, header, this.webhookSecret, now)) return null;
    try { return JSON.parse(body) as StripeEvent; } catch { return null; }
  }
  async cancelAtPeriodEnd(id: string, cancel: boolean) { await this.call('POST', `/v1/subscriptions/${id}`, form({ cancel_at_period_end: String(cancel) })); }
  async cancelNow(id: string) { await this.call('DELETE', `/v1/subscriptions/${id}`); }
}

/** Test double with Stripe's webhook signature scheme. Checkout returns a local URL. */
export class FakeBilling implements BillingProvider {
  name = 'fake';
  private secret: string;
  sessions: { accountId: string; plan: string }[] = [];
  constructor(secret: string) { this.secret = secret; }
  async prices(): Promise<PriceInfo[]> {
    return [
      { id: 'price_test_monthly', plan: 'monthly', amount: 0, currency: 'usd', interval: 'month', taxBehavior: null },
      { id: 'price_test_annual', plan: 'annual', amount: 0, currency: 'usd', interval: 'year', taxBehavior: null },
    ];
  }
  async createCheckout(o: { accountId: string; plan: string; successUrl: string }) { this.sessions.push({ accountId: o.accountId, plan: o.plan }); return { url: o.successUrl }; }
  async portal(o: { returnUrl: string }) { return { url: o.returnUrl }; }
  verifyWebhook(body: string, header: string | undefined, now = Date.now()) {
    if (!verifyStripeSignature(body, header, this.secret, now)) return null;
    return JSON.parse(body) as StripeEvent;
  }
  cancels: { id: string; cancel: boolean | 'now' }[] = [];
  async cancelAtPeriodEnd(id: string, cancel: boolean) { this.cancels.push({ id, cancel }); }
  async cancelNow(id: string) { this.cancels.push({ id, cancel: 'now' }); }
}
