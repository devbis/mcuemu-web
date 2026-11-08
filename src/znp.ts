export interface ZnpFrame {
  type: number;
  subsystem: number;
  command: number;
  payload: number[];
}

export function encodeZnpSreq(subsystem: number, command: number, payload: number[] = []): number[] {
  if (payload.length > 250) throw new Error('ZNP payload is too large.');
  const length = payload.length;
  const command0 = (1 << 5) | subsystem;
  const body = [length, command0, command, ...payload];
  const checksum = body.reduce((sum, byte) => sum ^ byte, 0);
  return [0xfe, ...body, checksum];
}

export function znpStartupFromApp(): number[] {
  return encodeZnpSreq(0x05, 0x40);
}

export function znpPermitJoin(durationSeconds = 0xff): number[] {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 0xff) {
    throw new Error('ZNP permit-join duration must be 1..255 seconds.');
  }
  return encodeZnpSreq(0x05, 0x36, [0x02, 0x00, 0x00, durationSeconds, 0x01]);
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexValue(value: unknown): number[] | undefined {
  if (!value || typeof value !== 'object' || !('hex' in value)) return undefined;
  const hex = (value as { hex?: unknown }).hex;
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^\da-f]/i.test(hex)) return undefined;
  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 2) bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  return bytes;
}

export class ZnpStreamDecoder {
  private buffer: number[] = [];

  feed(bytes: number[]): ZnpFrame[] {
    this.buffer.push(...bytes);
    const frames: ZnpFrame[] = [];
    while (this.buffer.length) {
      const start = this.buffer.indexOf(0xfe);
      if (start < 0) {
        this.buffer = [];
        break;
      }
      if (start > 0) this.buffer.splice(0, start);
      if (this.buffer.length < 2) break;
      const length = this.buffer[1];
      const frameLength = length + 5;
      if (this.buffer.length < frameLength) break;
      const candidate = this.buffer.splice(0, frameLength);
      const checksum = candidate.slice(1, -1).reduce((sum, byte) => sum ^ byte, 0);
      if (checksum !== candidate[candidate.length - 1]) continue;
      const command0 = candidate[2];
      frames.push({
        type: command0 >> 5,
        subsystem: command0 & 0x1f,
        command: candidate[3],
        payload: candidate.slice(4, -1),
      });
    }
    return frames;
  }
}
