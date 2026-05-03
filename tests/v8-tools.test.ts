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

describe('v0.8 new tools', () => {
  it('array.range generates ascending range', async () => {
    const r = await getTool('array.range').execute('0::5', makeCtx());
    expect(JSON.parse(r.content)).toEqual([0, 1, 2, 3, 4]);
  });

  it('array.range with step', async () => {
    const r = await getTool('array.range').execute('0::10::2', makeCtx());
    expect(JSON.parse(r.content)).toEqual([0, 2, 4, 6, 8]);
  });

  it('array.range descending', async () => {
    const r = await getTool('array.range').execute('5::0::-1', makeCtx());
    expect(JSON.parse(r.content)).toEqual([5, 4, 3, 2, 1]);
  });

  it('array.intersect finds common items', async () => {
    const r = await getTool('array.intersect').execute('[1,2,3,4]::[2,4,6]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([2, 4]);
  });

  it('array.diff finds left-only items', async () => {
    const r = await getTool('array.diff').execute('[1,2,3,4]::[2,4]', makeCtx());
    expect(JSON.parse(r.content)).toEqual([1, 3]);
  });

  it('text.padLeft pads with default space', async () => {
    const r = await getTool('text.padLeft').execute('42::5', makeCtx());
    expect(r.content).toBe('   42');
  });

  it('text.padLeft pads with custom char', async () => {
    const r = await getTool('text.padLeft').execute('42::5::0', makeCtx());
    expect(r.content).toBe('00042');
  });

  it('text.padRight pads on right', async () => {
    const r = await getTool('text.padRight').execute('hi::5::-', makeCtx());
    expect(r.content).toBe('hi---');
  });

  it('text.indent indents non-empty lines', async () => {
    const r = await getTool('text.indent').execute('a\n\nb::2', makeCtx());
    expect(r.content).toBe('  a\n\n  b');
  });

  it('math.round rounds with default 0 decimals', async () => {
    const r = await getTool('math.round').execute('3.7', makeCtx());
    expect(r.content).toBe('4');
  });

  it('math.round rounds to N decimals', async () => {
    const r = await getTool('math.round').execute('3.14159::2', makeCtx());
    expect(r.content).toBe('3.14');
  });

  it('math.clamp clamps within range', async () => {
    expect((await getTool('math.clamp').execute('15::0::10', makeCtx())).content).toBe('10');
    expect((await getTool('math.clamp').execute('-5::0::10', makeCtx())).content).toBe('0');
    expect((await getTool('math.clamp').execute('5::0::10', makeCtx())).content).toBe('5');
  });

  it('geo.distance computes Haversine in km', async () => {
    // London to Paris ~ 343 km
    const r = await getTool('geo.distance').execute('51.5074,-0.1278::48.8566,2.3522', makeCtx());
    const km = Number(r.content);
    expect(km).toBeGreaterThan(330);
    expect(km).toBeLessThan(360);
  });

  it('crypto.randomString returns alphanumeric of length N', async () => {
    const r = await getTool('crypto.randomString').execute('32', makeCtx());
    expect(r.content).toHaveLength(32);
    expect(r.content).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('crypto.randomString rejects out-of-range length', async () => {
    expect((await getTool('crypto.randomString').execute('0', makeCtx())).error).toBe(true);
    expect((await getTool('crypto.randomString').execute('999', makeCtx())).error).toBe(true);
  });

  it('validate.email accepts valid emails', async () => {
    expect((await getTool('validate.email').execute('user@example.com', makeCtx())).content).toBe('true');
    expect((await getTool('validate.email').execute('not-an-email', makeCtx())).content).toBe('false');
  });

  it('validate.url accepts valid URLs', async () => {
    expect((await getTool('validate.url').execute('https://example.com', makeCtx())).content).toBe('true');
    expect((await getTool('validate.url').execute('not a url', makeCtx())).content).toBe('false');
  });

  it('validate.ipv4 validates IPv4 strings', async () => {
    expect((await getTool('validate.ipv4').execute('192.168.1.1', makeCtx())).content).toBe('true');
    expect((await getTool('validate.ipv4').execute('256.0.0.1', makeCtx())).content).toBe('false');
    expect((await getTool('validate.ipv4').execute('1.2.3', makeCtx())).content).toBe('false');
  });

  it('text.truncate handles text containing ::', async () => {
    // Bug fix: input with internal "::" should still parse correctly when trailing ::N
    const r = await getTool('text.truncate').execute('a::b::c::5', makeCtx());
    expect(r.content).toBe('a::b\u2026');
  });

  it('text.repeat handles text containing ::', async () => {
    const r = await getTool('text.repeat').execute('a::b::3', makeCtx());
    expect(r.content).toBe('a::ba::ba::b');
  });
});
