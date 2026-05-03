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

describe('v0.6 new tools', () => {
  it('text.slugify converts to URL-safe slug', async () => {
    const tool = getTool('text.slugify');
    const r = await tool.execute('Hello World!! 2026', makeCtx());
    expect(r.content).toBe('hello-world-2026');
  });

  it('text.slugify handles unicode + diacritics', async () => {
    const tool = getTool('text.slugify');
    const r = await tool.execute('Café — Résumé', makeCtx());
    expect(r.content).toBe('cafe-resume');
  });

  it('text.template renders {{var}}', async () => {
    const tool = getTool('text.template');
    const r = await tool.execute('Hi {{name}}, you are {{age}}::{"name":"Garud","age":42}', makeCtx());
    expect(r.content).toBe('Hi Garud, you are 42');
  });

  it('text.template supports nested paths', async () => {
    const tool = getTool('text.template');
    const r = await tool.execute('User: {{user.name}}::{"user":{"name":"alice"}}', makeCtx());
    expect(r.content).toBe('User: alice');
  });

  it('text.template handles missing keys safely', async () => {
    const tool = getTool('text.template');
    const r = await tool.execute('Hi {{missing}}::{}', makeCtx());
    expect(r.content).toBe('Hi ');
  });

  it('string.distance computes Levenshtein', async () => {
    const tool = getTool('string.distance');
    expect((await tool.execute('kitten::sitting', makeCtx())).content).toBe('3');
    expect((await tool.execute('abc::abc', makeCtx())).content).toBe('0');
    expect((await tool.execute('::abc', makeCtx())).content).toBe('3');
  });

  it('json.path extracts nested values', async () => {
    const tool = getTool('json.path');
    const r = await tool.execute('{"a":{"b":[10,20,30]}}::a.b.1', makeCtx());
    expect(r.content).toBe('20');
  });

  it('json.path returns null for missing', async () => {
    const tool = getTool('json.path');
    const r = await tool.execute('{"a":1}::b.c', makeCtx());
    // path traversal hits null when key 'b' is missing on object {a:1} -> returns 'null'
    expect(['null', 'undefined']).toContain(r.content);
  });

  it('array.unique dedupes JSON array', async () => {
    const tool = getTool('array.unique');
    const r = await tool.execute('[1,2,2,3,3,3,4]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([1, 2, 3, 4]);
  });

  it('array.unique handles object equality', async () => {
    const tool = getTool('array.unique');
    const r = await tool.execute('[{"a":1},{"a":1},{"a":2}]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('array.flatten flattens one level', async () => {
    const tool = getTool('array.flatten');
    const r = await tool.execute('[[1,2],[3,4],5]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([1, 2, 3, 4, 5]);
  });

  it('random.pick selects from array', async () => {
    const tool = getTool('random.pick');
    const r = await tool.execute('["a","b","c"]', makeCtx());
    expect(['a', 'b', 'c']).toContain(r.content);
  });

  it('random.pick errors on empty array', async () => {
    const tool = getTool('random.pick');
    const r = await tool.execute('[]', makeCtx());
    expect(r.error).toBe(true);
  });

  it('time.diff computes ms between dates', async () => {
    const tool = getTool('time.diff');
    const r = await tool.execute('2026-01-01T00:00:00Z::2026-01-01T00:00:01Z', makeCtx());
    expect(r.content).toBe('1000');
  });

  it('time.format formats epoch ms as iso/date/time/unix', async () => {
    const tool = getTool('time.format');
    expect((await tool.execute('1735689600000::iso', makeCtx())).content).toBe('2025-01-01T00:00:00.000Z');
    expect((await tool.execute('1735689600000::date', makeCtx())).content).toBe('2025-01-01');
    expect((await tool.execute('1735689600000::unix', makeCtx())).content).toBe('1735689600');
  });

  it('time.format errors on invalid timestamp', async () => {
    const tool = getTool('time.format');
    const r = await tool.execute('not-a-date::iso', makeCtx());
    expect(r.error).toBe(true);
  });
});
