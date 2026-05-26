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

  // ─────────────────────────── IDENTITY.md (v3.5) ───────────────────────────
  async readIdentity(): Promise<string> { return this.readOr('IDENTITY.md', DEFAULT_IDENTITY); }
  async writeIdentity(body: string): Promise<void> {
    if (Buffer.byteLength(body, 'utf8') > 32 * 1024) throw new Error('IDENTITY.md too large (max 32 KiB)');
    await this.write('IDENTITY.md', body);
  }

  // ─────────────────────────── TOOLS.md (v3.5) ───────────────────────────
  /** Read TOOLS.md (the human-curated tools manual). */
  async readTools(): Promise<string> { return this.readOr('TOOLS.md', DEFAULT_TOOLS); }
  async writeTools(body: string): Promise<void> {
    if (Buffer.byteLength(body, 'utf8') > 256 * 1024) throw new Error('TOOLS.md too large (max 256 KiB)');
    await this.write('TOOLS.md', body);
  }
  /** Regenerate TOOLS.md from a tool registry snapshot (auto-generated catalog). */
  async regenerateTools(tools: Array<{ name: string; description?: string }>): Promise<string> {
    const lines = ['# Tools Catalog', '', '_Auto-generated. Hand-edits to this file are overwritten on regenerate._', '', `## ${tools.length} built-in tools`, ''];
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    for (const t of sorted) {
      lines.push(`- **${t.name}** — ${(t.description ?? '').replace(/\n/g, ' ').slice(0, 240) || '_no description_'}`);
    }
    const body = lines.join('\n') + '\n';
    await this.write('TOOLS.md', body);
    return body;
  }

  // ─────────────────────────── HEARTBEAT.md (v3.5) ───────────────────────────
  async readHeartbeat(): Promise<string> { return this.readOr('HEARTBEAT.md', DEFAULT_HEARTBEAT); }
  async writeHeartbeat(body: string): Promise<void> {
    if (Buffer.byteLength(body, 'utf8') > 64 * 1024) throw new Error('HEARTBEAT.md too large (max 64 KiB)');
    await this.write('HEARTBEAT.md', body);
  }
  /**
   * Parse HEARTBEAT.md into a list of rules. Each rule is a non-empty line
   * after a `## ` heading; lines starting with `-` or `*` are extracted as
   * rules. This is intentionally simple — the LLM brain interprets the prose
   * at runtime.
   */
  async parseHeartbeatRules(): Promise<Array<{ section: string; rule: string }>> {
    const body = await this.readHeartbeat();
    const rules: Array<{ section: string; rule: string }> = [];
    let section = 'general';
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('## ')) { section = line.slice(3).trim() || 'general'; continue; }
      const m = /^[-*]\s+(.+)$/.exec(line);
      if (m && m[1]) rules.push({ section, rule: m[1].trim() });
    }
    return rules;
  }

  /** Combined snapshot for diagnostics / dashboard. */
  async snapshot(): Promise<{ soul: string; agents: string; identity: string; userCount: number; heartbeatRuleCount: number }> {
    const [soul, agents, identity, users, hbRules] = await Promise.all([
      this.readSoul(),
      this.readAgents(),
      this.readIdentity(),
      this.listUsers(),
      this.parseHeartbeatRules()
    ]);
    return { soul, agents, identity, userCount: users.length, heartbeatRuleCount: hbRules.length };
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

const DEFAULT_IDENTITY = `# Identity

- **name**: Garud
- **id**: garud-agent
- **role**: local-first agent gateway
- **version**: 3.5.0
- **codename**: Cumulus
- **homepage**: https://github.com/gopendrasharma89-tech/garud-agent
- **license**: MIT
`;

const DEFAULT_TOOLS = `# Tools Catalog

_Run \`garud tools.regenerate\` (or POST /workspace/tools/regenerate) to regenerate this file from the live tool registry._

The agent prefers specific tools over general ones. Tools follow \`namespace.action\`
naming. See \`/tools\` HTTP endpoint for the live list.
`;

const DEFAULT_HEARTBEAT = `# Heartbeat

Declarative recurring tasks the agent should consider during each tick.
Lines starting with \`-\` or \`*\` under a \`## section\` heading are parsed
as rules. Free-form prose is allowed; the brain reads it as guidance.

## monitoring
- Verify the workspace directory is writable
- Log a heartbeat ping to the daily log

## housekeeping
- Once per day, compact MEMORY.md if it exceeds 1 MiB
- Once per week, roll over old daily logs
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
