import { newRequestId } from '../utils/request-id.js';

/**
 * Device-node registry (OpenClaw-inspired). Tracks paired devices that
 * connect via WebSocket and can execute remote invocations (screenshot,
 * exec, geo, etc.). Each node is identified by a stable id and has a
 * capability set advertised on registration.
 */
export interface DeviceNode {
  id: string;
  name: string;
  platform: 'macos' | 'ios' | 'android' | 'linux' | 'windows' | 'headless' | 'browser';
  capabilities: string[];
  connectedAt: number;
  lastSeenAt: number;
  /** Per-WS client ref used by the WS server to route invocations. Opaque. */
  clientRef?: string;
  metadata: Record<string, unknown>;
}

export interface NodeInvocation {
  id: string;
  nodeId: string;
  capability: string;
  input: unknown;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: unknown;
  error?: string;
  issuedAt: number;
  finishedAt?: number;
}

export class NodeRegistry {
  private readonly nodes = new Map<string, DeviceNode>();
  private readonly invocations = new Map<string, NodeInvocation>();
  private readonly pendingResolvers = new Map<string, (v: NodeInvocation) => void>();

  register(input: { id?: string; name: string; platform: DeviceNode['platform']; capabilities: string[]; clientRef?: string; metadata?: Record<string, unknown> }): DeviceNode {
    const id = input.id ?? newRequestId();
    const now = Date.now();
    const node: DeviceNode = {
      id,
      name: input.name,
      platform: input.platform,
      capabilities: input.capabilities,
      connectedAt: now,
      lastSeenAt: now,
      clientRef: input.clientRef,
      metadata: input.metadata ?? {}
    };
    this.nodes.set(id, node);
    return node;
  }

  unregister(id: string): boolean { return this.nodes.delete(id); }

  touch(id: string): void {
    const node = this.nodes.get(id);
    if (node) node.lastSeenAt = Date.now();
  }

  get(id: string): DeviceNode | undefined { return this.nodes.get(id); }

  list(): DeviceNode[] { return [...this.nodes.values()]; }

  /** Issue a pending invocation. The transport (WS) is responsible for delivery. */
  invoke(nodeId: string, capability: string, input: unknown): NodeInvocation {
    const inv: NodeInvocation = {
      id: newRequestId(),
      nodeId,
      capability,
      input,
      status: 'pending',
      issuedAt: Date.now()
    };
    this.invocations.set(inv.id, inv);
    return inv;
  }

  /** Resolve an invocation with a result (called by transport when node responds). */
  resolve(invocationId: string, result: unknown): NodeInvocation | undefined {
    const inv = this.invocations.get(invocationId);
    if (!inv) return undefined;
    inv.status = 'done';
    inv.result = result;
    inv.finishedAt = Date.now();
    this.pendingResolvers.get(invocationId)?.(inv);
    this.pendingResolvers.delete(invocationId);
    return inv;
  }

  reject(invocationId: string, error: string): NodeInvocation | undefined {
    const inv = this.invocations.get(invocationId);
    if (!inv) return undefined;
    inv.status = 'failed';
    inv.error = error;
    inv.finishedAt = Date.now();
    this.pendingResolvers.get(invocationId)?.(inv);
    this.pendingResolvers.delete(invocationId);
    return inv;
  }

  /** Wait for an invocation to settle, with a timeout. */
  wait(invocationId: string, timeoutMs = 10_000): Promise<NodeInvocation> {
    const existing = this.invocations.get(invocationId);
    if (!existing) return Promise.reject(new Error('invocation not found'));
    if (existing.status === 'done' || existing.status === 'failed') return Promise.resolve(existing);
    return new Promise<NodeInvocation>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolvers.delete(invocationId);
        reject(new Error('invocation timeout'));
      }, timeoutMs);
      this.pendingResolvers.set(invocationId, (inv) => { clearTimeout(timer); resolve(inv); });
    });
  }

  getInvocation(id: string): NodeInvocation | undefined { return this.invocations.get(id); }

  listInvocations(): NodeInvocation[] {
    return [...this.invocations.values()].sort((a, b) => b.issuedAt - a.issuedAt);
  }

  /** List nodes that advertise a given capability. */
  byCapability(capability: string): DeviceNode[] {
    return [...this.nodes.values()].filter((n) => n.capabilities.includes(capability));
  }

  /** List nodes that have not been seen in the last `ms` milliseconds. */
  idle(ms: number): DeviceNode[] {
    const cutoff = Date.now() - ms;
    return [...this.nodes.values()].filter((n) => n.lastSeenAt < cutoff);
  }

  /** Aggregate counters. */
  stats(): { nodes: number; invocations: { pending: number; running: number; done: number; failed: number; total: number } } {
    const inv = { pending: 0, running: 0, done: 0, failed: 0, total: 0 };
    for (const i of this.invocations.values()) {
      inv[i.status] += 1;
      inv.total += 1;
    }
    return { nodes: this.nodes.size, invocations: inv };
  }
}
