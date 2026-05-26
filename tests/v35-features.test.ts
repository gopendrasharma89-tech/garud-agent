import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryIndex } from '../src/memory/memory-index.js';
import { SkillLibrary } from '../src/skills/skill-library.js';
import { runDoctor } from '../src/doctor/doctor.js';
import { WorkspaceFiles } from '../src/workspace/workspace-files.js';
import { verifySlackV0, signHmac, verifyDiscordEd25519 } from '../src/channels/hmac-verify.js';
import { createHmac, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { defaultConfig } from '../src/config.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-v35-'));
});

describe('v3.5 Cumulus subsystems', () => {
  describe('MemoryIndex (Claude-Code-style lazy memory)', () => {
    it('truncates index at 200 lines but reports total', async () => {
      const mi = new MemoryIndex(tmp);
      const body = Array.from({ length: 250 }, (_, i) => `- line ${i + 1}`).join('\n') + '\n';
      await mi.writeIndex(body);
      const r = await mi.readIndex();
      expect(r.truncated).toBe(true);
      expect(r.totalLines).toBe(251);
      expect(r.body.split('\n').length).toBe(MemoryIndex.INDEX_LINE_CAP + 1);
    });

    it('lazy-loads and lists topic files', async () => {
      const mi = new MemoryIndex(tmp);
      await mi.saveTopic('Bash And System', '# bash notes\nuse `set -e` everywhere');
      await mi.saveTopic('apis-and-data', '# apis');
      const topics = await mi.listTopics();
      expect(topics).toContain('bash-and-system');
      expect(topics).toContain('apis-and-data');
      const body = await mi.loadTopic('bash-and-system');
      expect(body).toContain('set -e');
    });

    it('returns null for unknown topic', async () => {
      const mi = new MemoryIndex(tmp);
      expect(await mi.loadTopic('does-not-exist')).toBeNull();
    });

    it('rejects oversized topic body', async () => {
      const mi = new MemoryIndex(tmp);
      const big = 'x'.repeat(MemoryIndex.TOPIC_BYTE_CAP + 1);
      await expect(mi.saveTopic('huge', big)).rejects.toThrow(/too large/);
    });
  });

  describe('SkillLibrary (Hermes-style learning loop)', () => {
    it('extracts skill on success and bumps successCount on repeat', async () => {
      const sl = new SkillLibrary(path.join(tmp, 'skills'));
      const s1 = await sl.extract({ input: 'verify stripe webhook', output: 'check sig + parse + route', success: true, name: 'handle-stripe-webhook' });
      expect(s1).not.toBeNull();
      expect(s1!.successCount).toBe(1);
      const s2 = await sl.extract({ input: 'verify stripe webhook again', output: 'same plan', success: true, name: 'handle-stripe-webhook' });
      expect(s2!.successCount).toBe(2);
      expect(await sl.size()).toBe(1);
    });

    it('skips extraction on failure', async () => {
      const sl = new SkillLibrary(path.join(tmp, 'skills'));
      const s = await sl.extract({ input: 'x', output: 'y', success: false });
      expect(s).toBeNull();
      expect(await sl.size()).toBe(0);
    });

    it('finds relevant skills by token overlap', async () => {
      const sl = new SkillLibrary(path.join(tmp, 'skills'));
      await sl.extract({ input: 'stripe webhook signature verify', output: 'verify hmac sha256', success: true, name: 'stripe-verify' });
      await sl.extract({ input: 'send email via smtp', output: 'connect tls and send', success: true, name: 'smtp-send' });
      const r = await sl.findRelevant('stripe webhook handler', 2);
      expect(r.length).toBeGreaterThan(0);
      expect(r[0]!.skill.slug).toBe('stripe-verify');
    });

    it('ranks high-success skills above one-shot skills', async () => {
      const sl = new SkillLibrary(path.join(tmp, 'skills'));
      // a is used 3 times, b once \u2014 same query
      for (let i = 0; i < 3; i++) await sl.extract({ input: 'do alpha task', output: 'ok', success: true, name: 'alpha-handler' });
      await sl.extract({ input: 'do alpha task differently', output: 'ok', success: true, name: 'beta-handler' });
      const r = await sl.findRelevant('alpha task', 5);
      expect(r[0]!.skill.slug).toBe('alpha-handler');
      expect(r[0]!.skill.successCount).toBe(3);
    });
  });

  describe('WorkspaceFiles new files', () => {
    it('IDENTITY.md round-trips and rejects oversized', async () => {
      const w = new WorkspaceFiles(tmp);
      await w.writeIdentity('# Custom Identity\nname: TestBot');
      expect(await w.readIdentity()).toContain('TestBot');
      await expect(w.writeIdentity('x'.repeat(33 * 1024))).rejects.toThrow(/too large/);
    });

    it('TOOLS.md regenerates from registry snapshot', async () => {
      const w = new WorkspaceFiles(tmp);
      const body = await w.regenerateTools([
        { name: 'memory.save', description: 'save a memory' },
        { name: 'web.fetch', description: 'fetch a URL' }
      ]);
      expect(body).toContain('memory.save');
      expect(body).toContain('web.fetch');
      // alphabetical
      expect(body.indexOf('memory.save')).toBeLessThan(body.indexOf('web.fetch'));
    });

    it('HEARTBEAT.md parses rules under sections', async () => {
      const w = new WorkspaceFiles(tmp);
      await w.writeHeartbeat([
        '# Heartbeat', '',
        '## monitoring',
        '- Check disk usage every 30 min',
        '- Verify SSL cert weekly',
        '',
        '## housekeeping',
        '- Compact memory daily'
      ].join('\n'));
      const rules = await w.parseHeartbeatRules();
      expect(rules.length).toBe(3);
      expect(rules[0]).toEqual({ section: 'monitoring', rule: 'Check disk usage every 30 min' });
      expect(rules[2]).toEqual({ section: 'housekeeping', rule: 'Compact memory daily' });
    });
  });

  describe('Slack v0 signature scheme', () => {
    it('accepts a correctly signed Slack request', () => {
      const secret = 'shhh';
      const body = '{"type":"event_callback"}';
      const ts = Math.floor(Date.now() / 1000).toString();
      const base = `v0:${ts}:${body}`;
      const sig = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
      const r = verifySlackV0(secret, body, sig, ts);
      expect(r.ok).toBe(true);
    });

    it('rejects an expired timestamp', () => {
      const secret = 'shhh';
      const body = '{}';
      const ts = (Math.floor(Date.now() / 1000) - 1000).toString();
      const base = `v0:${ts}:${body}`;
      const sig = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
      const r = verifySlackV0(secret, body, sig, ts);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('timestamp out of range');
    });

    it('rejects malformed signature', () => {
      const r = verifySlackV0('shhh', '{}', 'not-v0=abc', '0');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('malformed signature');
    });
  });

  describe('Discord Ed25519 verification', () => {
    it('accepts a valid Ed25519 signature, rejects tampered body', async () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const rawPub = publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex');
      const body = '{"type":1}';
      const ts = '1700000000';
      const msg = Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from(body, 'utf8')]);
      const sig = edSign(null, msg, privateKey).toString('hex');
      const ok = await verifyDiscordEd25519(rawPub, body, sig, ts);
      expect(ok.ok).toBe(true);
      const tampered = await verifyDiscordEd25519(rawPub, '{"type":2}', sig, ts);
      expect(tampered.ok).toBe(false);
    });

    it('rejects malformed public key or signature', async () => {
      const r1 = await verifyDiscordEd25519('not-hex', 'x', 'aa'.repeat(64), '0');
      expect(r1.ok).toBe(false);
      const r2 = await verifyDiscordEd25519('aa'.repeat(32), 'x', 'bad-sig', '0');
      expect(r2.ok).toBe(false);
    });
  });

  describe('Doctor health audit', () => {
    it('reports missing required workspace files as warn', async () => {
      const report = await runDoctor({
        config: defaultConfig,
        workspaceDir: tmp,
        channelSecretsPresent: { whatsapp: false, telegram: false, discord: false, slack: false },
        toolCount: 100
      });
      const soulCheck = report.checks.find((c) => c.id === 'workspace.SOUL.md');
      expect(soulCheck?.severity).toBe('warn');
      expect(report.summary.warn).toBeGreaterThan(0);
      expect(report.ok).toBe(false);
    });

    it('flags policy holes when no rules present', async () => {
      const cfg = { ...defaultConfig, policy: { rules: [] } };
      const report = await runDoctor({ config: cfg, workspaceDir: tmp, toolCount: 1 });
      const policyCheck = report.checks.find((c) => c.id === 'policy.empty');
      expect(policyCheck?.severity).toBe('warn');
    });

    it('reports OK when files present and channels signed', async () => {
      const w = new WorkspaceFiles(tmp);
      await w.writeSoul('# soul');
      await w.writeAgents('# agents');
      await w.writeIdentity('# identity');
      const report = await runDoctor({
        config: defaultConfig,
        workspaceDir: tmp,
        channelSecretsPresent: { whatsapp: true, telegram: true, discord: true, slack: true },
        toolCount: 100
      });
      expect(report.checks.find((c) => c.id === 'workspace.SOUL.md')?.severity).toBe('ok');
      expect(report.checks.find((c) => c.id === 'channel.slack.hmac')?.severity).toBe('ok');
    });
  });
});

// silence unused-import lint for sign() under some TS settings
void signHmac;
