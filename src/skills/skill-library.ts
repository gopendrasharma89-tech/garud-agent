import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Hermes-style learning loop. A "skill" is a structured reasoning template
 * extracted from a successful task completion. Skills are reusable: when a
 * new task arrives, the library is searched for relevant skills which are
 * surfaced into the planner.
 *
 * On-disk layout:
 *   workspace/skills/<slug>.md
 *
 * Each file has a YAML-ish header followed by free-form prose:
 *
 *   ---
 *   name: handle-stripe-webhook
 *   when: stripe webhook
 *   successCount: 5
 *   lastUsed: 2026-05-20T12:34:56.000Z
 *   ---
 *   ## Template
 *   1. Verify signature
 *   2. Parse event.type
 *   3. Route to handler
 *
 * Skills are deliberately *plain markdown* so a human can edit them. The
 * library is a thin layer that adds extraction, retrieval, and bookkeeping.
 *
 * Retrieval uses token-overlap scoring (deterministic, zero-dep). When an
 * EmbeddingStore is wired the brain can do semantic search separately.
 */

export interface Skill {
  /** Stable slug derived from `name`. */
  slug: string;
  /** Human-readable name. */
  name: string;
  /** Trigger phrase \u2014 a short description of when this skill applies. */
  when: string;
  /** Number of times the skill has been used and considered successful. */
  successCount: number;
  /** ISO timestamp of last successful use. */
  lastUsed?: string;
  /** Body of the skill (markdown). Contains the reasoning template. */
  body: string;
}

export interface SkillSearchResult {
  skill: Skill;
  /** 0..1 token-overlap score. */
  score: number;
}

export class SkillLibrary {
  constructor(private readonly dir: string) {}

  /** Extract a skill from a (input, output, success) triple. The skill is
   *  only persisted when `success === true`; otherwise this is a no-op. */
  async extract(input: { input: string; output: string; success: boolean; name?: string; when?: string }): Promise<Skill | null> {
    if (!input.success) return null;
    const name = (input.name ?? deriveName(input.input)).trim();
    if (!name) return null;
    const when = (input.when ?? input.input).trim();
    const slug = slugify(name);

    // If a skill with this slug already exists, bump successCount.
    const existing = await this.read(slug).catch(() => null);
    if (existing) {
      existing.successCount += 1;
      existing.lastUsed = new Date().toISOString();
      // Append a short trace of the new evidence.
      existing.body = existing.body.trimEnd() + `\n\n### Evidence (\u00d7${existing.successCount}) ${existing.lastUsed}\n${truncate(input.output, 800)}\n`;
      await this.write(existing);
      return existing;
    }

    const skill: Skill = {
      slug,
      name,
      when,
      successCount: 1,
      lastUsed: new Date().toISOString(),
      body: [
        '## Template',
        truncate(input.output, 2000),
        '',
        '### Evidence (\u00d71) ' + new Date().toISOString(),
        truncate(input.output, 400)
      ].join('\n')
    };
    await this.write(skill);
    return skill;
  }

  /** Read a skill by slug. Throws if not found. */
  async read(slug: string): Promise<Skill> {
    const safe = slugify(slug);
    const file = path.join(this.dir, `${safe}.md`);
    const raw = await fs.readFile(file, 'utf8');
    return parse(safe, raw);
  }

  /** Read a skill or return null. */
  async readOrNull(slug: string): Promise<Skill | null> {
    try { return await this.read(slug); } catch { return null; }
  }

  /** Persist a skill atomically. */
  async write(skill: Skill): Promise<{ bytes: number }> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${skill.slug}.md`);
    const tmp = `${file}.tmp`;
    const body = serialize(skill);
    if (Buffer.byteLength(body, 'utf8') > 512 * 1024) throw new Error(`skill ${skill.slug}: too large`);
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, file);
    return { bytes: Buffer.byteLength(body, 'utf8') };
  }

  /** List all skills (slug only, cheap). */
  async listSlugs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir);
      return entries.filter((e) => e.endsWith('.md')).map((e) => e.slice(0, -3)).sort();
    } catch { return []; }
  }

  /** Load all skills (slow path; for small libraries only). */
  async listAll(): Promise<Skill[]> {
    const slugs = await this.listSlugs();
    const out: Skill[] = [];
    for (const s of slugs) {
      const skill = await this.readOrNull(s);
      if (skill) out.push(skill);
    }
    return out;
  }

  /**
   * Find skills relevant to a query using token-overlap scoring against the
   * skill's `when` field plus the first 300 chars of the body. Returns the
   * top-K results sorted by descending score. Score is computed as:
   *   (matched-query-tokens / query-tokens) * (1 + log(1 + successCount))
   * so frequently-successful skills surface earlier.
   */
  async findRelevant(query: string, k = 5): Promise<SkillSearchResult[]> {
    const skills = await this.listAll();
    if (skills.length === 0) return [];
    const qTokens = tokenize(query);
    if (qTokens.size === 0) return [];
    const results: SkillSearchResult[] = [];
    for (const skill of skills) {
      const haystack = tokenize(`${skill.when}\n${skill.body.slice(0, 300)}`);
      let matched = 0;
      for (const t of qTokens) if (haystack.has(t)) matched += 1;
      if (matched === 0) continue;
      const base = matched / qTokens.size;
      const score = base * (1 + Math.log(1 + skill.successCount));
      results.push({ skill, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, Math.max(1, Math.min(50, k)));
  }

  /** Remove a skill. Returns true if a file was deleted. */
  async remove(slug: string): Promise<boolean> {
    const safe = slugify(slug);
    try { await fs.unlink(path.join(this.dir, `${safe}.md`)); return true; }
    catch { return false; }
  }

  /** Total number of skills in the library. */
  async size(): Promise<number> { return (await this.listSlugs()).length; }
}

// ────────────────────────────── helpers ──────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function deriveName(input: string): string {
  return (input || 'untitled').slice(0, 60).replace(/[\n\r]+/g, ' ').trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '\u2026';
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of (s ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && t.length <= 32) out.add(t);
  }
  return out;
}

function serialize(skill: Skill): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`name: ${skill.name}`);
  lines.push(`when: ${skill.when.replace(/\n/g, ' ').slice(0, 240)}`);
  lines.push(`successCount: ${skill.successCount}`);
  if (skill.lastUsed) lines.push(`lastUsed: ${skill.lastUsed}`);
  lines.push('---');
  lines.push('');
  lines.push(skill.body);
  if (!skill.body.endsWith('\n')) lines.push('');
  return lines.join('\n');
}

function parse(slug: string, raw: string): Skill {
  // Header is between two '---' lines at the top.
  let name = slug, when = '', successCount = 0, lastUsed: string | undefined, body = raw;
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (m) {
    const header = m[1] ?? '';
    body = m[2] ?? '';
    for (const line of header.split('\n')) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === 'name') name = val || slug;
      else if (key === 'when') when = val;
      else if (key === 'successcount') successCount = parseInt(val, 10) || 0;
      else if (key === 'lastused') lastUsed = val;
    }
  }
  const skill: Skill = { slug, name, when, successCount, body };
  if (lastUsed) skill.lastUsed = lastUsed;
  return skill;
}
