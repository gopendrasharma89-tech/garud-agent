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

describe('v4.2 new tools', () => {
  it('number.clamp clamps within range', async () => {
    expect((await getTool('number.clamp').execute('5::0::10', makeCtx())).content).toBe('5');
    expect((await getTool('number.clamp').execute('-3::0::10', makeCtx())).content).toBe('0');
    expect((await getTool('number.clamp').execute('99::0::10', makeCtx())).content).toBe('10');
  });
  it('number.clamp rejects bad input', async () => {
    expect((await getTool('number.clamp').execute('5::10::0', makeCtx())).error).toBe(true);
    expect((await getTool('number.clamp').execute('5', makeCtx())).error).toBe(true);
  });

  it('number.round rounds to decimals', async () => {
    expect((await getTool('number.round').execute('3.14159::2', makeCtx())).content).toBe('3.14');
    expect((await getTool('number.round').execute('2.5', makeCtx())).content).toBe('3');
    expect((await getTool('number.round').execute('1.005::2', makeCtx())).content).toBe('1.01');
  });
  it('number.round rejects non-numbers', async () => {
    expect((await getTool('number.round').execute('nope', makeCtx())).error).toBe(true);
  });

  it('time.duration humanizes ms', async () => {
    expect((await getTool('time.duration').execute('0', makeCtx())).content).toBe('0s');
    expect((await getTool('time.duration').execute('1000', makeCtx())).content).toBe('1s');
    expect((await getTool('time.duration').execute('90061000', makeCtx())).content).toBe('1d 1h 1m 1s');
  });
  it('time.duration rejects negatives', async () => {
    expect((await getTool('time.duration').execute('-5', makeCtx())).error).toBe(true);
  });

  it('url.build appends query params', async () => {
    const r = await getTool('url.build').execute('{"base":"https://x.io/p","query":{"a":"1","b":2}}', makeCtx());
    expect(r.content).toBe('https://x.io/p?a=1&b=2');
  });
  it('url.build requires a base', async () => {
    expect((await getTool('url.build').execute('{"query":{"a":"1"}}', makeCtx())).error).toBe(true);
  });

  it('csv.stringify quotes when needed', async () => {
    const r = await getTool('csv.stringify').execute('[["a","b"],["x,y","z\\"q"]]', makeCtx());
    expect(r.content).toBe('a,b\n"x,y","z""q"');
  });
  it('csv.stringify rejects non-array-of-arrays', async () => {
    expect((await getTool('csv.stringify').execute('{"a":1}', makeCtx())).error).toBe(true);
  });

  it('string.template renders keys', async () => {
    const r = await getTool('string.template').execute('{"template":"Hi {{name}}, {{n}} msgs","data":{"name":"Ada","n":3}}', makeCtx());
    expect(r.content).toBe('Hi Ada, 3 msgs');
  });
  it('string.template blanks missing keys', async () => {
    const r = await getTool('string.template').execute('{"template":"[{{x}}]","data":{}}', makeCtx());
    expect(r.content).toBe('[]');
  });

  it('list.range generates ranges', async () => {
    expect((await getTool('list.range').execute('3', makeCtx())).content).toBe('[0,1,2]');
    expect((await getTool('list.range').execute('2::5', makeCtx())).content).toBe('[2,3,4]');
    expect((await getTool('list.range').execute('10::0::-5', makeCtx())).content).toBe('[10,5]');
  });
  it('list.range guards zero step and huge ranges', async () => {
    expect((await getTool('list.range').execute('0::5::0', makeCtx())).error).toBe(true);
    expect((await getTool('list.range').execute('0::1000000', makeCtx())).error).toBe(true);
  });
});
