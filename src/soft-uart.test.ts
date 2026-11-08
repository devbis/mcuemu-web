import { describe, expect, it } from 'vitest';
import { SoftUartDecoder } from './soft-uart';

function transmit(decoder: SoftUartDecoder, value: number, startNs = 0, baud = 9600): number[] {
  const bit = 1_000_000_000 / baud;
  const levels = [false, ...Array.from({ length: 8 }, (_, index) => Boolean(value & (1 << index))), true];
  const output: number[] = [];
  levels.forEach((level, index) => output.push(...decoder.feed(startNs + index * bit, level)));
  output.push(...decoder.advance(startNs + 10 * bit));
  return output;
}

describe('soft UART decoder', () => {
  it('decodes LSB-first 8N1 at a manually selected baud rate', () => {
    const decoder = new SoftUartDecoder(9600);
    expect(transmit(decoder, 0x41)).toEqual([0x41]);
  });

  it('rejects a low stop bit and supports reset to idle', () => {
    const decoder = new SoftUartDecoder(115200);
    const bit = 1_000_000_000 / 115200;
    const levels = [false, true, false, false, false, false, false, false, true, false];
    const output: number[] = [];
    levels.forEach((level, index) => output.push(...decoder.feed(index * bit, level)));
    output.push(...decoder.advance(11 * bit));
    expect(output).toEqual([]);
    decoder.reset();
    expect(transmit(decoder, 0x5a, 20 * bit, 115200)).toEqual([0x5a]);
  });
});
