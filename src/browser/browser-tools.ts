import type { ToolDefinition, ToolResult } from '../types.js';

/**
 * Browser-control tools. Disabled by default; enable with
 * `GARUD_BROWSER=1`. When enabled but no driver is installed, the tools
 * return a structured error so the brain can degrade gracefully.
 *
 * Implementation strategy: we don't bundle Playwright (zero-deps rule).
 * Instead, the tools shell out to a *user-provided* CDP/playwright CLI via
 * `GARUD_BROWSER_BIN` (default `chromium`). For richer control the user
 * can run a local Playwright MCP server and connect via mcp.connect.
 *
 * For most use cases the two essentials \u2014 fetching a rendered page and
 * grabbing a screenshot \u2014 are enough; both shell out to the binary.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execp = promisify(exec);

export interface BrowserToolsOptions {
  enabled: boolean;
  /** Browser binary. Default 'chromium'. Set GARUD_BROWSER_BIN to override. */
  binary?: string;
  /** Timeout for any browser operation in ms. Default 30s. */
  timeoutMs?: number;
}

export function buildBrowserTools(opts: BrowserToolsOptions): ToolDefinition[] {
  const binary = opts.binary ?? 'chromium';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const disabled = (name: string): ToolResult => ({ content: `${name}: browser disabled (set GARUD_BROWSER=1)`, error: true });

  return [
    {
      name: 'browser.fetch',
      description: 'Fetch a URL with JS rendering. Input: JSON {url, waitMs?}. Requires GARUD_BROWSER=1.',
      execute: async (input) => {
        if (!opts.enabled) return disabled('browser.fetch');
        try {
          const p = JSON.parse(input) as { url: string; waitMs?: number };
          if (!/^https?:\/\//.test(p.url)) return { content: 'browser.fetch: invalid url', error: true };
          const wait = Math.max(0, Math.min(15_000, p.waitMs ?? 2000));
          const outFile = path.join(os.tmpdir(), `garud-bf-${Date.now()}-${Math.floor(Math.random() * 1e6)}.html`);
          // Use --dump-dom-only flags supported by chromium/chrome.
          const cmd = `${shellQuote(binary)} --headless=new --disable-gpu --no-sandbox --virtual-time-budget=${wait} --dump-dom ${shellQuote(p.url)} > ${shellQuote(outFile)}`;
          await execp(cmd, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
          const html = await fs.readFile(outFile, 'utf8').catch(() => '');
          fs.unlink(outFile).catch(() => { /* ignore */ });
          return { content: html.slice(0, 512 * 1024) };
        } catch (e) {
          return { content: `browser.fetch: ${(e as Error).message}`, error: true };
        }
      }
    },
    {
      name: 'browser.screenshot',
      description: 'Take a PNG screenshot of a URL. Input: JSON {url, outPath, width?, height?}. Requires GARUD_BROWSER=1.',
      execute: async (input) => {
        if (!opts.enabled) return disabled('browser.screenshot');
        try {
          const p = JSON.parse(input) as { url: string; outPath: string; width?: number; height?: number };
          if (!/^https?:\/\//.test(p.url)) return { content: 'browser.screenshot: invalid url', error: true };
          if (!p.outPath) return { content: 'browser.screenshot: outPath required', error: true };
          const w = Math.max(320, Math.min(3840, p.width ?? 1280));
          const h = Math.max(240, Math.min(2160, p.height ?? 800));
          const cmd = `${shellQuote(binary)} --headless=new --disable-gpu --no-sandbox --hide-scrollbars --window-size=${w},${h} --screenshot=${shellQuote(p.outPath)} ${shellQuote(p.url)}`;
          await execp(cmd, { timeout: timeoutMs });
          const stat = await fs.stat(p.outPath);
          return { content: JSON.stringify({ ok: true, outPath: p.outPath, bytes: stat.size }) };
        } catch (e) {
          return { content: `browser.screenshot: ${(e as Error).message}`, error: true };
        }
      }
    },
    {
      name: 'browser.info',
      description: 'Probe the configured browser binary (version string if available).',
      execute: async () => {
        if (!opts.enabled) return disabled('browser.info');
        try {
          const out = await execp(`${shellQuote(binary)} --version`, { timeout: 5000 });
          return { content: JSON.stringify({ binary, version: out.stdout.trim() }) };
        } catch (e) {
          return { content: JSON.stringify({ binary, error: (e as Error).message }), error: true };
        }
      }
    }
  ];
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=,@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
