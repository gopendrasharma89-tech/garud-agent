import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time HMAC verifier for inbound channel webhooks.
 *
 * Supports the two common header conventions:
 *   - GitHub / Slack style: `sha256=<hex>` in `x-hub-signature-256`
 *   - Discord-style: `<hex>` in `x-signature-ed25519` (we only verify HMAC here; ed25519 is a separate scheme)
 *
 * Pass either the raw hex digest OR `sha256=<hex>`; both are accepted.
 *
 * Returns true only when the secret is set, the header is well-formed, and
 * the digest matches in constant time. Empty/missing inputs return false.
 */
export interface HmacOptions {
  /** Algorithm; defaults to sha256. */
  algorithm?: 'sha256' | 'sha1' | 'sha512';
  /** Maximum allowed body size in bytes (defense in depth; default 2 MiB). */
  maxBodyBytes?: number;
}

export function verifyHmac(
  secret: string | undefined,
  body: Buffer | string,
  providedSignature: string | string[] | undefined,
  opts: HmacOptions = {}
): { ok: boolean; reason?: string } {
  if (!secret) return { ok: false, reason: 'secret not configured' };
  if (providedSignature === undefined) return { ok: false, reason: 'signature missing' };

  const sig = Array.isArray(providedSignature) ? providedSignature[0] : providedSignature;
  if (!sig || typeof sig !== 'string') return { ok: false, reason: 'signature missing' };

  const algorithm = opts.algorithm ?? 'sha256';
  const maxBytes = opts.maxBodyBytes ?? 2 * 1024 * 1024;
  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  if (bodyBuf.length > maxBytes) return { ok: false, reason: 'body too large' };

  // Strip optional algorithm prefix (e.g. "sha256=...")
  const hex = sig.includes('=') ? sig.split('=', 2)[1]! : sig;
  if (!/^[0-9a-f]+$/i.test(hex)) return { ok: false, reason: 'malformed signature' };

  const expected = createHmac(algorithm, secret).update(bodyBuf).digest();
  let provided: Buffer;
  try { provided = Buffer.from(hex, 'hex'); }
  catch { return { ok: false, reason: 'malformed signature' }; }

  if (provided.length !== expected.length) return { ok: false, reason: 'length mismatch' };
  return { ok: timingSafeEqual(provided, expected) };
}

/** Compute a signature for outbound use / tests. */
export function signHmac(secret: string, body: Buffer | string, algorithm: 'sha256' | 'sha1' | 'sha512' = 'sha256'): string {
  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return `${algorithm}=${createHmac(algorithm, secret).update(bodyBuf).digest('hex')}`;
}
