import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseAgentsMd, findPersona } from '../src/workspace/agents-parser.js';
import { SkillLibrary } from '../src/skills/skill-library.js';
import { AutoSkillExtractor } from '../src/skills/auto-skill-extractor.js';
import { signUrlToken, verifyUrlToken } from '../src/auth/signed-url.js';
import type { BrainProvider } from '../src/brain/brain.js';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-v37-')); });

describe('v3.7 Altocumulus subsystems', () => {
  describe('parseAgentsMd', () => {
    it('parses the default AGENTS.md format', () => {
      const body = `# Agents

## default
- Persona: Garud — concise and accurate
- Tools: memory.* longterm.*
- Trust default: \`guest\`

## scribe
- Persona: A note-taker
- Tools: memory.save, longterm.add
- Trust default: trusted
- a free-form note about behavior
`;
      const personas = parseAgentsMd(body);
      expect(personas.length).toBe(2);
      expect(personas[0]!.slug).toBe('default');
      expect(personas[0]!.persona).toContain('concise');
      expect(personas[0]!.trustDefault).toBe('guest');
      expect(personas[0]!.tools).toContain('memory.*');
      expect(personas[1]!.slug).toBe('scribe');
      expect(personas[1]!.notes.length).toBe(1);
      expect(personas[1]!.notes[0]).toMatch(/free-form/);
    });

    it('findPersona falls back to default when slug missing', () => {
      const personas = parseAgentsMd('## default\n- Persona: A\n\n## scribe\n- Persona: B\n');
      expect(findPersona(personas, undefined)?.slug).toBe('default');
      expect(findPersona(personas, 'scribe')?.slug).toBe('scribe');
      expect(findPersona(personas, 'missing')?.slug).toBe('default');
    });

    it('rejects invalid trust levels silently', () => {
      const personas = parseAgentsMd('## a\n- Persona: x\n- Trust default: superuser\n');
      expect(personas[0]!.trustDefault).toBeUndefined();
    });

    it('ignores the # Agents title heading', () => {
      const personas = parseAgentsMd('# Agents\n## default\n- Persona: X\n');
      expect(personas.length).toBe(1);
      expect(personas[0]!.slug).toBe('default');
    });
  });

  describe('SkillLibrary.prune', () => {
    it('removes low-success + stale skills, keeps recent ones', async () => {
      const lib = new SkillLibrary(path.join(tmp, 'skills'));
      // a: successCount=1, lastUsed 60 days ago → should prune
      await lib.write({ slug: 'old-shot', name: 'old shot', when: 'q1', successCount: 1, lastUsed: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(), body: '...' });
      // b: successCount=5, lastUsed 60 days ago → keep (high success)
      await lib.write({ slug: 'popular-old', name: 'popular old', when: 'q2', successCount: 5, lastUsed: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(), body: '...' });
      // c: successCount=1, lastUsed yesterday → keep (still fresh)
      await lib.write({ slug: 'fresh-shot', name: 'fresh shot', when: 'q3', successCount: 1, lastUsed: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), body: '...' });
      const result = await lib.prune();
      expect(result.pruned).toEqual(['old-shot']);
      expect(result.kept).toBe(2);
      expect(await lib.size()).toBe(2);
    });

    it('dryRun reports without deleting', async () => {
      const lib = new SkillLibrary(path.join(tmp, 'skills'));
      await lib.write({ slug: 'ancient', name: 'a', when: 'q', successCount: 1, lastUsed: new Date(0).toISOString(), body: '...' });
      const result = await lib.prune({ dryRun: true });
      expect(result.pruned).toEqual(['ancient']);
      expect(result.dryRun).toBe(true);
      expect(await lib.size()).toBe(1);
    });
  });

  describe('SkillLibrary slug cache', () => {
    it('serves listSlugs from cache after a write', async () => {
      const lib = new SkillLibrary(path.join(tmp, 'skills'));
      await lib.write({ slug: 'first', name: 'first', when: 'q', successCount: 1, body: '...' });
      const a = await lib.listSlugs();
      const b = await lib.listSlugs();
      expect(a).toEqual(b);
      // Add another; cache must invalidate
      await lib.write({ slug: 'second', name: 'second', when: 'q', successCount: 1, body: '...' });
      const c = await lib.listSlugs();
      expect(c).toContain('first');
      expect(c).toContain('second');
    });
  });

  describe('AutoSkillExtractor v3.7 tightened heuristics', () => {
    it('skips short inputs (< 20 chars)', async () => {
      const lib = new SkillLibrary(path.join(tmp, 'skills'));
      const inner: BrainProvider = {
        name: 'fake', plan: () => ({ tools: [] }),
        compose: () => ({ text: 'A perfectly reasonable long-enough reply explaining the answer in detail.' })
      };
      const wrap = new AutoSkillExtractor(inner, lib);
      await wrap.compose({ input: 'hi', session: { id: 's' } as any, memories: [], toolOutputs: [] });
      await new Promise((r) => setTimeout(r, 100));
      expect(await lib.size()).toBe(0);
    });

    it('skips purely conversational replies', async () => {
      const lib = new SkillLibrary(path.join(tmp, 'skills'));
      const inner: BrainProvider = {
        name: 'fake', plan: () => ({ tools: [] }),
        compose: () => ({ text: 'Thanks!' })
      };
      const wrap = new AutoSkillExtractor(inner, lib);
      await wrap.compose({ input: 'how do I configure stripe webhooks for production', session: { id: 's' } as any, memories: [], toolOutputs: [] });
      await new Promise((r) => setTimeout(r, 100));
      expect(await lib.size()).toBe(0);
    });

    it('still extracts genuinely substantive replies', async () => {
      const lib = new SkillLibrary(path.join(tmp, 'skills'));
      const inner: BrainProvider = {
        name: 'fake', plan: () => ({ tools: [] }),
        compose: () => ({ text: 'To verify a stripe webhook, compute hmac-sha256 over the raw body using the endpoint secret and compare to the Stripe-Signature header.' })
      };
      const wrap = new AutoSkillExtractor(inner, lib);
      await wrap.compose({ input: 'how do I verify stripe webhook signature', session: { id: 's' } as any, memories: [], toolOutputs: [] });
      for (let i = 0; i < 50 && (await lib.size()) === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(await lib.size()).toBe(1);
    });
  });

  describe('Signed URL', () => {
    it('round-trips a valid token', () => {
      const exp = Math.floor(Date.now() / 1000) + 300;
      const tok = signUrlToken('s3cr3t', '/workspace.tgz', exp);
      const r = verifyUrlToken('s3cr3t', '/workspace.tgz', tok);
      expect(r.ok).toBe(true);
    });

    it('rejects expired token', () => {
      const exp = Math.floor(Date.now() / 1000) - 60;
      const tok = signUrlToken('s3cr3t', '/workspace.tgz', exp);
      const r = verifyUrlToken('s3cr3t', '/workspace.tgz', tok);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('expired');
    });

    it('rejects token for a different path', () => {
      const exp = Math.floor(Date.now() / 1000) + 300;
      const tok = signUrlToken('s3cr3t', '/workspace.tgz', exp);
      const r = verifyUrlToken('s3cr3t', '/other-path', tok);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('mismatch');
    });

    it('rejects missing and malformed tokens', () => {
      expect(verifyUrlToken('s3cr3t', '/x', undefined).ok).toBe(false);
      expect(verifyUrlToken('s3cr3t', '/x', 'not-a-token').ok).toBe(false);
      expect(verifyUrlToken('s3cr3t', '/x', '.').ok).toBe(false);
      expect(verifyUrlToken('s3cr3t', '/x', 'abc.notanumber').ok).toBe(false);
    });

    it('rejects when secret is not configured', () => {
      expect(verifyUrlToken(undefined, '/x', 'abc.123').ok).toBe(false);
    });
  });
});
