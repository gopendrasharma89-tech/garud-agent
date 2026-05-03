import { describe, expect, it } from 'vitest';
import { AuditLogger, InMemoryAuditLog } from '../src/core/audit-log.js';

describe('AuditLogger', () => {
  it('records entries to all sinks', async () => {
    const logger = new AuditLogger();
    const sink = new InMemoryAuditLog();
    logger.addSink(sink);
    await logger.record('message', { x: 1 }, 'sess-1');
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.detail.x).toBe(1);
    expect(sink.entries[0]?.sessionId).toBe('sess-1');
  });

  it('exposes the in-memory sink directly', async () => {
    const logger = new AuditLogger();
    const sink = new InMemoryAuditLog();
    logger.addSink(sink);
    expect(logger.getInMemorySink()).toBe(sink);
  });

  it('filters in-memory log by sessionId and kind', async () => {
    const logger = new AuditLogger();
    const sink = new InMemoryAuditLog();
    logger.addSink(sink);
    await logger.record('message', {}, 'a');
    await logger.record('reply', {}, 'a');
    await logger.record('reply', {}, 'b');
    expect(sink.list({ sessionId: 'a' })).toHaveLength(2);
    expect(sink.list({ kind: 'reply' })).toHaveLength(2);
    expect(sink.list({ sessionId: 'a', kind: 'reply' })).toHaveLength(1);
  });

  it('does not block on failing sinks', async () => {
    const logger = new AuditLogger();
    logger.addSink({ append: () => { throw new Error('disk error'); } });
    const memSink = new InMemoryAuditLog();
    logger.addSink(memSink);
    await logger.record('system', {});
    expect(memSink.entries).toHaveLength(1);
  });

  it('caps in-memory entries to maxEntries', async () => {
    const logger = new AuditLogger();
    const sink = new InMemoryAuditLog(3);
    logger.addSink(sink);
    for (let i = 0; i < 5; i++) await logger.record('message', { i });
    expect(sink.entries).toHaveLength(3);
    expect(sink.entries[0]?.detail.i).toBe(2);
  });

  it('clear empties the in-memory sink', async () => {
    const logger = new AuditLogger();
    const sink = new InMemoryAuditLog();
    logger.addSink(sink);
    await logger.record('message', {});
    sink.clear();
    expect(sink.size()).toBe(0);
  });

  it('removeSinks resets registrations', async () => {
    const logger = new AuditLogger();
    const sink = new InMemoryAuditLog();
    logger.addSink(sink);
    logger.removeSinks();
    await logger.record('message', {});
    expect(sink.size()).toBe(0);
    expect(logger.getInMemorySink()).toBeUndefined();
  });
});
