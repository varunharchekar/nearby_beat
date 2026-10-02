/** Passwordless operator sign-in for the console. */
import type { App } from '../app.ts';
import { MIN } from '../domain/time.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';

export async function requestOperatorLogin(app: App, emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  if (!app.cfg.operatorEmails.includes(email)) return; // same response either way
  const now = app.clock.now();
  if ((await app.store.countMagicLinks(email, now - 10 * MIN)) >= 3) return;
  const token = randomToken();
  await app.store.saveMagicLink({ tokenHash: sha256(token), email, purpose: 'operator', payload: {}, expiresAt: now + 15 * MIN, usedAt: null, createdAt: now });
  const url = `${app.cfg.baseUrl}/ops/verify?token=${encodeURIComponent(token)}`;
  await app.mailer.send({ to: email, tag: 'service', subject: 'Nearby operator sign-in', text: `Sign in to the Nearby operator console:\n\n${url}\n\nThe link works once and expires in 15 minutes.`, html: `<p><a href="${url}">Sign in to the Nearby operator console</a></p><p>The link works once and expires in 15 minutes.</p>` });
}

export async function verifyOperatorLink(app: App, token: string): Promise<string | null> {
  const m = await app.store.consumeMagicLink(sha256(token), app.clock.now());
  return m && m.purpose === 'operator' && app.cfg.operatorEmails.includes(m.email) ? m.email : null;
}
