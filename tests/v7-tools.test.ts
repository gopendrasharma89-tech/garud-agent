import { describe, it, expect } from 'vitest';
import { buildBuiltinTools } from '../src/tools/builtin-tools.js';
import { MemoryStore } from '../src/core/memory-store.js';
import type { Session } from '../src/types.js';

function makeCtx() {
  const session: Session = {
    id: 's1', channel: 'http', userId: 'u1', trustLevel: 'owner', role: 'main',
    agentId: 'default', createdAt: 0, updatedAt: 0, messageCount: 0, settings: {}
  };
  return { session, requestId: 'r1', logger: { debug() {}, info() {}, warn() {}, error() {} } };
}

function getTool(name: string) {
  const memories = new MemoryStore({ capacityPerSession: 100 });
  const tools = buildBuiltinTools({ memories });
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

describe('v0.7 new tools', () => {
  it('array.sort sorts ascending strings', async () => {
    const tool = getTool('array.sort');
    const r = await tool.execute('["c","a","b"]::asc', makeCtx());
    expect(JSON.parse(r.content)).toEqual(['a', 'b', 'c']);
  });

  it('array.sort sorts numerically', async () => {
    const tool = getTool('array.sort');
    const r = await tool.execute('[10,2,1,20]::num-asc', makeCtx());
    expect(JSON.parse(r.content)).toEqual([1, 2, 10, 20]);
  });

  it('array.chunk splits into batches', async () => {
    const tool = getTool('array.chunk');
    const r = await tool.execute('[1,2,3,4,5]::2', makeCtx());
    expect(JSON.parse(r.content)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('array.zip pairs elements', async () => {
    const tool = getTool('array.zip');
    const r = await tool.execute('["a","b","c"]::[1,2,3]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([['a', 1], ['b', 2], ['c', 3]]);
  });

  it('array.flatten supports depth parameter', async () => {
    const tool = getTool('array.flatten');
    const r = await tool.execute('[[1,[2,[3]]],[4]]::2', makeCtx());
    expect(JSON.parse(r.content)).toEqual([1, 2, [3], 4]);
  });

  it('array.flatten infinite depth via 32', async () => {
    const tool = getTool('array.flatten');
    const r = await tool.execute('[1,[2,[3,[4,[5]]]]]::32', makeCtx());
    expect(JSON.parse(r.content)).toEqual([1, 2, 3, 4, 5]);
  });

  it('text.wordcount counts words/chars/lines', async () => {
    const tool = getTool('text.wordcount');
    const r = await tool.execute('hello world\nfoo bar', makeCtx());
    const obj = JSON.parse(r.content);
    expect(obj.words).toBe(4);
    expect(obj.lines).toBe(2);
  });

  it('text.truncate adds ellipsis', async () => {
    const tool = getTool('text.truncate');
    const r = await tool.execute('Hello World::5', makeCtx());
    expect(r.content).toBe('Hell\u2026');
  });

  it('text.truncate returns original if short', async () => {
    const tool = getTool('text.truncate');
    const r = await tool.execute('hi::100', makeCtx());
    expect(r.content).toBe('hi');
  });

  it('text.repeat repeats string', async () => {
    const tool = getTool('text.repeat');
    const r = await tool.execute('ab::3', makeCtx());
    expect(r.content).toBe('ababab');
  });

  it('text.repeat rejects oversized output', async () => {
    const tool = getTool('text.repeat');
    const r = await tool.execute('abc::500000', makeCtx());
    expect(r.error).toBe(true);
  });

  it('math.stats computes summary correctly', async () => {
    const tool = getTool('math.stats');
    const r = await tool.execute('[1,2,3,4,5]', makeCtx());
    const s = JSON.parse(r.content);
    expect(s.count).toBe(5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.mean).toBe(3);
    expect(s.median).toBe(3);
    expect(s.sum).toBe(15);
    expect(s.stddev).toBeCloseTo(Math.sqrt(2), 5);
  });

  it('math.stats handles even-length median', async () => {
    const tool = getTool('math.stats');
    const r = await tool.execute('[1,2,3,4]', makeCtx());
    expect(JSON.parse(r.content).median).toBe(2.5);
  });

  it('json.merge deep-merges objects', async () => {
    const tool = getTool('json.merge');
    const r = await tool.execute('{"a":1,"b":{"x":10}}::{"b":{"y":20},"c":3}', makeCtx());
    expect(JSON.parse(r.content)).toEqual({ a: 1, b: { x: 10, y: 20 }, c: 3 });
  });

  it('json.diff finds added/removed/changed', async () => {
    const tool = getTool('json.diff');
    const r = await tool.execute('{"a":1,"b":2,"c":3}::{"a":1,"b":99,"d":4}', makeCtx());
    const d = JSON.parse(r.content);
    expect(d.added).toEqual(['d']);
    expect(d.removed).toEqual(['c']);
    expect(d.changed).toEqual(['b']);
  });

  it('color.parse handles 3-char hex', async () => {
    const tool = getTool('color.parse');
    const r = await tool.execute('#f0a', makeCtx());
    const c = JSON.parse(r.content);
    expect(c.r).toBe(255);
    expect(c.g).toBe(0);
    expect(c.b).toBe(170);
    expect(c.hex).toBe('#ff00aa');
  });

  it('color.parse handles 6-char hex', async () => {
    const tool = getTool('color.parse');
    const r = await tool.execute('#336699', makeCtx());
    const c = JSON.parse(r.content);
    expect(c.r).toBe(51);
    expect(c.g).toBe(102);
    expect(c.b).toBe(153);
    expect(c.rgba).toBe('rgba(51,102,153,1)');
  });

  it('color.parse rejects invalid input', async () => {
    const tool = getTool('color.parse');
    const r = await tool.execute('not-a-color', makeCtx());
    expect(r.error).toBe(true);
  });

  it('time.format supports rfc2822 and long', async () => {
    const tool = getTool('time.format');
    const r1 = await tool.execute('1735689600000::rfc2822', makeCtx());
    expect(r1.content).toContain('GMT');
    const r2 = await tool.execute('1735689600000::long', makeCtx());
    expect(r2.content).toBe('2025-01-01 00:00:00 UTC');
  });
});
