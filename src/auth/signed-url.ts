import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tiny HMAC-signed URL helper. Used to gate sensitive download endpoints
 * (`/workspace.tgz`) so anyone with the URL can't pull the workspace.
 *
 * Token format: `<hex-hmac>.<exp-unix-seconds>` produced by `signUrlToken`.
 * Verification compares in constant time and rejects expired tokens.
 *
 * No JWT, no headers, no extra deps \u2014 just a query-string token bound to
 * the path and an expiry.
 */

export interface SignedUrlVerifyResult {
  ok: boolean;
  reason?: 'no-secret' | 'no-token' | 'malformed' | 'expired' | 'mismatch';
}

export function signUrlToken(secret: string, pathname: string, expSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${pathname}|${expSeconds}`).digest('hex');
  return `${mac}.${expSeconds}`;
}

export function verifyUrlToken(
  secret: string | undefined,
  pathname: string,
  token: string | string[] | undefined,
  nowMs = Date.now()
): SignedUrlVerifyResult {
  if (!secret) return { ok: false, reason: 'no-secret' };
  const raw = Array.isArray(token) ? token[0] : token;
  if (!raw || typeof raw !== 'string') return { ok: false, reason: 'no-token' };
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: 'malformed' };
  const macHex = raw.slice(0, dot);
  const expStr = raw.slice(dot + 1);
  if (!/^[0-9a-f]+$/i.test(macHex) || !/^\d+$/.test(expStr)) return { ok: false, reason: 'malformed' };
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  if (exp * 1000 < nowMs) return { ok: false, reason: 'expired' };
  const expected = createHmac('sha256', secret).update(`${pathname}|${exp}`).digest();
  let provided: Buffer;
  try { provided = Buffer.from(macHex, 'hex'); }
  catch { return { ok: false, reason: 'malformed' }; }
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' };
  const equal = timingSafeEqual(provided, expected);
  return equal ? { ok: true } : { ok: false, reason: 'mismatch' };
}
