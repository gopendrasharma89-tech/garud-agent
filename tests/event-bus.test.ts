import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/event-bus.js';

interface Events {
  hello: { name: string };
  bye: { code: number };
}

describe('EventBus', () => {
  it('delivers events to subscribed handlers', () => {
    const bus = new EventBus<Events>();
    const handler = vi.fn();
    bus.on('hello', handler);
    bus.emit('hello', { name: 'world' });
    expect(handler).toHaveBeenCalledWith({ name: 'world' });
  });

  it('returns an unsubscribe function', () => {
    const bus = new EventBus<Events>();
    const handler = vi.fn();
    const off = bus.on('hello', handler);
    off();
    bus.emit('hello', { name: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('off() removes a specific handler', () => {
    const bus = new EventBus<Events>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('hello', a);
    bus.on('hello', b);
    bus.off('hello', a);
    bus.emit('hello', { name: 'x' });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('isolates errors via the error handler', () => {
    const bus = new EventBus<Events>();
    const errors: unknown[] = [];
    bus.setErrorHandler((_e, err) => errors.push(err));
    bus.on('hello', () => { throw new Error('boom'); });
    const survivor = vi.fn();
    bus.on('hello', survivor);
    bus.emit('hello', { name: 'x' });
    expect(errors).toHaveLength(1);
    expect(survivor).toHaveBeenCalled();
  });

  it('captures async rejections', async () => {
    const bus = new EventBus<Events>();
    const errors: unknown[] = [];
    bus.setErrorHandler((_e, err) => errors.push(err));
    bus.on('hello', async () => { throw new Error('async-boom'); });
    bus.emit('hello', { name: 'x' });
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);
  });

  it('reports listener counts', () => {
    const bus = new EventBus<Events>();
    bus.on('hello', () => undefined);
    bus.on('hello', () => undefined);
    expect(bus.listenerCount('hello')).toBe(2);
    bus.removeAll();
    expect(bus.listenerCount('hello')).toBe(0);
  });

  it('does nothing when emitting to unsubscribed events', () => {
    const bus = new EventBus<Events>();
    expect(() => bus.emit('bye', { code: 1 })).not.toThrow();
  });
});
