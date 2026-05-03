import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/core/memory-store.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { buildBuiltinTools } from '../src/tools/builtin-tools.js';
import { Session } from '../src/types.js';
import { noopLogger } from '../src/utils/logger.js';

const session: Session = {
  id: 's1', channel: 'http', userId: 'u1', trustLevel: 'owner', role: 'main', agentId: 'main',
  createdAt: 0, updatedAt: 0, messageCount: 0, settings: {}
};

function context() {
  return { session, requestText: '', now: 0, log: noopLogger, signal: new AbortController().signal };
}

function makeRegistry(memories: MemoryStore = new MemoryStore()): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of buildBuiltinTools({ memories })) reg.register(t);
  return reg;
}

describe('buildBuiltinTools', () => {
  it('memory.save persists into the store', async () => {
    const memories = new MemoryStore();
    const reg = makeRegistry(memories);
    const result = await reg.invoke('memory.save', 'remember me', context());
    expect(result.error).toBeFalsy();
    expect(memories.list('s1').length).toBe(1);
  });

  it('memory.save rejects empty input', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('memory.save', '   ', context());
    expect(result.error).toBe(true);
  });

  it('memory.search returns hits when present', async () => {
    const memories = new MemoryStore();
    memories.save('s1', 'project alpha', [], 0.8);
    const reg = makeRegistry(memories);
    const result = await reg.invoke('memory.search', 'alpha', context());
    expect(result.content).toContain('alpha');
  });

  it('memory.list respects limit', async () => {
    const memories = new MemoryStore();
    for (let i = 0; i < 10; i++) memories.save('s1', `note-${i}`);
    const reg = makeRegistry(memories);
    const result = await reg.invoke('memory.list', '3', context());
    expect((result.content.match(/•/g) ?? []).length).toBe(3);
  });

  it('memory.forget removes by id', async () => {
    const memories = new MemoryStore();
    const m = memories.save('s1', 'remove me');
    const reg = makeRegistry(memories);
    const result = await reg.invoke('memory.forget', m.id, context());
    expect(result.content).toBe('forgotten');
  });

  it('memory.pin/unpin toggle the flag', async () => {
    const memories = new MemoryStore();
    const m = memories.save('s1', 'pin me');
    const reg = makeRegistry(memories);
    expect((await reg.invoke('memory.pin', m.id, context())).content).toContain('pinned');
    expect(memories.get(m.id)?.pinned).toBe(true);
    expect((await reg.invoke('memory.unpin', m.id, context())).content).toContain('unpinned');
    expect(memories.get(m.id)?.pinned).toBe(false);
  });

  it('memory.searchAll matches across sessions', async () => {
    const memories = new MemoryStore();
    memories.save('s1', 'shared topic alpha');
    memories.save('s2', 'another mention of alpha');
    const reg = makeRegistry(memories);
    const result = await reg.invoke('memory.searchAll', 'alpha', context());
    expect(result.content).toContain('alpha');
  });

  it('time.now returns ISO string', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('time.now', '', context());
    expect(result.content).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('time.now is reachable via alias "now"', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('now', '', context());
    expect(result.content).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('echo returns input unchanged', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('echo', 'hello!', context());
    expect(result.content).toBe('hello!');
  });

  it('math.eval evaluates safely', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('math.eval', '(2 + 3) * 4', context());
    expect(result.content).toBe('20');
  });

  it('math.eval reachable via "calc" alias', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('calc', '7 * 8', context());
    expect(result.content).toBe('56');
  });

  it('math.eval reports errors', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('math.eval', '5 / 0', context());
    expect(result.error).toBe(true);
  });

  it('http.fetch rejects bad URLs', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('http.fetch', 'ftp://bad', context());
    expect(result.error).toBe(true);
  });

  it('session.info returns session metadata', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('session.info', '', context());
    const parsed = JSON.parse(result.content);
    expect(parsed.id).toBe('s1');
    expect(parsed.agentId).toBe('main');
  });

  it('random.uuid produces a valid v4 UUID', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('random.uuid', '', context());
    expect(result.content).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('random.number produces values within range', async () => {
    const reg = makeRegistry();
    for (let i = 0; i < 20; i++) {
      const result = await reg.invoke('random.number', '5 7', context());
      const value = Number(result.content);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(7);
    }
  });

  it('random.bytes produces expected length hex', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('random.bytes', '8', context());
    expect(result.content).toMatch(/^[0-9a-f]{16}$/);
  });

  it('base64.encode/decode round trips', async () => {
    const reg = makeRegistry();
    const encoded = await reg.invoke('base64.encode', 'hello world', context());
    expect(encoded.content).toBe('aGVsbG8gd29ybGQ=');
    const decoded = await reg.invoke('base64.decode', encoded.content, context());
    expect(decoded.content).toBe('hello world');
  });

  it('hash.sha256 is deterministic', async () => {
    const reg = makeRegistry();
    const a = await reg.invoke('hash.sha256', 'hello', context());
    const b = await reg.invoke('hash.sha256', 'hello', context());
    expect(a.content).toBe(b.content);
    expect(a.content).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash.md5 returns 32 hex chars', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('hash.md5', 'hello', context());
    expect(result.content).toMatch(/^[0-9a-f]{32}$/);
  });

  it('json.parse pretty-prints valid JSON', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('json.parse', '{"a":1,"b":[2,3]}', context());
    expect(result.content).toContain('"a": 1');
  });

  it('regex.match returns matches', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('regex.match', '\\d+::there are 4 cats and 7 dogs', context());
    expect(JSON.parse(result.content)).toEqual(['4', '7']);
  });

  it('regex.replace substitutes globally', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('regex.replace', 'cat::dog::a cat saw a cat', context());
    expect(result.content).toBe('a dog saw a dog');
  });

  it('url.parse decodes a URL', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('url.parse', 'https://example.com:8080/path?x=1', context());
    const parsed = JSON.parse(result.content);
    expect(parsed.hostname).toBe('example.com');
    expect(parsed.port).toBe('8080');
  });

  it('url.encode/decode round trip', async () => {
    const reg = makeRegistry();
    const encoded = await reg.invoke('url.encode', 'hello world&x=1', context());
    expect(encoded.content).toBe('hello%20world%26x%3D1');
    const decoded = await reg.invoke('url.decode', encoded.content, context());
    expect(decoded.content).toBe('hello world&x=1');
  });

  it('date.parse returns ISO and unix', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('date.parse', '2024-01-01T00:00:00Z', context());
    expect(result.content).toBe('2024-01-01T00:00:00.000Z');
  });

  it('date.add adds intervals to a base time', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('date.add', '2024-01-01T00:00:00Z::1h', context());
    expect(result.content).toBe('2024-01-01T01:00:00.000Z');
  });

  it('text.length reports counts', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('text.length', 'hello world', context());
    const parsed = JSON.parse(result.content);
    expect(parsed.chars).toBe(11);
    expect(parsed.words).toBe(2);
  });

  it('text.upper / text.lower / text.reverse work', async () => {
    const reg = makeRegistry();
    expect((await reg.invoke('text.upper', 'hello', context())).content).toBe('HELLO');
    expect((await reg.invoke('text.lower', 'WoRLD', context())).content).toBe('world');
    expect((await reg.invoke('text.reverse', 'abcd', context())).content).toBe('dcba');
  });

  it('text.diff produces unified-style diff', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('text.diff', 'one\ntwo::one\nthree', context());
    expect(result.content).toContain('- two');
    expect(result.content).toContain('+ three');
  });

  it('text.normalize defaults to NFC', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('text.normalize', 'caf\u00e9', context());
    expect(result.content).toBe('café');
  });

  it('csv.parse turns CSV into JSON rows', async () => {
    const reg = makeRegistry();
    const result = await reg.invoke('csv.parse', 'name,age\nalice,30\nbob,25', context());
    const parsed = JSON.parse(result.content);
    expect(parsed).toEqual([{ name: 'alice', age: '30' }, { name: 'bob', age: '25' }]);
  });

  it('password.hash and password.verify round trip', async () => {
    const reg = makeRegistry();
    const hashed = await reg.invoke('password.hash', 'secret123', context());
    expect(hashed.content).toMatch(/^[0-9a-f]+\$[0-9a-f]+$/);
    const ok = await reg.invoke('password.verify', `secret123::${hashed.content}`, context());
    expect(ok.content).toBe('true');
    const bad = await reg.invoke('password.verify', `wrong::${hashed.content}`, context());
    expect(bad.content).toBe('false');
  });

  it('crypto.encrypt/crypto.decrypt round trip', async () => {
    const reg = makeRegistry();
    const enc = await reg.invoke('crypto.encrypt', 'pass-phrase::hello secret', context());
    expect(enc.content).toMatch(/^[0-9a-f]+$/);
    const dec = await reg.invoke('crypto.decrypt', `pass-phrase::${enc.content}`, context());
    expect(dec.content).toBe('hello secret');
  });

  it('crypto.decrypt fails on wrong key', async () => {
    const reg = makeRegistry();
    const enc = await reg.invoke('crypto.encrypt', 'pass-phrase::hello secret', context());
    const dec = await reg.invoke('crypto.decrypt', `wrong-key::${enc.content}`, context());
    expect(dec.error).toBe(true);
  });
});
