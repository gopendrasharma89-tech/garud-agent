import { Logger, ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { suggestClosest } from '../utils/text.js';
import { TimeoutError, withTimeout } from '../utils/timeout.js';

export interface ToolInvokeOptions {
  timeoutMs?: number;
  logger?: Logger;
  sandbox?: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly aliases = new Map<string, string>();

  register(tool: ToolDefinition): void {
    if (!tool.name) throw new Error('Tool name is required');
    // Atomically validate everything BEFORE mutating internal maps.
    if (this.tools.has(tool.name) || this.aliases.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    for (const alias of tool.aliases ?? []) {
      if (this.tools.has(alias) || this.aliases.has(alias)) {
        throw new Error(`Alias already in use: ${alias}`);
      }
    }
    // Now commit.
    this.tools.set(tool.name, tool);
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
    }
  }

  /** Replace or add a tool, cleaning up stale aliases. */
  upsert(tool: ToolDefinition): void {
    if (!tool.name) throw new Error('Tool name is required');
    // Validate alias collisions against tools/aliases not owned by this name.
    for (const alias of tool.aliases ?? []) {
      const aliasOwner = this.aliases.get(alias);
      if (aliasOwner && aliasOwner !== tool.name) {
        throw new Error(`Alias already in use by another tool: ${alias}`);
      }
      if (this.tools.has(alias) && alias !== tool.name) {
        throw new Error(`Alias collides with existing tool: ${alias}`);
      }
    }
    // Remove existing aliases pointing to the same canonical name.
    for (const [alias, target] of [...this.aliases]) {
      if (target === tool.name) this.aliases.delete(alias);
    }
    this.tools.set(tool.name, tool);
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
    }
  }

  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      for (const [alias, target] of [...this.aliases]) {
        if (target === name) this.aliases.delete(alias);
      }
    }
    return removed;
  }

  resolveName(name: string): string {
    return this.aliases.get(name) ?? name;
  }

  get(name: string): ToolDefinition | undefined {
    const canonical = this.resolveName(name);
    return this.tools.get(canonical);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  listByTags(tags: string[]): ToolDefinition[] {
    if (!tags.length) return this.list();
    return this.list().filter((t) => t.tags?.some((tag) => tags.includes(tag)));
  }

  /** Suggest the closest tool name (canonical or alias) for a typo. */
  suggest(name: string): string | undefined {
    const candidates = [...this.tools.keys(), ...this.aliases.keys()];
    return suggestClosest(name, candidates, 3);
  }

  size(): number {
    return this.tools.size;
  }

  async invoke(
    name: string,
    input: string,
    context: Omit<ToolContext, 'signal'> & { signal?: AbortSignal },
    options: ToolInvokeOptions = {}
  ): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      const suggestion = this.suggest(name);
      const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
      return { content: `unknown tool: ${name}${hint}`, error: true };
    }
    const controller = new AbortController();
    if (context.signal) {
      if (context.signal.aborted) controller.abort();
      else context.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const fullContext: ToolContext = {
      ...context,
      signal: controller.signal,
      sandbox: options.sandbox ?? context.sandbox ?? false
    } as ToolContext;
    try {
      const exec = Promise.resolve(tool.execute(input, fullContext));
      if (options.timeoutMs && options.timeoutMs > 0) {
        return await withTimeout(exec, options.timeoutMs, controller);
      }
      return await exec;
    } catch (error) {
      if (error instanceof TimeoutError) {
        return { content: `tool timed out: ${name}`, error: true };
      }
      const msg = error instanceof Error ? error.message : String(error);
      options.logger?.warn('tool invocation failed', { tool: name, error: msg });
      return { content: `tool error: ${msg}`, error: true };
    }
  }
}
