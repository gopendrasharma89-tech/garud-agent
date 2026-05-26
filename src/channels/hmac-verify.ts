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

/**
 * Slack v0 signature scheme (different from GitHub-style!):
 *   base = `v0:<timestamp>:<body>`
 *   sig  = `v0=` + hex(hmac-sha256(secret, base))
 * Requires the `x-slack-request-timestamp` header to be within ~5 minutes.
 */
export function verifySlackV0(
  secret: string | undefined,
  body: Buffer | string,
  providedSignature: string | string[] | undefined,
  timestamp: string | string[] | undefined,
  opts: { maxAgeSeconds?: number } = {}
): { ok: boolean; reason?: string } {
  if (!secret) return { ok: false, reason: 'secret not configured' };
  const sig = Array.isArray(providedSignature) ? providedSignature[0] : providedSignature;
  const ts = Array.isArray(timestamp) ? timestamp[0] : timestamp;
  if (!sig || !ts) return { ok: false, reason: 'signature or timestamp missing' };
  if (!/^v0=[0-9a-f]+$/i.test(sig)) return { ok: false, reason: 'malformed signature' };
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'malformed timestamp' };
  const maxAge = opts.maxAgeSeconds ?? 300;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (skew > maxAge) return { ok: false, reason: 'timestamp out of range' };
  const bodyStr = typeof body === 'string' ? body : body.toString('utf8');
  const base = `v0:${ts}:${bodyStr}`;
  const expected = `v0=${createHmac('sha256', secret).update(base, 'utf8').digest('hex')}`;
  const a = Buffer.from(sig, 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'length mismatch' };
  return { ok: timingSafeEqual(a, b) };
}

/**
 * Discord uses Ed25519 (NOT HMAC). The signature is hex over
 * `<x-signature-timestamp><body>` verified against the application's public key.
 * Node 16+ has crypto.verify with Ed25519 support — zero extra dependencies.
 */
export async function verifyDiscordEd25519(
  publicKeyHex: string | undefined,
  body: Buffer | string,
  providedSignatureHex: string | string[] | undefined,
  timestamp: string | string[] | undefined
): Promise<{ ok: boolean; reason?: string }> {
  if (!publicKeyHex) return { ok: false, reason: 'public key not configured' };
  const sig = Array.isArray(providedSignatureHex) ? providedSignatureHex[0] : providedSignatureHex;
  const ts = Array.isArray(timestamp) ? timestamp[0] : timestamp;
  if (!sig || !ts) return { ok: false, reason: 'signature or timestamp missing' };
  if (!/^[0-9a-f]{128}$/i.test(sig)) return { ok: false, reason: 'malformed signature' };
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) return { ok: false, reason: 'malformed public key' };
  const { verify, createPublicKey } = await import('node:crypto');
  // Raw Ed25519 public key (32 bytes) wrapped as a SPKI DER for crypto.verify.
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const keyDer = Buffer.concat([spkiPrefix, Buffer.from(publicKeyHex, 'hex')]);
  const keyObj = createPublicKey({ key: keyDer, format: 'der', type: 'spki' });
  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const message = Buffer.concat([Buffer.from(ts, 'utf8'), bodyBuf]);
  try {
    const ok = verify(null, message, keyObj, Buffer.from(sig, 'hex'));
    return { ok };
  } catch (e) {
    return { ok: false, reason: `verify error: ${(e as Error).message}` };
  }
}
