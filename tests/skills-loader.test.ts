import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillsLoader } from '../src/skills/skills-loader.js';

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length) {
    const dir = cleanup.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeSkillsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'garud-skills-'));
  cleanup.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

describe('SkillsLoader', () => {
  it('returns empty list when directory is missing', () => {
    const loader = new SkillsLoader('/nonexistent-dir-xyz');
    expect(loader.list()).toEqual([]);
    expect(loader.match('anything')).toEqual([]);
  });

  it('returns empty when no dir provided', () => {
    const loader = new SkillsLoader();
    expect(loader.size()).toBe(0);
  });

  it('loads markdown skill files', async () => {
    const dir = await makeSkillsDir({
      'cooking.md': '# Cooking skill\nUse a hot pan to sear vegetables.',
      'coding.md': '# Coding skill\nWrite small functions and add tests.'
    });
    const loader = new SkillsLoader(dir);
    expect(loader.size()).toBe(2);
  });

  it('matches skills by token overlap', async () => {
    const dir = await makeSkillsDir({
      'cooking.md': 'Sear vegetables in a hot pan.',
      'coding.md': 'Write tests using vitest framework.'
    });
    const loader = new SkillsLoader(dir);
    const matches = loader.match('cooking vegetables', 5);
    expect(matches[0]?.name).toBe('cooking');
  });

  it('returns no matches for unrelated input', async () => {
    const dir = await makeSkillsDir({
      'cooking.md': 'Sear vegetables.'
    });
    const loader = new SkillsLoader(dir);
    expect(loader.match('quantum chromodynamics')).toEqual([]);
  });

  it('skips non-markdown files', async () => {
    const dir = await makeSkillsDir({
      'cooking.md': 'Sear.',
      'notes.txt': 'Not a skill.'
    });
    const loader = new SkillsLoader(dir);
    expect(loader.size()).toBe(1);
  });

  it('reload re-scans the directory', async () => {
    const dir = await makeSkillsDir({ 'a.md': 'first skill' });
    const loader = new SkillsLoader(dir);
    expect(loader.size()).toBe(1);
    await writeFile(path.join(dir, 'b.md'), 'second skill', 'utf8');
    loader.reload();
    expect(loader.size()).toBe(2);
  });

  it('returns empty when path points at a file, not a directory', async () => {
    const dir = await makeSkillsDir({ 'a.md': 'x' });
    const loader = new SkillsLoader(path.join(dir, 'a.md'));
    expect(loader.list()).toEqual([]);
  });

  it('handles nested-but-empty directories', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'garud-skills-empty-'));
    cleanup.push(dir);
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    const loader = new SkillsLoader(dir);
    expect(loader.size()).toBe(0);
  });
});
