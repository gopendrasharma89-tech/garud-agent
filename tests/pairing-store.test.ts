import { describe, expect, it } from 'vitest';
import { PairingStore } from '../src/core/pairing-store.js';

describe('PairingStore', () => {
  it('issues unique codes for new pairings', () => {
    const store = new PairingStore();
    const a = store.issue('http', 'u1', 'trusted');
    const b = store.issue('http', 'u2', 'trusted');
    expect(a.code).not.toBe(b.code);
    expect(store.size()).toBe(2);
  });

  it('replaces a pending code for the same pair', () => {
    const store = new PairingStore();
    const first = store.issue('http', 'u1', 'trusted');
    const second = store.issue('http', 'u1', 'owner');
    expect(store.size()).toBe(1);
    expect(store.redeem(first.code)).toBeUndefined();
    expect(store.redeem(second.code)?.trustLevel).toBe('owner');
  });

  it('redeem consumes the code', () => {
    const store = new PairingStore();
    const r = store.issue('http', 'u1', 'trusted');
    expect(store.redeem(r.code)?.userId).toBe('u1');
    expect(store.redeem(r.code)).toBeUndefined();
  });

  it('redeem returns undefined for expired codes', () => {
    const store = new PairingStore({ codeTtlMs: 1000 });
    let now = 0;
    store.setTimeProvider(() => now);
    const r = store.issue('http', 'u1', 'trusted');
    now += 5000;
    expect(store.redeem(r.code)).toBeUndefined();
  });

  it('list excludes expired records', () => {
    const store = new PairingStore({ codeTtlMs: 1000 });
    let now = 0;
    store.setTimeProvider(() => now);
    store.issue('http', 'u1', 'trusted');
    now += 5000;
    expect(store.list()).toEqual([]);
  });

  it('handles unknown codes gracefully', () => {
    const store = new PairingStore();
    expect(store.redeem('not-a-real-code')).toBeUndefined();
  });

  it('revoke clears all pending codes for a (channel, user)', () => {
    const store = new PairingStore();
    store.issue('http', 'u1', 'trusted');
    store.issue('http', 'u2', 'owner');
    expect(store.revoke('http', 'u1')).toBe(1);
    expect(store.revoke('http', 'u1')).toBe(0);
    expect(store.size()).toBe(1);
  });
});
