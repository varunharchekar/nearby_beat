/**
 * Billing provider event reducer (Stripe event shapes).
 * Access is granted only from verified provider events, never from a browser redirect.
 * Handles duplicates (event id), out-of-order delivery (provider `created` per object),
 * and invoices that arrive before their subscription.
 */
import type { SubInfo, SubStatus } from './ledger.ts';

export interface BillingRecord {
  customerId: string | null;
  subscriptionId: string | null;
  sub: SubInfo | null;
  subVersionAt: number;
  seenEventIds: string[];
  heldInvoices: { subscriptionId: string; eventId: string }[];
  paidInvoices: string[];
  log: string[];
}
export const emptyBilling = (): BillingRecord => ({ customerId: null, subscriptionId: null, sub: null, subVersionAt: 0, seenEventIds: [], heldInvoices: [], paidInvoices: [], log: [] });

export interface StripeEvent { id: string; type: string; created: number; data: { object: any } }

const mapStatus = (s: string, cancelAtEnd: boolean): SubStatus => {
  if (s === 'active' || s === 'trialing') return cancelAtEnd ? 'canceled_pending_expiry' : 'active';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  if (s === 'canceled' || s === 'incomplete_expired') return 'expired';
  return 'pending';
};

function periodOf(o: any): [number | null, number | null] {
  const item = o.items?.data?.[0];
  const start = o.current_period_start ?? item?.current_period_start ?? null;
  const end = o.current_period_end ?? item?.current_period_end ?? null;
  return [start ? start * 1000 : null, end ? end * 1000 : null];
}

function planOf(o: any, prices: { monthly?: string; annual?: string }): 'monthly' | 'annual' | null {
  const pid = o.items?.data?.[0]?.price?.id ?? o.metadata?.plan_price;
  if (pid && pid === prices.annual) return 'annual';
  if (pid && pid === prices.monthly) return 'monthly';
  const interval = o.items?.data?.[0]?.price?.recurring?.interval;
  return interval === 'year' ? 'annual' : interval === 'month' ? 'monthly' : (o.metadata?.plan ?? null);
}

export function applyStripeEvent(rec0: BillingRecord, ev: StripeEvent, prices: { monthly?: string; annual?: string } = {}): { rec: BillingRecord; note: string; changed: boolean } {
  const rec: BillingRecord = structuredClone(rec0);
  if (rec.seenEventIds.includes(ev.id)) return { rec: rec0, note: `Duplicate ${ev.type} (${ev.id}) ignored`, changed: false };
  rec.seenEventIds.push(ev.id);
  const o = ev.data.object;
  let note = `${ev.type} recorded`;
  switch (ev.type) {
    case 'checkout.session.completed': {
      rec.customerId = o.customer ?? rec.customerId;
      rec.subscriptionId = o.subscription ?? rec.subscriptionId;
      note = 'Checkout completed; waiting for subscription confirmation';
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const at = ev.created * 1000;
      if (at < rec.subVersionAt) { note = `Older ${ev.type} ignored (out of order)`; break; }
      rec.subVersionAt = at;
      rec.subscriptionId = o.id;
      rec.customerId = o.customer ?? rec.customerId;
      const [s, e] = periodOf(o);
      const status = ev.type === 'customer.subscription.deleted' ? 'expired' : mapStatus(o.status, !!o.cancel_at_period_end);
      rec.sub = { status, plan: planOf(o, prices) ?? rec.sub?.plan ?? null, termStart: s ?? rec.sub?.termStart ?? null, termEnd: e ?? rec.sub?.termEnd ?? null, cancelAtEnd: !!o.cancel_at_period_end };
      note = `Subscription ${status}`;
      const held = rec.heldInvoices.filter((h) => h.subscriptionId === o.id);
      if (held.length) { rec.paidInvoices.push(...held.map((h) => h.eventId)); rec.heldInvoices = rec.heldInvoices.filter((h) => h.subscriptionId !== o.id); note += `; applied ${held.length} held invoice event(s)`; }
      break;
    }
    case 'invoice.paid': {
      const sid = o.subscription ?? o.parent?.subscription_details?.subscription;
      if (!rec.sub || rec.subscriptionId !== sid) { rec.heldInvoices.push({ subscriptionId: sid, eventId: ev.id }); note = 'Invoice paid before subscription was known; held'; break; }
      rec.paidInvoices.push(ev.id);
      if (rec.sub.status === 'past_due') rec.sub.status = rec.sub.cancelAtEnd ? 'canceled_pending_expiry' : 'active';
      note = 'Invoice paid';
      break;
    }
    case 'invoice.payment_failed': {
      if (rec.sub) rec.sub.status = 'past_due';
      note = 'Renewal payment failed';
      break;
    }
    default: note = `${ev.type} ignored`;
  }
  rec.log.unshift(note);
  rec.log = rec.log.slice(0, 50);
  return { rec, note, changed: true };
}
