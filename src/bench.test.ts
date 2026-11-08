import { describe, expect, it } from 'vitest';
import type { BenchDraft } from './domain';
import { benchActions, benchYaml, netId } from './bench';
import { parseWorldYaml } from './yaml';

const draft: BenchDraft = {
  cpus: [{ id: 'board', model: 'tlsr8258' }, { id: 'router', model: 'nrf52840' }],
  components: [
    { id: 'uart_log', kind: 'hardware-uart', cpuId: 'board', port: 'uart0', baudNote: '115200' },
    { id: 'debug_uart', kind: 'soft-uart', cpuId: 'board', txPin: 'PA1', rxPin: 'PA2', baud: 9600 },
    { id: 'reset_button', kind: 'gpio-control', cpuId: 'board', pin: 'PA3', label: 'Reset', control: 'button', active: 'low', initial: false },
  ],
  steps: [
    { id: 'send_cmd', kind: 'hardware-uart-send', componentId: 'uart_log', afterMs: 500, hex: '24 01' },
    { id: 'press', kind: 'gpio-set', componentId: 'reset_button', afterMs: 500, pressed: true },
    { id: 'release', kind: 'gpio-set', componentId: 'reset_button', afterMs: 100, pressed: false },
    { id: 'soft_send', kind: 'soft-uart-send', componentId: 'debug_uart', afterMs: 10, text: 'A' },
  ],
  radioEnabled: true,
  capturePcap: true,
};

describe('block bench YAML and actions', () => {
  it('generates valid mcuemu YAML with per-CPU firmware, GPIO nets and PCAP capture', () => {
    const result = benchYaml(draft);
    const parsed = parseWorldYaml(result.yaml);
    expect(parsed.needs.map((need) => need.deviceId)).toEqual(['board', 'router']);
    expect(parsed.value.nets).toHaveLength(3);
    expect(parsed.value.attach).toEqual([{ endpoint: 'air0', sink: 'pcap:captures/air0-zigbee.pcap,zigbee' }]);
    expect(result.capturePaths).toEqual(['/captures/air0-zigbee.pcap']);
    expect(result.netLabels[netId('board', 'PA1')]).toBe('board.main.PA1');
  });

  it('keeps scenario delays cumulative and sends binary UART bytes through RPC actions', () => {
    const actions = benchActions(draft);
    expect(actions.find((action) => action.kind === 'set')).toEqual({
      atNs: 500_000_000,
      kind: 'set',
      endpoint: 'board.main.uart0',
      value: { hex: '2401' },
    });
    expect(actions.find((action) => action.kind === 'drive' && action.net === netId('board', 'PA3'))).toEqual({
      atNs: 1_000_000_000, kind: 'drive', net: netId('board', 'PA3'), state: 'low',
    });
    expect(actions.filter((action) => action.kind === 'drive' && action.net === netId('board', 'PA2')).length).toBeGreaterThan(1);
    expect(actions.at(-1)?.atNs).toBeCloseTo(1_110_937_500);
  });

  it('rejects malformed HEX commands rather than silently changing them', () => {
    const malformed = structuredClone(draft);
    const step = malformed.steps[0];
    if (step.kind === 'hardware-uart-send') step.hex = '0g';
    expect(() => benchActions(malformed)).toThrow(/HEX/);
  });
});
