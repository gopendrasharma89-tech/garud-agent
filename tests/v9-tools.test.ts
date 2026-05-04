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

describe('v0.9 new tools', () => {
  it('array.shuffle returns same elements', async () => {
    const r = await getTool('array.shuffle').execute('[1,2,3,4,5]', makeCtx());
    const out = JSON.parse(r.content) as number[];
    expect(out.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('array.head returns first N', async () => {
    const r = await getTool('array.head').execute('[1,2,3,4,5]::3', makeCtx());
    expect(JSON.parse(r.content)).toEqual([1, 2, 3]);
  });

  it('array.tail returns last N', async () => {
    const r = await getTool('array.tail').execute('[1,2,3,4,5]::2', makeCtx());
    expect(JSON.parse(r.content)).toEqual([4, 5]);
  });

  it('text.split splits text', async () => {
    const r = await getTool('text.split').execute('a,b,c::,', makeCtx());
    expect(JSON.parse(r.content)).toEqual(['a', 'b', 'c']);
  });

  it('text.split with empty separator splits chars', async () => {
    const r = await getTool('text.split').execute('abc::', makeCtx());
    expect(JSON.parse(r.content)).toEqual(['a', 'b', 'c']);
  });

  it('text.join joins array', async () => {
    const r = await getTool('text.join').execute('["a","b","c"]::-', makeCtx());
    expect(r.content).toBe('a-b-c');
  });

  it('text.between extracts substring', async () => {
    const r = await getTool('text.between').execute('hello [world] foo::[::]', makeCtx());
    expect(r.content).toBe('world');
  });

  it('text.between handles missing markers', async () => {
    const r = await getTool('text.between').execute('hello world::[::]', makeCtx());
    expect(r.content).toBe('');
  });

  it('text.replaceAll replaces all occurrences', async () => {
    const r = await getTool('text.replaceAll').execute('foo bar foo bar::foo::baz', makeCtx());
    expect(r.content).toBe('baz bar baz bar');
  });

  it('text.escapeHtml escapes special chars', async () => {
    const r = await getTool('text.escapeHtml').execute('<a href="x">&"\'</a>', makeCtx());
    expect(r.content).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&quot;&#39;&lt;/a&gt;');
  });

  it('text.unescapeHtml reverses entities', async () => {
    const r = await getTool('text.unescapeHtml').execute('&lt;a&gt;&amp;&quot;', makeCtx());
    expect(r.content).toBe('<a>&"');
  });

  it('math.percentile computes p50 and p90', async () => {
    expect((await getTool('math.percentile').execute('[1,2,3,4,5]::50', makeCtx())).content).toBe('3');
    expect((await getTool('math.percentile').execute('[1,2,3,4,5,6,7,8,9,10]::90', makeCtx())).content).toBe('9.1');
  });

  it('math.percentile rejects out-of-range p', async () => {
    expect((await getTool('math.percentile').execute('[1,2,3]::150', makeCtx())).error).toBe(true);
  });

  it('math.gcd computes greatest common divisor', async () => {
    expect((await getTool('math.gcd').execute('12::18', makeCtx())).content).toBe('6');
    expect((await getTool('math.gcd').execute('100::75', makeCtx())).content).toBe('25');
  });

  it('math.lcm computes least common multiple', async () => {
    expect((await getTool('math.lcm').execute('4::6', makeCtx())).content).toBe('12');
    expect((await getTool('math.lcm').execute('5::0', makeCtx())).content).toBe('0');
  });

  it('uuid.validate accepts v4 UUIDs', async () => {
    expect((await getTool('uuid.validate').execute('550e8400-e29b-41d4-a716-446655440000', makeCtx())).content).toBe('true');
    expect((await getTool('uuid.validate').execute('not-a-uuid', makeCtx())).content).toBe('false');
  });

  it('array.intersect is type-aware (1 vs "1")', async () => {
    const r = await getTool('array.intersect').execute('[1,2,3]::["1","2"]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([]);
  });

  it('array.diff is type-aware', async () => {
    const r = await getTool('array.diff').execute('[1,2,"3"]::["1",2]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([1, '3']);
  });

  it('text.padLeft supports multi-char pad', async () => {
    const r = await getTool('text.padLeft').execute('x::8::ab', makeCtx());
    expect(r.content).toBe('abababax');
  });

  it('validate.email rejects "a@b.c" (TLD too short)', async () => {
    expect((await getTool('validate.email').execute('a@b.c', makeCtx())).content).toBe('false');
    expect((await getTool('validate.email').execute('user@example.com', makeCtx())).content).toBe('true');
  });
});
