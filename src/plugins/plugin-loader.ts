import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Logger, PluginEntry, ToolDefinition } from '../types.js';
import { MemoryStore } from '../core/memory-store.js';
import { noopLogger } from '../utils/logger.js';

export interface PluginDeps {
  memories: MemoryStore;
  logger: Logger;
  config?: Record<string, unknown>;
}

export type PluginFactory = (deps: PluginDeps) => ToolDefinition[] | Promise<ToolDefinition[]>;

export interface LoadedPlugin {
  id: string;
  tools: ToolDefinition[];
}

export class PluginLoader {
  constructor(
    private readonly memories: MemoryStore,
    private readonly logger: Logger = noopLogger
  ) {}

  async loadAll(entries: PluginEntry[], baseDir: string): Promise<LoadedPlugin[]> {
    const loaded: LoadedPlugin[] = [];
    for (const entry of entries) {
      if (entry.enabled === false) continue;
      try {
        const tools = await this.loadOne(entry, baseDir);
        loaded.push({ id: entry.id, tools });
        this.logger.info('plugin loaded', { id: entry.id, tools: tools.length });
      } catch (error) {
        this.logger.warn('plugin failed', {
          id: entry.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return loaded;
  }

  async loadOne(entry: PluginEntry, baseDir: string): Promise<ToolDefinition[]> {
    const resolved = path.isAbsolute(entry.module)
      ? entry.module
      : path.resolve(baseDir, entry.module);
    const url = pathToFileURL(resolved).href;
    const mod = await import(url) as { default?: PluginFactory };
    const factory = mod.default;
    if (typeof factory !== 'function') {
      throw new Error(`Plugin ${entry.id} has no default export factory`);
    }
    const tools = await factory({
      memories: this.memories,
      logger: this.logger.child(`plugin:${entry.id}`),
      config: entry.config
    });
    if (!Array.isArray(tools)) {
      throw new Error(`Plugin ${entry.id} did not return an array of tools`);
    }
    return tools;
  }
}
