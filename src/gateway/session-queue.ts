export type SessionQueueMode = 'queue' | 'steer' | 'reject';

export class QueueSupersededError extends Error {
  constructor() {
    super('superseded by a newer message');
    this.name = 'QueueSupersededError';
  }
}

export class QueueBusyError extends Error {
  constructor(message = 'session queue is full') {
    super(message);
    this.name = 'QueueBusyError';
  }
}

interface PendingJob {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface Lane {
  running: boolean;
  pending: PendingJob[];
}

/**
 * Per-session serial executor with OpenClaw-style queue modes:
 *   - queue — messages wait their turn (FIFO, bounded by maxDepth)
 *   - steer — a newer message replaces any not-yet-started pending one
 *   - reject — concurrent messages are refused while one is running
 */
export class SessionQueue {
  private readonly lanes = new Map<string, Lane>();
  private readonly mode: SessionQueueMode;
  private readonly maxDepth: number;

  constructor(options: { mode?: SessionQueueMode | 'off'; maxDepth?: number } = {}) {
    this.mode = options.mode === 'off' || options.mode === undefined ? 'queue' : options.mode;
    this.maxDepth = Math.max(1, options.maxDepth ?? 8);
  }

  getMode(): SessionQueueMode {
    return this.mode;
  }

  stats(): { lanes: number; pending: number; running: number } {
    let pending = 0;
    let running = 0;
    for (const lane of this.lanes.values()) {
      pending += lane.pending.length;
      if (lane.running) running += 1;
    }
    return { lanes: this.lanes.size, pending, running };
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(key) ?? { running: false, pending: [] };
    this.lanes.set(key, lane);
    if (lane.running) {
      if (this.mode === 'reject') {
        return Promise.reject(new QueueBusyError('a message is already being processed for this session'));
      }
      if (this.mode === 'steer') {
        for (const stale of lane.pending.splice(0)) stale.reject(new QueueSupersededError());
      } else if (lane.pending.length >= this.maxDepth) {
        return Promise.reject(new QueueBusyError());
      }
      return new Promise<T>((resolve, reject) => {
        lane.pending.push({
          fn: fn as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject
        });
      });
    }
    lane.running = true;
    return this.execute(key, lane, fn);
  }

  private async execute<T>(key: string, lane: Lane, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      this.drain(key, lane);
    }
  }

  private drain(key: string, lane: Lane): void {
    const next = lane.pending.shift();
    if (!next) {
      lane.running = false;
      this.lanes.delete(key);
      return;
    }
    void (async () => {
      try {
        next.resolve(await next.fn());
      } catch (error) {
        next.reject(error);
      } finally {
        this.drain(key, lane);
      }
    })();
  }
}
