import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFiles } from '../src/workspace/workspace-files.js';
import { Heartbeat } from '../src/heartbeat/heartbeat.js';
import { mascot, mascotInline } from '../src/mascot.js';

describe('v3.0 WorkspaceFiles', () => {
  let dir: string;
  let ws: WorkspaceFiles;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-ws-'));
    ws = new WorkspaceFiles(dir);
  });

  it('returns a default SOUL.md when none exists', async () => {
    const body = await ws.readSoul();
    expect(body).toContain('# Garud');
    expect(body).toContain('Identity');
  });

  it('persists SOUL.md across reads', async () => {
    await ws.writeSoul('# Custom Soul\nbe terse.');
    expect(await ws.readSoul()).toBe('# Custom Soul\nbe terse.');
  });

  it('rejects SOUL.md over 256 KiB', async () => {
    const huge = 'x'.repeat(300 * 1024);
    await expect(ws.writeSoul(huge)).rejects.toThrow(/too large/);
  });

  it('returns a default AGENTS.md when none exists', async () => {
    const body = await ws.readAgents();
    expect(body).toContain('default');
    expect(body).toContain('Agents');
  });

  it('reads + writes USER.md per userId', async () => {
    await ws.writeUser('alice', '# alice\n- prefers dark mode');
    const body = await ws.readUser('alice');
    expect(body).toContain('prefers dark mode');
  });

  it('sanitizes userId in file path', async () => {
    await ws.writeUser('../../etc/passwd', 'should be sandboxed');
    const users = await ws.listUsers();
    // The replace + slice keeps single dots (e.g. "......etc.passwd") but bars slashes.
    expect(users.every((u) => !u.includes('/'))).toBe(true);
    expect(users.every((u) => !u.startsWith('..'))).toBe(false); // dots ARE allowed; only path separators are stripped
  });

  it('lists known users', async () => {
    await ws.writeUser('alice', 'a');
    await ws.writeUser('bob', 'b');
    expect((await ws.listUsers()).sort()).toEqual(['alice', 'bob']);
  });

  it('snapshot returns combined view', async () => {
    await ws.writeUser('a', 'x');
    const snap = await ws.snapshot();
    expect(snap.soul).toContain('Garud');
    expect(snap.agents).toContain('default');
    expect(snap.userCount).toBe(1);
  });
});

describe('v3.0 Heartbeat', () => {
  it('start/stop is idempotent', () => {
    const hb = new Heartbeat(60_000, () => 0);
    hb.start();
    hb.start();
    expect(hb.isRunning()).toBe(true);
    hb.stop();
    hb.stop();
    expect(hb.isRunning()).toBe(false);
  });

  it('beat returns a sample with required fields', async () => {
    const hb = new Heartbeat(60_000, () => 3);
    const sample = await hb.beat();
    expect(sample.id).toBeTruthy();
    expect(sample.ts).toBeGreaterThan(0);
    expect(sample.pendingSubAgents).toBe(3);
    expect(typeof sample.rssBytes).toBe('number');
  });

  it('notifies listeners on beat', async () => {
    const hb = new Heartbeat(60_000, () => 0);
    let count = 0;
    hb.on(() => { count++; });
    await hb.beat();
    await hb.beat();
    expect(count).toBe(2);
  });

  it('probes contribute notes', async () => {
    const hb = new Heartbeat(60_000, () => 0);
    hb.probe(() => ({ customMetric: 42 }));
    const sample = await hb.beat();
    expect(sample.notes.customMetric).toBe(42);
  });

  it('isolates probe errors', async () => {
    const hb = new Heartbeat(60_000, () => 0);
    hb.probe(() => { throw new Error('boom'); });
    hb.probe(() => ({ ok: true }));
    const sample = await hb.beat();
    expect(sample.notes.ok).toBe(true);
  });

  it('count() increments per beat', async () => {
    const hb = new Heartbeat(60_000, () => 0);
    await hb.beat();
    await hb.beat();
    await hb.beat();
    expect(hb.count()).toBe(3);
  });
});

describe('v3.0 Mascot', () => {
  it('returns multi-line art without color when disabled', () => {
    const art = mascot({ color: false });
    expect(art.split('\n').length).toBeGreaterThan(5);
    expect(art).not.toContain('\x1b[');
    expect(art).toContain('GARUD');
  });

  it('includes ANSI escapes when color enabled', () => {
    const art = mascot({ color: true });
    expect(art).toContain('\x1b[');
  });

  it('inline variant is single-line', () => {
    const s = mascotInline({ color: false });
    expect(s).not.toContain('\n');
    expect(s).toContain('GARUD');
  });

  it('tagline can be suppressed', () => {
    const without = mascot({ color: false, tagline: false });
    const withTag = mascot({ color: false, tagline: true });
    expect(withTag.length).toBeGreaterThan(without.length);
    expect(without).not.toContain('local-first');
  });
});
