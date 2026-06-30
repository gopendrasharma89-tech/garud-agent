import { describe, it, expect } from 'vitest';
import { buildBuiltinTools } from '../src/tools/builtin-tools.js';
import { MemoryStore } from '../src/core/memory-store.js';
import type { Session } from '../src/types.js';

function makeCtx() {
  const session: Session = {
    id: 's1', channel: 'http', userId: 'u1', trustLevel: 'owner', role: 'main',
    agentId: 'default', createdAt: 0, updatedAt: 0, messageCount: 0, settings: {}
  };
  return { session, requestId: 'r1', logger: { debug() {}, info() {}, warn() {}, error() {} } } as any;
}

function getTool(name: string) {
  const memories = new MemoryStore({ capacityPerSession: 100 });
  const t = buildBuiltinTools({ memories }).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

describe('v4.1 new tools', () => {
  it('json.stringify pretty-prints by default', async () => {
    const r = await getTool('json.stringify').execute('{"a":1}', makeCtx());
    expect(r.content).toBe('{\n  "a": 1\n}');
  });

  it('json.stringify minifies with ::min', async () => {
    const r = await getTool('json.stringify').execute('{ "a": 1, "b": 2 }::min', makeCtx());
    expect(r.content).toBe('{"a":1,"b":2}');
  });

  it('json.stringify honors a custom indent', async () => {
    const r = await getTool('json.stringify').execute('{"a":1}::4', makeCtx());
    expect(r.content).toBe('{\n    "a": 1\n}');
  });

  it('json.stringify reports invalid JSON', async () => {
    const r = await getTool('json.stringify').execute('{nope', makeCtx());
    expect(r.error).toBe(true);
  });

  it('text.count counts non-overlapping occurrences', async () => {
    const r = await getTool('text.count').execute('na::banana', makeCtx());
    expect(r.content).toBe('2');
    expect(r.metadata).toEqual({ count: 2 });
  });

  it('text.count returns 0 when absent', async () => {
    const r = await getTool('text.count').execute('z::banana', makeCtx());
    expect(r.content).toBe('0');
  });

  it('text.count rejects missing separator', async () => {
    const r = await getTool('text.count').execute('banana', makeCtx());
    expect(r.error).toBe(true);
  });

  it('number.format adds thousands separators', async () => {
    const r = await getTool('number.format').execute('1234567', makeCtx());
    expect(r.content).toBe('1,234,567');
  });

  it('number.format applies fixed decimals', async () => {
    const r = await getTool('number.format').execute('1234.5::2', makeCtx());
    expect(r.content).toBe('1,234.50');
  });

  it('number.format rejects non-numbers', async () => {
    const r = await getTool('number.format').execute('abc', makeCtx());
    expect(r.error).toBe(true);
  });

  it('text.mask hides all but the last 4 by default', async () => {
    const r = await getTool('text.mask').execute('{"value":"4111111111111234"}', makeCtx());
    expect(r.content).toBe('************1234');
  });

  it('text.mask honors keep and char', async () => {
    const r = await getTool('text.mask').execute('{"value":"secret","keep":2,"char":"#"}', makeCtx());
    expect(r.content).toBe('####et');
  });

  it('text.mask requires a string value', async () => {
    const r = await getTool('text.mask').execute('{"value":123}', makeCtx());
    expect(r.error).toBe(true);
  });
});
