/**
 * Parse AGENTS.md into a structured persona roster.
 *
 * AGENTS.md format (compatible with the v2.0 default):
 *
 *   ## <slug>
 *   - Persona: <one-line description>
 *   - Tools: <comma-or-glob list>
 *   - Trust default: <guest|trusted|owner>
 *
 * Unknown lines under a persona section are kept as free-form `notes`.
 * Headings outside `## <slug>` (eg the file title `# Agents`) are ignored.
 *
 * The brain can switch persona by name via `?agent=<slug>` query param on
 * channel endpoints. The router falls back to `default` when the requested
 * persona is missing.
 */

import type { TrustLevel } from '../types.js';

export interface AgentPersona {
  slug: string;
  persona: string;
  tools: string[];
  trustDefault?: TrustLevel;
  notes: string[];
}

const VALID_TRUST: ReadonlySet<TrustLevel> = new Set(['guest', 'trusted', 'owner'] as const);

export function parseAgentsMd(body: string): AgentPersona[] {
  const out: AgentPersona[] = [];
  let current: AgentPersona | null = null;
  for (const raw of (body ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const slug = h[1]!.trim();
      if (slug.toLowerCase() === 'agents') continue;
      current = { slug: sanitizeSlug(slug), persona: '', tools: [], notes: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const text = bullet[1]!.trim();
    const personaKv = /^persona\s*:\s*(.+)$/i.exec(text);
    const toolsKv = /^tools?\s*:\s*(.+)$/i.exec(text);
    const trustKv = /^trust(?:\s+default)?\s*:\s*[`]?([a-z]+)[`]?$/i.exec(text);
    if (personaKv) { current.persona = personaKv[1]!.trim(); continue; }
    if (toolsKv) {
      current.tools = toolsKv[1]!
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      continue;
    }
    if (trustKv) {
      const t = trustKv[1]!.toLowerCase() as TrustLevel;
      if (VALID_TRUST.has(t)) current.trustDefault = t;
      continue;
    }
    current.notes.push(text);
  }
  return out;
}

export function findPersona(personas: AgentPersona[], slug: string | undefined): AgentPersona | null {
  if (!slug) return personas.find((p) => p.slug === 'default') ?? null;
  const want = sanitizeSlug(slug);
  return personas.find((p) => p.slug === want) ?? personas.find((p) => p.slug === 'default') ?? null;
}

function sanitizeSlug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
