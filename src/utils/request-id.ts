import { randomBytes } from 'node:crypto';

/** Generate a short, opaque request id suitable for tracing. */
export function newRequestId(): string {
  return randomBytes(6).toString('hex');
}
