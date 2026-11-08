import { describe, expect, it } from 'vitest';
import type { SimEvent } from './domain';
import { UartStreamGrouper } from './uart-stream';

function uart(timeNs: number, hex: string, endpoint = 'board.main.uart0'): SimEvent {
  return { endpoint, kind: 'uart', timeNs, value: { hex }, receivedAt: timeNs };
}

describe('UART stream grouping', () => {
  it('joins character notifications into complete text lines', () => {
    const grouper = new UartStreamGrouper();
    const output = [...'Ready'].flatMap((character, index) => grouper.feed(uart(index * 100_000, character.charCodeAt(0).toString(16))));
    expect(output).toEqual([]);
    expect(grouper.feed(uart(600_000, '0d0a'))).toMatchObject([{ value: 'Ready' }]);
    expect(grouper.flushAll()).toEqual([]);
  });

  it('strips Zephyr ANSI color/reset codes and still splits on CRLF', () => {
    const grouper = new UartStreamGrouper();
    const text = '\u001b[0m<inf> zigbee: Zigbee thread started\u001b[0m\r\n\u001b[1;33m<wrn> zigbee_persist: restore failed\u001b[0m\r\n';
    const hex = [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(grouper.feed(uart(1, hex))).toMatchObject([
      { value: '<inf> zigbee: Zigbee thread started' },
      { value: '<wrn> zigbee_persist: restore failed' },
    ]);
  });

  it('treats CRLF split across UART events as one line break and drops the empty LF row', () => {
    const grouper = new UartStreamGrouper();
    expect(grouper.feed(uart(0, '6f6b0d'))).toEqual([]);
    expect(grouper.feed(uart(1, '0a'))).toMatchObject([{ value: 'ok' }]);
    expect(grouper.flushAll()).toEqual([]);
  });

  it('flushes a partial printable line on idle and groups bytes into binary packets', () => {
    const grouper = new UartStreamGrouper(20_000_000);
    expect(grouper.feed(uart(0, '7265616479'))).toEqual([]);
    expect(grouper.advance(19_000_000)).toEqual([]);
    expect(grouper.advance(20_000_000)).toMatchObject([{ value: 'ready' }]);

    expect(grouper.feed(uart(30_000_000, '0102'))).toEqual([]);
    expect(grouper.feed(uart(31_000_000, '0a03'))).toEqual([]);
    expect(grouper.advance(51_000_000)).toMatchObject([{ value: { hex: '01020a03' } }]);
  });

  it('caps large binary chunks and leaves non-byte UART frame events untouched', () => {
    const grouper = new UartStreamGrouper(20_000_000, 3);
    expect(grouper.feed(uart(0, '0001020304'))).toMatchObject([
      { value: { hex: '000102' } },
    ]);
    expect(grouper.flushAll()).toMatchObject([{ value: { hex: '0304' } }]);
    const frames = { endpoint: 'board.main.uart0.frames', kind: 'uart', timeNs: 10, value: '0x41:perr', receivedAt: 10 } satisfies SimEvent;
    expect(grouper.feed(frames)).toEqual([frames]);
  });
});
