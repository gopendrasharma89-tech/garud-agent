import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute an HMAC-SHA256 signature for an inbound webhook payload.
 * Format: `sha256=<hex>`.
 */
export function computeSignature(secret: string, payload: string | Buffer): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload);
  return 'sha256=' + hmac.digest('hex');
}

/** Constant-time signature verification. */
export function verifySignature(secret: string, payload: string | Buffer, headerValue: string): boolean {
  if (!headerValue) return false;
  const expected = computeSignature(secret, payload);
  if (expected.length !== headerValue.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(headerValue, 'utf8'));
  } catch {
    return false;
  }
}
