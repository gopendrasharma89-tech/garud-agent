import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../types.js';

/**
 * `garud doctor` \u2014 OpenClaw-style health & misconfiguration audit.
 *
 * Surfaces things that *could* go wrong before they bite you:
 *   - missing or empty workspace files (SOUL.md, AGENTS.md, \u2026)
 *   - policy holes (no rules, no default-deny, exposed mutating endpoints)
 *   - channel adapters without HMAC secrets
 *   - storage misconfiguration (persistent off but workspaceDir set)
 *   - obvious env-variable leaks (GitHub PAT in process env, etc.)
 *
 * Returns a structured report with severity levels. The CLI prints it; the
 * HTTP endpoint serves the same JSON.
 */

export type Severity = 'ok' | 'info' | 'warn' | 'error';

export interface DoctorCheck {
  id: string;
  severity: Severity;
  message: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  summary: { ok: number; info: number; warn: number; error: number };
  checks: DoctorCheck[];
}

export interface DoctorInput {
  config: AppConfig;
  /** Workspace directory to inspect for OpenClaw files. */
  workspaceDir: string;
  /** Optional channel-secret presence map (don't pass the secret \u2014 just whether it's set). */
  channelSecretsPresent?: { whatsapp?: boolean; telegram?: boolean; discord?: boolean; slack?: boolean };
  /** Optional tool count, for the catalog check. */
  toolCount?: number;
}

const REQUIRED_FILES = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'] as const;
const RECOMMENDED_FILES = ['HEARTBEAT.md', 'TOOLS.md', 'MEMORY.md'] as const;

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Workspace files
  for (const f of REQUIRED_FILES) {
    const p = path.join(input.workspaceDir, f);
    const stat = await statOr(p);
    if (!stat) {
      checks.push({ id: `workspace.${f}`, severity: 'warn', message: `${f} missing`, fix: `seed via GET /${routeFor(f)} or write a default` });
    } else if (stat.size === 0) {
      checks.push({ id: `workspace.${f}`, severity: 'warn', message: `${f} is empty`, fix: 'add at least a heading and one paragraph' });
    } else {
      checks.push({ id: `workspace.${f}`, severity: 'ok', message: `${f} present (${stat.size} bytes)` });
    }
  }
  for (const f of RECOMMENDED_FILES) {
    const p = path.join(input.workspaceDir, f);
    const stat = await statOr(p);
    if (!stat) checks.push({ id: `workspace.${f}`, severity: 'info', message: `${f} not present`, fix: `seed via the workspace API` });
  }

  // 2. Policy holes
  const rules = input.config.policy?.rules ?? [];
  if (rules.length === 0) {
    checks.push({ id: 'policy.empty', severity: 'warn', message: 'no policy rules configured', fix: 'add at least one rule in config.policy.rules' });
  } else {
    checks.push({ id: 'policy.rules', severity: 'ok', message: `${rules.length} policy rules loaded` });
  }
  const allowsGuestMutations = rules.some((r) => r?.effect === 'allow' && (!r.trustLevels || r.trustLevels.length === 0 || r.trustLevels.includes('guest')));
  if (allowsGuestMutations) {
    checks.push({ id: 'policy.guest-allow', severity: 'warn', message: 'guest trust may be permitted on mutating operations', fix: 'tighten trust default in policy rules' });
  }

  // 3. Channel HMAC posture
  const cs = input.channelSecretsPresent ?? {};
  for (const ch of ['whatsapp', 'telegram', 'discord', 'slack'] as const) {
    if (!cs[ch]) {
      checks.push({ id: `channel.${ch}.hmac`, severity: 'info', message: `${ch} channel has no HMAC secret configured`, fix: `set GARUD_${ch.toUpperCase()}_SECRET to enable signature verification` });
    } else {
      checks.push({ id: `channel.${ch}.hmac`, severity: 'ok', message: `${ch} HMAC secret configured` });
    }
  }

  // 4. Storage sanity
  if (input.config.storage?.persistent && !input.config.storage?.workspaceDir) {
    checks.push({ id: 'storage.workspaceDir', severity: 'error', message: 'persistent storage enabled but workspaceDir is empty', fix: 'set config.storage.workspaceDir' });
  }

  // 5. Env-variable leaks (heuristic; we never print the value)
  const suspectEnv = Object.keys(process.env).filter((k) => /TOKEN|SECRET|API_KEY|PASSWORD/.test(k));
  if (suspectEnv.length > 0) {
    checks.push({ id: 'env.secrets', severity: 'info', message: `${suspectEnv.length} secret-like env vars detected (never logged): ${suspectEnv.slice(0, 5).join(', ')}${suspectEnv.length > 5 ? '\u2026' : ''}` });
  }
  for (const k of suspectEnv) {
    const v = process.env[k] ?? '';
    if (/^ghp_[A-Za-z0-9]{30,}/.test(v) || /^github_pat_/.test(v)) {
      checks.push({ id: `env.${k}`, severity: 'warn', message: `${k} looks like a GitHub PAT`, fix: 'store in a secrets manager, not the shell env' });
    }
  }

  // 6. Tool catalog
  if (typeof input.toolCount === 'number') {
    if (input.toolCount === 0) {
      checks.push({ id: 'tools.empty', severity: 'error', message: 'tool registry is empty', fix: 'check buildBuiltinTools() wiring' });
    } else {
      checks.push({ id: 'tools.count', severity: 'ok', message: `${input.toolCount} tools registered` });
    }
  }

  const summary = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const c of checks) summary[c.severity] += 1;
  return {
    ok: summary.error === 0 && summary.warn === 0,
    generatedAt: new Date().toISOString(),
    summary,
    checks
  };
}

async function statOr(p: string): Promise<{ size: number } | null> {
  try { const s = await fs.stat(p); return { size: s.size }; }
  catch { return null; }
}

function routeFor(file: string): string {
  if (file === 'IDENTITY.md') return 'identity';
  if (file === 'SOUL.md') return 'soul';
  if (file === 'AGENTS.md') return 'agents.md';
  return file.toLowerCase();
}
