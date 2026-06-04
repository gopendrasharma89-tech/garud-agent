import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ToolDefinition, ToolResult } from '../types.js';

const execp = promisify(exec);

/**
 * System-access tools. Disabled by default \u2014 enabled only when
 * `GARUD_SYSTEM_ACCESS=1` is set in the environment, and further gated by
 * an allowlist of directories (`GARUD_FS_ALLOW`, colon-separated) for the
 * filesystem tools and a command allowlist (`GARUD_EXEC_ALLOW`,
 * colon-separated) for shell exec.
 *
 * Every tool here is dangerous if misconfigured. The defaults are *deny*:
 *   - no env set       \u2192 every system tool returns "system access disabled"
 *   - env set, no list \u2192 every action is allowed (use only on trusted hosts)
 *   - env + list set   \u2192 only paths/commands matching the list are allowed
 */

export interface SystemToolsOptions {
  enabled: boolean;
  fsAllow?: string[];
  execAllow?: string[];
  maxBytes?: number;
  execTimeoutMs?: number;
}

export function buildSystemTools(opts: SystemToolsOptions): ToolDefinition[] {
  const disabled = (name: string): ToolResult => ({ content: `${name}: system access disabled (set GARUD_SYSTEM_ACCESS=1)`, error: true });
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const execTimeout = opts.execTimeoutMs ?? 15_000;
  const fsAllow = opts.fsAllow ?? [];
  const execAllow = opts.execAllow ?? [];

  function pathAllowed(p: string): boolean {
    if (!opts.enabled) return false;
    if (fsAllow.length === 0) return true;
    const abs = path.resolve(p);
    return fsAllow.some((root) => abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep));
  }
  function cmdAllowed(c: string): boolean {
    if (!opts.enabled) return false;
    if (execAllow.length === 0) return true;
    const head = c.trim().split(/\s+/)[0] ?? '';
    return execAllow.includes(head);
  }

  return [
    {
      name: 'system.info',
      description: 'Return host system info (platform, arch, hostname, cwd, node version, free/total memory).',
      execute: () => {
        if (!opts.enabled) return disabled('system.info');
        return { content: JSON.stringify({
          platform: process.platform, arch: process.arch, hostname: os.hostname(),
          cwd: process.cwd(), node: process.version,
          memTotal: os.totalmem(), memFree: os.freemem(),
          uptime: os.uptime(), loadavg: os.loadavg()
        }) };
      }
    },
    {
      name: 'fs.read',
      description: 'Read a file from the local filesystem. Input: JSON {path}. Allowlisted to GARUD_FS_ALLOW dirs.',
      execute: async (input) => {
        if (!opts.enabled) return disabled('fs.read');
        try {
          const p = (JSON.parse(input) as { path: string }).path;
          if (!p || !pathAllowed(p)) return { content: 'fs.read: path not allowed', error: true };
          const stat = await fs.stat(p);
          if (stat.size > maxBytes) return { content: `fs.read: file too large (>${maxBytes} bytes)`, error: true };
          const body = await fs.readFile(p, 'utf8');
          return { content: body };
        } catch (e) { return { content: `fs.read: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'fs.write',
      description: 'Write a file to the local filesystem. Input: JSON {path, body}. Allowlisted.',
      execute: async (input) => {
        if (!opts.enabled) return disabled('fs.write');
        try {
          const p = JSON.parse(input) as { path: string; body: string };
          if (!p.path || !pathAllowed(p.path)) return { content: 'fs.write: path not allowed', error: true };
          if (typeof p.body !== 'string') return { content: 'fs.write: body must be a string', error: true };
          if (Buffer.byteLength(p.body, 'utf8') > maxBytes) return { content: 'fs.write: body too large', error: true };
          await fs.mkdir(path.dirname(p.path), { recursive: true });
          const tmp = `${p.path}.tmp`;
          await fs.writeFile(tmp, p.body, 'utf8');
          await fs.rename(tmp, p.path);
          return { content: JSON.stringify({ ok: true, bytes: Buffer.byteLength(p.body, 'utf8') }) };
        } catch (e) { return { content: `fs.write: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'fs.list',
      description: 'List a directory. Input: JSON {path}. Allowlisted.',
      execute: async (input) => {
        if (!opts.enabled) return disabled('fs.list');
        try {
          const p = (JSON.parse(input) as { path: string }).path;
          if (!p || !pathAllowed(p)) return { content: 'fs.list: path not allowed', error: true };
          const entries = await fs.readdir(p, { withFileTypes: true });
          return { content: JSON.stringify(entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' }))) };
        } catch (e) { return { content: `fs.list: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'shell.exec',
      description: 'Run a shell command. Input: JSON {cmd, cwd?}. Allowlist via GARUD_EXEC_ALLOW. 15s timeout.',
      execute: async (input) => {
        if (!opts.enabled) return disabled('shell.exec');
        try {
          const p = JSON.parse(input) as { cmd: string; cwd?: string };
          if (!p.cmd) return { content: 'shell.exec: cmd required', error: true };
          if (!cmdAllowed(p.cmd)) return { content: 'shell.exec: command not in allowlist', error: true };
          if (p.cwd && !pathAllowed(p.cwd)) return { content: 'shell.exec: cwd not allowed', error: true };
          const out = await execp(p.cmd, { cwd: p.cwd, timeout: execTimeout, maxBuffer: maxBytes });
          return { content: JSON.stringify({ stdout: out.stdout.toString().slice(0, maxBytes), stderr: out.stderr.toString().slice(0, 8192) }) };
        } catch (e) {
          const err = e as { message: string; stdout?: string; stderr?: string; code?: number; signal?: string };
          return { content: JSON.stringify({ error: err.message, code: err.code, signal: err.signal, stdout: err.stdout, stderr: err.stderr }), error: true };
        }
      }
    },
    {
      name: 'env.read',
      description: 'Return non-secret environment variables (masks anything matching TOKEN|SECRET|KEY|PASSWORD).',
      execute: () => {
        if (!opts.enabled) return disabled('env.read');
        const masked: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (/TOKEN|SECRET|KEY|PASSWORD/i.test(k)) masked[k] = '***';
          else if (v !== undefined) masked[k] = v;
        }
        return { content: JSON.stringify(masked) };
      }
    }
  ];
}
