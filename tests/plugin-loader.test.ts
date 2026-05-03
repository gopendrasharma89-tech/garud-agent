import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/core/memory-store.js';
import { PluginLoader } from '../src/plugins/plugin-loader.js';
import { noopLogger } from '../src/utils/logger.js';

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length) {
    const dir = cleanup.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makePluginDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'garud-plugin-'));
  cleanup.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

describe('PluginLoader', () => {
  it('loads tools from a JS plugin module', async () => {
    const dir = await makePluginDir({
      'hello.mjs': `
        export default function factory(deps) {
          return [{
            name: 'plugin.hello',
            description: 'hello from plugin',
            execute: () => ({ content: 'hi from ' + (deps.config?.who ?? 'plugin') })
          }];
        }
      `
    });
    const loader = new PluginLoader(new MemoryStore(), noopLogger);
    const loaded = await loader.loadAll([
      { id: 'hello', module: './hello.mjs', config: { who: 'tester' } }
    ], dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.tools).toHaveLength(1);
    expect(loaded[0]?.tools[0]?.name).toBe('plugin.hello');
  });

  it('skips disabled plugins', async () => {
    const dir = await makePluginDir({
      'a.mjs': 'export default function() { return []; }'
    });
    const loader = new PluginLoader(new MemoryStore(), noopLogger);
    const loaded = await loader.loadAll([
      { id: 'a', module: './a.mjs', enabled: false }
    ], dir);
    expect(loaded).toHaveLength(0);
  });

  it('isolates failures from a single plugin', async () => {
    const dir = await makePluginDir({
      'good.mjs': 'export default () => [{ name: "good", description: "g", execute: () => ({ content: "ok" }) }];',
      'bad.mjs': 'export default () => { throw new Error("boom"); };'
    });
    const loader = new PluginLoader(new MemoryStore(), noopLogger);
    const loaded = await loader.loadAll([
      { id: 'bad', module: './bad.mjs' },
      { id: 'good', module: './good.mjs' }
    ], dir);
    expect(loaded.map((p) => p.id)).toEqual(['good']);
  });

  it('rejects modules without a default export', async () => {
    const dir = await makePluginDir({
      'noexport.mjs': 'export const a = 1;'
    });
    const loader = new PluginLoader(new MemoryStore(), noopLogger);
    const loaded = await loader.loadAll([
      { id: 'x', module: './noexport.mjs' }
    ], dir);
    expect(loaded).toHaveLength(0);
  });

  it('rejects factories that do not return arrays', async () => {
    const dir = await makePluginDir({
      'wrong.mjs': 'export default () => "not an array";'
    });
    const loader = new PluginLoader(new MemoryStore(), noopLogger);
    const loaded = await loader.loadAll([
      { id: 'x', module: './wrong.mjs' }
    ], dir);
    expect(loaded).toHaveLength(0);
  });
});
