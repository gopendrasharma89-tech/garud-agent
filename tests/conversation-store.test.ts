import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/conversation/conversation-store.js';

describe('ConversationStore', () => {
  it('appends and lists turns per session', () => {
    const store = new ConversationStore({ maxTurns: 10 });
    store.append({ sessionId: 's1', input: 'hi', reply: 'hello', toolsUsed: [] });
    store.append({ sessionId: 's1', input: 'how are you', reply: 'good', toolsUsed: [] });
    store.append({ sessionId: 's2', input: 'other session', reply: 'ok', toolsUsed: [] });
    expect(store.list('s1')).toHaveLength(2);
    expect(store.list('s2')).toHaveLength(1);
  });

  it('caps history to maxTurns', () => {
    const store = new ConversationStore({ maxTurns: 3 });
    for (let i = 0; i < 5; i++) {
      store.append({ sessionId: 's1', input: `q${i}`, reply: `a${i}`, toolsUsed: [] });
    }
    const list = store.list('s1');
    expect(list).toHaveLength(3);
    expect(list[0]?.input).toBe('q2');
    expect(list[2]?.input).toBe('q4');
  });

  it('returns recent N turns', () => {
    const store = new ConversationStore({ maxTurns: 10 });
    for (let i = 0; i < 5; i++) {
      store.append({ sessionId: 's1', input: `q${i}`, reply: `a${i}`, toolsUsed: [] });
    }
    const recent = store.recent('s1', 2);
    expect(recent).toHaveLength(2);
    expect(recent[1]?.input).toBe('q4');
  });

  it('clears a session', () => {
    const store = new ConversationStore({ maxTurns: 10 });
    store.append({ sessionId: 's1', input: 'a', reply: 'b', toolsUsed: [] });
    store.append({ sessionId: 's1', input: 'c', reply: 'd', toolsUsed: [] });
    expect(store.clear('s1')).toBe(2);
    expect(store.list('s1')).toEqual([]);
  });

  it('skips storage when maxTurns is 0', () => {
    const store = new ConversationStore({ maxTurns: 0 });
    store.append({ sessionId: 's1', input: 'a', reply: 'b', toolsUsed: [] });
    expect(store.list('s1')).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('hydrates and trims to maxTurns', () => {
    const store = new ConversationStore({ maxTurns: 2 });
    store.hydrate([
      { sessionId: 's1', ts: 1, input: 'a', reply: 'A', toolsUsed: [] },
      { sessionId: 's1', ts: 2, input: 'b', reply: 'B', toolsUsed: [] },
      { sessionId: 's1', ts: 3, input: 'c', reply: 'C', toolsUsed: [] }
    ]);
    expect(store.list('s1')).toHaveLength(2);
  });

  it('uses provided ts or current time', () => {
    let now = 5000;
    const store = new ConversationStore({ maxTurns: 5 });
    store.setTimeProvider(() => now);
    const turn = store.append({ sessionId: 's1', input: 'a', reply: 'b', toolsUsed: [] });
    expect(turn.ts).toBe(5000);
  });

  it('reports total size across sessions', () => {
    const store = new ConversationStore({ maxTurns: 10 });
    store.append({ sessionId: 's1', input: 'a', reply: 'b', toolsUsed: [] });
    store.append({ sessionId: 's2', input: 'c', reply: 'd', toolsUsed: [] });
    expect(store.size()).toBe(2);
  });
});
