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

describe('v1.0 new tools', () => {
  it('array.shuffle handles empty array', async () => {
    const r = await getTool('array.shuffle').execute('[]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([]);
  });

  it('array.shuffle handles single element', async () => {
    const r = await getTool('array.shuffle').execute('[42]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([42]);
  });

  it('array.groupBy groups by key path', async () => {
    const r = await getTool('array.groupBy').execute(
      '[{"type":"a","v":1},{"type":"b","v":2},{"type":"a","v":3}]::type',
      makeCtx()
    );
    const groups = JSON.parse(r.content) as Record<string, unknown[]>;
    expect(groups.a).toHaveLength(2);
    expect(groups.b).toHaveLength(1);
  });

  it('text.title capitalizes each word', async () => {
    const r = await getTool('text.title').execute('hello world foo', makeCtx());
    expect(r.content).toBe('Hello World Foo');
  });

  it('text.camel converts to camelCase', async () => {
    expect((await getTool('text.camel').execute('hello world foo', makeCtx())).content).toBe('helloWorldFoo');
    expect((await getTool('text.camel').execute('hello-world-foo', makeCtx())).content).toBe('helloWorldFoo');
    expect((await getTool('text.camel').execute('hello_world_foo', makeCtx())).content).toBe('helloWorldFoo');
  });

  it('text.snake converts to snake_case', async () => {
    expect((await getTool('text.snake').execute('helloWorld', makeCtx())).content).toBe('hello_world');
    expect((await getTool('text.snake').execute('Hello-World Foo', makeCtx())).content).toBe('hello_world_foo');
  });

  it('text.kebab converts to kebab-case', async () => {
    expect((await getTool('text.kebab').execute('helloWorld', makeCtx())).content).toBe('hello-world');
    expect((await getTool('text.kebab').execute('Hello_World Foo', makeCtx())).content).toBe('hello-world-foo');
  });

  it('math.factorial computes correctly', async () => {
    expect((await getTool('math.factorial').execute('0', makeCtx())).content).toBe('1');
    expect((await getTool('math.factorial').execute('5', makeCtx())).content).toBe('120');
    expect((await getTool('math.factorial').execute('10', makeCtx())).content).toBe('3628800');
  });

  it('math.factorial rejects out-of-range', async () => {
    expect((await getTool('math.factorial').execute('-1', makeCtx())).error).toBe(true);
    expect((await getTool('math.factorial').execute('1500', makeCtx())).error).toBe(true);
  });

  it('math.fibonacci computes correctly', async () => {
    expect((await getTool('math.fibonacci').execute('0', makeCtx())).content).toBe('0');
    expect((await getTool('math.fibonacci').execute('1', makeCtx())).content).toBe('1');
    expect((await getTool('math.fibonacci').execute('10', makeCtx())).content).toBe('55');
    expect((await getTool('math.fibonacci').execute('20', makeCtx())).content).toBe('6765');
  });

  it('math.isPrime checks primality', async () => {
    expect((await getTool('math.isPrime').execute('2', makeCtx())).content).toBe('true');
    expect((await getTool('math.isPrime').execute('3', makeCtx())).content).toBe('true');
    expect((await getTool('math.isPrime').execute('4', makeCtx())).content).toBe('false');
    expect((await getTool('math.isPrime').execute('17', makeCtx())).content).toBe('true');
    expect((await getTool('math.isPrime').execute('100', makeCtx())).content).toBe('false');
    expect((await getTool('math.isPrime').execute('997', makeCtx())).content).toBe('true');
    expect((await getTool('math.isPrime').execute('1', makeCtx())).content).toBe('false');
    expect((await getTool('math.isPrime').execute('0', makeCtx())).content).toBe('false');
  });
});
