/**
 * HEARTBEAT.md rule scheduler.
 *
 * Parses the rule prose into one of three deterministic schedule kinds:
 *
 *   - `every Ns|m|h|d|w`             → fixed interval
 *   - `daily at HH:MM`               → once per day at local clock time
 *   - `weekly` / `once per week`     → 7 days from boot, then every 7d
 *
 * Rules with no recognised schedule are returned as `kind: 'unscheduled'`
 * so the brain can still surface them in prose. Everything else fires a
 * user-supplied callback when due. Zero deps — uses setInterval/setTimeout.
 *
 * This is intentionally simpler than full cron: a real cron string can
 * still be used via the existing `CronScheduler` subsystem; HEARTBEAT.md
 * is for prose-level "agent reminders".
 */

export type HeartbeatScheduleKind = 'interval' | 'dailyAt' | 'weekly' | 'unscheduled';

export interface HeartbeatScheduledRule {
  section: string;
  rule: string;
  kind: HeartbeatScheduleKind;
  /** For 'interval': interval in ms. For 'dailyAt': ms until first fire. */
  everyMs?: number;
  /** For 'dailyAt': normalised HH:MM. */
  at?: string;
}

const INTERVAL_RE = /\bevery\s+(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours|d|day|days|w|wk|wks|weeks)\b/i;
// Prefer the `daily at HH:MM` variant; only fall back to bare `daily` if no
// time-qualified occurrence exists.
const DAILY_AT_RE = /\bdaily\s+at\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?\b/i;
const DAILY_BARE_RE = /\bdaily\b/i;
const WEEKLY_RE = /\b(?:weekly|once\s+a\s+week|once\s+per\s+week)\b/i;

export function parseHeartbeatSchedule(rule: string): { kind: HeartbeatScheduleKind; everyMs?: number; at?: string } {
  const r = rule.toLowerCase();
  const m = INTERVAL_RE.exec(r);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    const ms = unitToMs(unit) * n;
    if (ms >= 1000) return { kind: 'interval', everyMs: ms };
  }
  const dAt = DAILY_AT_RE.exec(r);
  if (dAt) {
    let hh = parseInt(dAt[1]!, 10);
    const mm = parseInt(dAt[2]!, 10);
    if (dAt[3]?.toLowerCase() === 'pm' && hh < 12) hh += 12;
    if (dAt[3]?.toLowerCase() === 'am' && hh === 12) hh = 0;
    if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) {
      return { kind: 'dailyAt', everyMs: msUntilDaily(hh, mm), at: `${pad(hh)}:${pad(mm)}` };
    }
  }
  if (DAILY_BARE_RE.test(r)) {
    return { kind: 'dailyAt', everyMs: msUntilDaily(9, 0), at: '09:00' };
  }
  if (WEEKLY_RE.test(r)) return { kind: 'weekly', everyMs: 7 * 24 * 60 * 60 * 1000 };
  return { kind: 'unscheduled' };
}

function unitToMs(u: string): number {
  if (u.startsWith('s')) return 1000;
  if (u.startsWith('m') && !u.startsWith('mo')) return u === 'm' || u.startsWith('mi') ? 60_000 : 60_000;
  if (u.startsWith('h')) return 60 * 60_000;
  if (u.startsWith('d')) return 24 * 60 * 60_000;
  if (u.startsWith('w')) return 7 * 24 * 60 * 60_000;
  return 60_000;
}

function msUntilDaily(hh: number, mm: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

function pad(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

export interface HeartbeatTickEvent {
  section: string;
  rule: string;
  kind: HeartbeatScheduleKind;
  firedAt: number;
}

/**
 * Schedules every HEARTBEAT.md rule it is given. Returns a `stop()` handle
 * that clears all timers. `onTick` is called with each scheduled fire.
 */
export class HeartbeatScheduler {
  private timers: NodeJS.Timeout[] = [];
  private rules: HeartbeatScheduledRule[] = [];
  private stopped = false;

  schedule(rules: Array<{ section: string; rule: string }>, onTick: (e: HeartbeatTickEvent) => void): HeartbeatScheduledRule[] {
    this.stop();
    this.stopped = false;
    this.rules = rules.map((r) => {
      const sched = parseHeartbeatSchedule(r.rule);
      const entry: HeartbeatScheduledRule = { section: r.section, rule: r.rule, kind: sched.kind };
      if (sched.everyMs !== undefined) entry.everyMs = sched.everyMs;
      if (sched.at !== undefined) entry.at = sched.at;
      if (entry.kind === 'interval' && entry.everyMs) {
        const t = setInterval(() => {
          if (!this.stopped) onTick({ section: r.section, rule: r.rule, kind: 'interval', firedAt: Date.now() });
        }, entry.everyMs);
        if (typeof t.unref === 'function') t.unref();
        this.timers.push(t);
      } else if (entry.kind === 'dailyAt' && entry.everyMs) {
        const firstFire = setTimeout(() => {
          if (this.stopped) return;
          onTick({ section: r.section, rule: r.rule, kind: 'dailyAt', firedAt: Date.now() });
          const daily = setInterval(() => {
            if (!this.stopped) onTick({ section: r.section, rule: r.rule, kind: 'dailyAt', firedAt: Date.now() });
          }, 24 * 60 * 60 * 1000);
          if (typeof daily.unref === 'function') daily.unref();
          this.timers.push(daily);
        }, entry.everyMs);
        if (typeof firstFire.unref === 'function') firstFire.unref();
        this.timers.push(firstFire);
      } else if (entry.kind === 'weekly' && entry.everyMs) {
        const t = setInterval(() => {
          if (!this.stopped) onTick({ section: r.section, rule: r.rule, kind: 'weekly', firedAt: Date.now() });
        }, entry.everyMs);
        if (typeof t.unref === 'function') t.unref();
        this.timers.push(t);
      }
      return entry;
    });
    return this.rules;
  }

  list(): HeartbeatScheduledRule[] { return [...this.rules]; }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
