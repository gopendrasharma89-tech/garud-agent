import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * OpenClaw-style workspace file manager. Owns three markdown documents that
 * shape the agent's behaviour and provide cross-session continuity:
 *
 *   • SOUL.md   — agent personality, voice, do/don't list
 *   • USER.md   — per-user profile facts (preferences, name, language)
 *   • AGENTS.md — declarative agent roster (id, persona, allowed tools)
 *
 * All files are append-friendly markdown so they are human-editable, diff-able
 * in git, and can be back-loaded by the agent on each turn.
 */
export class WorkspaceFiles {
  constructor(private readonly dir: string) {}

  private file(name: string): string { return path.join(this.dir, name); }

  private async readOr(name: string, defaultBody: string): Promise<string> {
    try { return await fs.readFile(this.file(name), 'utf8'); }
    catch { return defaultBody; }
  }

  private async write(name: string, body: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(name)}.tmp`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.file(name));
  }

  // ─────────────────────────── SOUL.md ───────────────────────────
  async readSoul(): Promise<string> {
    return this.readOr('SOUL.md', DEFAULT_SOUL);
  }
  async writeSoul(body: string): Promise<void> {
    if (Buffer.byteLength(body, 'utf8') > 256 * 1024) throw new Error('SOUL.md too large (max 256 KiB)');
    await this.write('SOUL.md', body);
  }

  // ─────────────────────────── USER.md ───────────────────────────
  async readUser(userId: string): Promise<string> {
    const safe = userId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
    return this.readOr(path.join('users', `${safe}.md`), `# User: ${userId}\n\n`);
  }
  async writeUser(userId: string, body: string): Promise<void> {
    const safe = userId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
    if (Buffer.byteLength(body, 'utf8') > 64 * 1024) throw new Error('USER.md too large (max 64 KiB)');
    await fs.mkdir(path.join(this.dir, 'users'), { recursive: true });
    await this.write(path.join('users', `${safe}.md`), body);
  }
  async listUsers(): Promise<string[]> {
    try {
      const files = await fs.readdir(path.join(this.dir, 'users'));
      return files.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
    } catch { return []; }
  }

  // ─────────────────────────── AGENTS.md ───────────────────────────
  async readAgents(): Promise<string> {
    return this.readOr('AGENTS.md', DEFAULT_AGENTS);
  }
  async writeAgents(body: string): Promise<void> {
    if (Buffer.byteLength(body, 'utf8') > 256 * 1024) throw new Error('AGENTS.md too large (max 256 KiB)');
    await this.write('AGENTS.md', body);
  }

  /** Combined snapshot for diagnostics / dashboard. */
  async snapshot(): Promise<{ soul: string; agents: string; userCount: number }> {
    const [soul, agents, users] = await Promise.all([
      this.readSoul(),
      this.readAgents(),
      this.listUsers()
    ]);
    return { soul, agents, userCount: users.length };
  }
}

const DEFAULT_SOUL = `# Garud — Soul

## Identity
You are Garud, a local-first agent gateway. You are concise, accurate, and helpful.
You speak in the language the user used. You never make up facts.

## Voice
- Direct and friendly
- Prefer short sentences over long ones
- Use markdown when it helps; plain text otherwise

## Boundaries
- Refuse destructive actions on guest trust
- Never expose secrets, API keys, or auth tokens
- When unsure, say "I don't know" and offer to search

## Operating notes
- Memory: short-term in session, long-term in MEMORY.md
- Tools: list available via \`garud tools\`; prefer specific tools over general
- Sub-agents: spawn for parallel work; never nest them
`;

const DEFAULT_AGENTS = `# Agents

Each agent is a named persona with its own allowed tool set and trust default.
Entries here can be overridden per-session via the API.

## default
- Persona: Garud — concise and accurate
- Tools: all read + write tools
- Trust default: \`guest\`

## scribe
- Persona: A careful note-taker. Writes to MEMORY.md and daily logs.
- Tools: memory.*, longterm.*, daily.*, text.*
- Trust default: \`trusted\`

## planner
- Persona: A multi-step task planner. Spawns sub-agents.
- Tools: agent.*, longterm.*, memory.*
- Trust default: \`owner\`
`;
