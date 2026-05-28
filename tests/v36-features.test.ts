import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseHeartbeatSchedule, HeartbeatScheduler } from '../src/heartbeat/heartbeat-scheduler.js';
import { AutoSkillExtractor } from '../src/skills/auto-skill-extractor.js';
import { SkillLibrary } from '../src/skills/skill-library.js';
import { buildWorkspaceTarball } from '../src/workspace/tarball.js';
import { runDoctor } from '../src/doctor/doctor.js';
import { defaultConfig } from '../src/config.js';
import type { BrainProvider } from '../src/brain/brain.js';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-v36-')); });

describe('v3.6 Nimbus subsystems', () => {
  describe('parseHeartbeatSchedule', () => {
    it('parses "every 30 minutes" as a 30-minute interval', () => {
      const r = parseHeartbeatSchedule('Check disk usage every 30 minutes');
      expect(r.kind).toBe('interval');
      expect(r.everyMs).toBe(30 * 60 * 1000);
    });
    it('parses "every 5s" as a 5-second interval', () => {
      const r = parseHeartbeatSchedule('ping every 5s');
      expect(r.kind).toBe('interval');
      expect(r.everyMs).toBe(5000);
    });
    it('parses "daily at 8:00" as dailyAt with normalised time', () => {
      const r = parseHeartbeatSchedule('Send the daily report daily at 8:00');
      expect(r.kind).toBe('dailyAt');
      expect(r.at).toBe('08:00');
      expect(r.everyMs).toBeGreaterThan(0);
    });
    it('parses "daily at 3:30 pm" as 15:30', () => {
      const r = parseHeartbeatSchedule('rotate daily at 3:30 pm');
      expect(r.at).toBe('15:30');
    });
    it('parses weekly variants', () => {
      expect(parseHeartbeatSchedule('Compact memory weekly').kind).toBe('weekly');
      expect(parseHeartbeatSchedule('archive once a week').kind).toBe('weekly');
    });
    it('returns unscheduled for prose with no schedule', () => {
      const r = parseHeartbeatSchedule('Make a coffee when you feel like it');
      expect(r.kind).toBe('unscheduled');
      expect(r.everyMs).toBeUndefined();
    });
  });

  describe('HeartbeatScheduler', () => {
    it('schedules interval rules and fires onTick', async () => {
      const sched = new HeartbeatScheduler();
      const fires: Array<{ kind: string }> = [];
      sched.schedule([{ section: 'test', rule: 'ping every 1s' }], (e) => fires.push({ kind: e.kind }));
      // wait a little over a second
      await new Promise((r) => setTimeout(r, 1200));
      sched.stop();
      expect(fires.length).toBeGreaterThanOrEqual(1);
      expect(fires[0]!.kind).toBe('interval');
    });
    it('classifies an unscheduled rule but does not fire', async () => {
      const sched = new HeartbeatScheduler();
      const fires: number[] = [];
      const list = sched.schedule([{ section: 's', rule: 'unparseable prose' }], () => fires.push(1));
      await new Promise((r) => setTimeout(r, 100));
      sched.stop();
      expect(list[0]!.kind).toBe('unscheduled');
      expect(fires.length).toBe(0);
    });
    it('stop() cancels all future fires', async () => {
      const sched = new HeartbeatScheduler();
      const fires: number[] = [];
      sched.schedule([{ section: 's', rule: 'ping every 1s' }], () => fires.push(1));
      sched.stop();
      await new Promise((r) => setTimeout(r, 1200));
      expect(fires.length).toBe(0);
    });
  });

  describe('AutoSkillExtractor', () => {
    it('extracts a skill after a successful compose()', async () => {
      const lib = new SkillLibrary(path.join(tmp, 'skills'));
      const inner: BrainProvider = {
        name: 'fake',
        plan: () => ({ tools: [] }),
        compose: () => ({ text: 'This is a long, helpful reply that should be captured as a reusable skill template.' })
      };
      const wrap = new AutoSkillExtractor(inner, lib);
      const reply = await wrap.compose({ input: 'how to verify stripe webhook', session: { id: 's' } as any, memories: [], toolOutputs: [] });
      expect(reply.text).toContain('reusable skill');
      // Extraction is fire-and-forget (queueMicrotask -> async fs.writeFile);
      // poll the library briefly so we don't depend on event-loop ordering.
      for (let i = 0; i < 50 && (await lib.size()) === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(await lib.size()).toBe(1);
    });
    it('skips extraction when reply is too short or error-y', async () => {
      const lib = new SkillLibrary(path.join(tmp, 'skills'));
      const inner: BrainProvider = { name: 'fake', plan: () => ({ tools: [] }), compose: () => ({ text: 'error' }) };
      const wrap = new AutoSkillExtractor(inner, lib);
      await wrap.compose({ input: 'go', session: { id: 's' } as any, memories: [], toolOutputs: [] });
      // Give the (skipped) extraction microtask plenty of room to fire if it were going to.
      await new Promise((r) => setTimeout(r, 100));
      expect(await lib.size()).toBe(0);
    });
  });

  describe('buildWorkspaceTarball', () => {
    it('produces a gzipped tar with the expected magic bytes', async () => {
      await fs.writeFile(path.join(tmp, 'SOUL.md'), '# soul');
      await fs.writeFile(path.join(tmp, 'AGENTS.md'), '# agents');
      const buf = await buildWorkspaceTarball(tmp);
      expect(buf.length).toBeGreaterThan(64);
      // gzip magic 0x1f 0x8b
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);
    });
    it('skips node_modules and .git directories', async () => {
      await fs.mkdir(path.join(tmp, 'node_modules', 'foo'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'node_modules', 'foo', 'big.txt'), 'x'.repeat(1024));
      await fs.writeFile(path.join(tmp, 'SOUL.md'), '# soul');
      const buf = await buildWorkspaceTarball(tmp);
      // un-gzip and grep for 'big.txt' \u2014 must not appear
      const { gunzipSync } = await import('node:zlib');
      const tar = gunzipSync(buf).toString('latin1');
      expect(tar.includes('big.txt')).toBe(false);
      expect(tar.includes('SOUL.md')).toBe(true);
    });
  });

  describe('Doctor v3.6 changes', () => {
    it('classifies GARUD_*_SECRET env vars as ok, not as leaks', async () => {
      const prev = process.env.GARUD_TELEGRAM_SECRET;
      process.env.GARUD_TELEGRAM_SECRET = 'shhh';
      try {
        const report = await runDoctor({ config: defaultConfig, workspaceDir: tmp, toolCount: 1 });
        expect(report.checks.find((c) => c.id === 'env.garud-secrets')?.severity).toBe('ok');
      } finally {
        if (prev === undefined) delete process.env.GARUD_TELEGRAM_SECRET;
        else process.env.GARUD_TELEGRAM_SECRET = prev;
      }
    });
  });
});
