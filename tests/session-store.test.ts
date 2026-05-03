import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/session-store.js';

describe('SessionStore', () => {
  it('creates a new session for unknown user/channel pairs', () => {
    const store = new SessionStore();
    const session = store.getOrCreate({
      channel: 'http', userId: 'u1', text: 'hello', trustLevel: 'owner'
    });
    expect(session.trustLevel).toBe('owner');
    expect(session.messageCount).toBe(1);
    expect(session.agentId).toBe('main');
  });

  it('updates the existing session for repeat messages', () => {
    const store = new SessionStore();
    const a = store.getOrCreate({ channel: 'http', userId: 'u1', text: 'one' });
    const b = store.getOrCreate({ channel: 'http', userId: 'u1', text: 'two' });
    expect(a.id).toBe(b.id);
    expect(b.messageCount).toBe(2);
  });

  it('does not lower trust on inbound messages', () => {
    const store = new SessionStore();
    store.getOrCreate({ channel: 'http', userId: 'u1', text: 'one', trustLevel: 'owner' });
    const elevated = store.getOrCreate({ channel: 'http', userId: 'u1', text: 'two', trustLevel: 'guest' });
    expect(elevated.trustLevel).toBe('owner');
  });

  it('explicitly sets trust via setTrust', () => {
    const store = new SessionStore();
    store.getOrCreate({ channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'guest' });
    const updated = store.setTrust('http', 'u1', 'trusted');
    expect(updated?.trustLevel).toBe('trusted');
  });

  it('list returns sessions ordered by recent activity', () => {
    const store = new SessionStore();
    let now = 1000;
    store.setTimeProvider(() => now);
    store.getOrCreate({ channel: 'http', userId: 'a', text: 'x' });
    now += 1000;
    store.getOrCreate({ channel: 'http', userId: 'b', text: 'y' });
    const sessions = store.list();
    expect(sessions[0]?.userId).toBe('b');
  });

  it('hydrate replaces internal state', () => {
    const store = new SessionStore();
    store.hydrate([
      {
        id: 'a', channel: 'http', userId: 'u1', trustLevel: 'owner', role: 'main',
        agentId: 'main', createdAt: 1, updatedAt: 1, messageCount: 1, settings: {}
      }
    ]);
    expect(store.list()).toHaveLength(1);
    expect(store.get('a')?.userId).toBe('u1');
  });

  it('isolates sessions across agentId', () => {
    const store = new SessionStore();
    const a = store.getOrCreate({ channel: 'http', userId: 'u1', text: 'x', agentId: 'agent1' });
    const b = store.getOrCreate({ channel: 'http', userId: 'u1', text: 'y', agentId: 'agent2' });
    expect(a.id).not.toBe(b.id);
    expect(store.size()).toBe(2);
  });

  it('pruneIdle removes stale sessions only', () => {
    const store = new SessionStore();
    let now = 0;
    store.setTimeProvider(() => now);
    store.getOrCreate({ channel: 'http', userId: 'old', text: 'x' });
    now += 10_000;
    store.getOrCreate({ channel: 'http', userId: 'new', text: 'x' });
    now += 1_000;
    expect(store.pruneIdle(5_000)).toBe(1);
    expect(store.list().map((s) => s.userId)).toEqual(['new']);
  });

  it('remove cleans both indexes', () => {
    const store = new SessionStore();
    const s = store.getOrCreate({ channel: 'http', userId: 'u1', text: 'x' });
    expect(store.remove(s.id)).toBe(true);
    expect(store.get(s.id)).toBeUndefined();
    expect(store.getByUser('http', 'u1')).toBeUndefined();
  });
});
