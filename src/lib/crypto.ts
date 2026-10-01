import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;

export function keyFromHex(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error('ADDRESS_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  return Buffer.from(hex, 'hex');
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function seal(v: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function open<T>(s: string, key: Buffer): T {
  const b = Buffer.from(s, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}

export const hmac = (secret: string | Buffer, data: string, enc: 'hex' | 'base64' | 'base64url' = 'hex') => createHmac('sha256', secret).update(data).digest(enc);
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signed, expiring value for cookies and one-click links: base64url(json).sig */
export function signValue(v: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${body}.${hmac(secret, body, 'base64url')}`;
}
export function verifyValue<T>(s: string | undefined, secret: string): T | null {
  if (!s) return null;
  const i = s.lastIndexOf('.');
  if (i < 1) return null;
  const body = s.slice(0, i), sig = s.slice(i + 1);
  if (!safeEqual(sig, hmac(secret, body, 'base64url'))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T; } catch { return null; }
}
