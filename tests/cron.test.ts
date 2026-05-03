import { describe, expect, it, vi } from 'vitest';
import { CronScheduler } from '../src/scheduler/cron.js';
import { noopLogger } from '../src/utils/logger.js';

describe('CronScheduler', () => {
  it('rejects duplicate ids', () => {
    const s = new CronScheduler(noopLogger);
    s.add({ id: 'a', interval: 100, task: () => undefined });
    expect(() => s.add({ id: 'a', interval: 100, task: () => undefined })).toThrow();
  });

  it('rejects non-positive intervals', () => {
    const s = new CronScheduler(noopLogger);
    expect(() => s.add({ id: 'a', interval: 0, task: () => undefined })).toThrow();
  });

  it('runNow invokes the task once', async () => {
    const s = new CronScheduler(noopLogger);
    const fn = vi.fn();
    s.add({ id: 'a', interval: 60_000, task: fn });
    await s.runNow('a');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('lists registered jobs', () => {
    const s = new CronScheduler(noopLogger);
    s.add({ id: 'a', interval: '5s', task: () => undefined });
    s.add({ id: 'b', interval: 1000, task: () => undefined, enabled: false });
    const list = s.list();
    expect(list).toHaveLength(2);
    expect(list.find((j) => j.id === 'a')?.intervalMs).toBe(5000);
    expect(list.find((j) => j.id === 'b')?.enabled).toBe(false);
  });

  it('parses interval strings', () => {
    const s = new CronScheduler(noopLogger);
    s.add({ id: 'm', interval: '2m', task: () => undefined });
    expect(s.list()[0]?.intervalMs).toBe(120_000);
  });

  it('start/stop is idempotent', () => {
    const s = new CronScheduler(noopLogger);
    s.add({ id: 'a', interval: 60_000, task: () => undefined });
    s.start();
    s.start();
    s.stop();
    s.stop();
  });

  it('captures task errors without crashing', async () => {
    const s = new CronScheduler(noopLogger);
    s.add({ id: 'bad', interval: 60_000, task: () => { throw new Error('boom'); } });
    await s.runNow('bad');
    expect(s.list()[0]?.errorCount).toBe(1);
  });

  it('remove cancels timer', () => {
    const s = new CronScheduler(noopLogger);
    s.add({ id: 'a', interval: 60_000, task: () => undefined });
    expect(s.remove('a')).toBe(true);
    expect(s.remove('a')).toBe(false);
  });
});
