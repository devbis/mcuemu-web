import { describe, expect, it } from 'vitest';
import { bytesToHex, encodeZnpSreq, ZnpStreamDecoder, znpPermitJoin, znpStartupFromApp } from './znp';

describe('Zephyr ZNP preset commands', () => {
  it('encodes ZDO_STARTUP_FROM_APP', () => {
    expect(bytesToHex(znpStartupFromApp())).toBe('fe00254065');
  });

  it('encodes a local, indefinite permit-join request', () => {
    expect(bytesToHex(znpPermitJoin())).toBe('fe052536020000ff01ea');
    expect(() => znpPermitJoin(0)).toThrow(/1\.\.255/);
  });

  it('decodes a fragmented coordinator state indication and ignores bad checksums', () => {
    const decoder = new ZnpStreamDecoder();
    expect(decoder.feed([0xfe, 0x01, 0x45])).toEqual([]);
    expect(decoder.feed([0xc0, 0x09, 0x8d])).toEqual([
      { type: 2, subsystem: 5, command: 0xc0, payload: [0x09] },
    ]);
    expect(decoder.feed(encodeZnpSreq(5, 0x36).map((byte, index, all) => index === all.length - 1 ? byte ^ 1 : byte))).toEqual([]);
  });
});
