import type { SimEvent } from './domain';

interface PendingChunk {
  bytes: number[];
  firstTimeNs: number;
  lastTimeNs: number;
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const ANSI_ESCAPE_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function hexBytes(value: unknown): number[] | undefined {
  if (!value || typeof value !== 'object' || !('hex' in value)) return undefined;
  const hex = (value as { hex?: unknown }).hex;
  if (typeof hex !== 'string' || hex.length % 2 || !/^[\da-f]*$/i.test(hex)) return undefined;
  return hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
}

function textValue(bytes: number[]): string | undefined {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)).replace(ANSI_ESCAPE_SEQUENCES, '');
    return CONTROL_CHARACTERS.test(value) ? undefined : value;
  } catch {
    return undefined;
  }
}

function toEvent(endpoint: string, pending: PendingChunk): SimEvent {
  const text = textValue(pending.bytes);
  return {
    endpoint,
    kind: 'uart',
    timeNs: pending.lastTimeNs,
    value: text === undefined
      ? { hex: pending.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('') }
      : text,
    receivedAt: Date.now(),
  };
}

/** Groups decoded UART byte notifications into readable lines or binary packets. */
export class UartStreamGrouper {
  constructor(readonly idleGapNs = 20_000_000, readonly maxChunkBytes = 512) {
    if (!Number.isSafeInteger(idleGapNs) || idleGapNs < 1) throw new Error('UART idle gap must be a positive number of nanoseconds.');
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) throw new Error('UART chunk size must be positive.');
  }

  private readonly pending = new Map<string, PendingChunk>();

  feed(event: SimEvent): SimEvent[] {
    if (event.kind !== 'uart') return [event];
    const bytes = hexBytes(event.value);
    if (!bytes) return [event];

    const emitted = this.flushDue(event.timeNs);
    if (!bytes.length) return emitted;
    const current = this.pending.get(event.endpoint) ?? {
      bytes: [], firstTimeNs: event.timeNs, lastTimeNs: event.timeNs,
    };
    current.bytes.push(...bytes);
    current.lastTimeNs = event.timeNs;
    emitted.push(...this.extractLines(event.endpoint, current));
    while (current.bytes.length >= this.maxChunkBytes) {
      const chunk = current.bytes.splice(0, this.maxChunkBytes);
      emitted.push(toEvent(event.endpoint, { bytes: chunk, firstTimeNs: current.firstTimeNs, lastTimeNs: current.lastTimeNs }));
      current.firstTimeNs = current.lastTimeNs;
    }
    if (current.bytes.length) this.pending.set(event.endpoint, current);
    else this.pending.delete(event.endpoint);
    return emitted;
  }

  advance(timeNs: number): SimEvent[] {
    return this.flushDue(timeNs);
  }

  flushAll(): SimEvent[] {
    const emitted: SimEvent[] = [];
    for (const [endpoint, pending] of this.pending) {
      emitted.push(...this.extractLines(endpoint, pending, true));
      if (pending.bytes.length) emitted.push(toEvent(endpoint, pending));
    }
    this.pending.clear();
    return emitted;
  }

  private flushDue(timeNs: number): SimEvent[] {
    const emitted: SimEvent[] = [];
    for (const [endpoint, pending] of this.pending) {
      if (timeNs - pending.lastTimeNs < this.idleGapNs) continue;
      emitted.push(...this.extractLines(endpoint, pending, true));
      if (pending.bytes.length) emitted.push(toEvent(endpoint, pending));
      this.pending.delete(endpoint);
    }
    return emitted;
  }

  private extractLines(endpoint: string, pending: PendingChunk, finalize = false): SimEvent[] {
    const emitted: SimEvent[] = [];
    let lineStart = 0;
    while (lineStart < pending.bytes.length) {
      let newline = -1;
      for (let index = lineStart; index < pending.bytes.length; index += 1) {
        if (pending.bytes[index] === 0x0a || pending.bytes[index] === 0x0d) {
          newline = index;
          break;
        }
      }
      if (newline < 0) break;
      if (pending.bytes[newline] === 0x0d && newline === pending.bytes.length - 1 && !finalize) break;
      const line = pending.bytes.slice(lineStart, newline);
      const text = textValue(line);
      if (text === undefined) break;
      if (text.length) emitted.push({ endpoint, kind: 'uart', timeNs: pending.lastTimeNs, value: text, receivedAt: Date.now() });
      lineStart = newline + 1;
      if (pending.bytes[newline] === 0x0d && pending.bytes[lineStart] === 0x0a) lineStart += 1;
    }
    if (lineStart) {
      pending.bytes.splice(0, lineStart);
      pending.firstTimeNs = pending.lastTimeNs;
    }
    return emitted;
  }
}
