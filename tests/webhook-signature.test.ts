import { describe, expect, it } from 'vitest';
import { computeSignature, verifySignature } from '../src/webhook/signature.js';

describe('webhook signature', () => {
  it('produces deterministic sha256 hex', () => {
    const a = computeSignature('s3cret', 'hello');
    const b = computeSignature('s3cret', 'hello');
    expect(a).toBe(b);
    expect(a.startsWith('sha256=')).toBe(true);
    expect(a.length).toBe('sha256='.length + 64);
  });

  it('produces different signatures for different secrets', () => {
    const a = computeSignature('one', 'payload');
    const b = computeSignature('two', 'payload');
    expect(a).not.toBe(b);
  });

  it('verifies a correct signature', () => {
    const sig = computeSignature('s3cret', 'payload-x');
    expect(verifySignature('s3cret', 'payload-x', sig)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const sig = computeSignature('s3cret', 'payload-x');
    expect(verifySignature('s3cret', 'payload-y', sig)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = computeSignature('s3cret', 'payload-x');
    expect(verifySignature('other', 'payload-x', sig)).toBe(false);
  });

  it('rejects an empty header value', () => {
    expect(verifySignature('s3cret', 'payload', '')).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(verifySignature('s3cret', 'payload', 'not-a-real-sig')).toBe(false);
  });

  it('accepts Buffer payloads', () => {
    const buf = Buffer.from('binary-payload', 'utf8');
    const sig = computeSignature('s3cret', buf);
    expect(verifySignature('s3cret', buf, sig)).toBe(true);
  });
});
