import { stringify } from 'yaml';
import { firmwareKey, modelInfo, type BenchDraft, type FirmwareNeed } from './domain';
import type { ConfigObject } from './yaml';

export interface BenchYamlResult {
  yaml: string;
  needs: FirmwareNeed[];
  netLabels: Record<string, string>;
  capturePaths: string[];
}

export type BenchAction =
  | { atNs: number; kind: 'set'; endpoint: string; value: { hex: string } }
  | { atNs: number; kind: 'drive'; net: string; state: 'low' | 'high' | 'hiz' };

export function netId(cpuId: string, pin: string): string {
  const safePin = pin.replaceAll('.', '_');
  return `net_${cpuId}_${safePin}`;
}

function pushUartBits(actions: BenchAction[], net: string, startNs: number, baud: number, bytes: Uint8Array): number {
  const bitNs = 1_000_000_000 / baud;
  let last = true;
  let cursor = startNs;
  const drive = (level: boolean, at: number) => {
    if (level !== last) actions.push({ atNs: at, kind: 'drive', net, state: level ? 'high' : 'low' });
    last = level;
  };
  for (const byte of bytes) {
    const frame = [false, ...Array.from({ length: 8 }, (_, bit) => Boolean(byte & (1 << bit))), true];
    frame.forEach((level, index) => drive(level, cursor + index * bitNs));
    cursor += frame.length * bitNs;
  }
  drive(true, cursor);
  return cursor;
}

export function benchActions(draft: BenchDraft): BenchAction[] {
  const actions: BenchAction[] = [];
  let elapsedMs = 0;
  for (const step of draft.steps) {
    if (!Number.isFinite(step.afterMs) || step.afterMs < 0) throw new Error(`Step ${step.id}: delay must be non-negative.`);
    elapsedMs += step.afterMs;
    const atNs = elapsedMs * 1_000_000;
    const component = draft.components.find((item) => item.id === step.componentId);
    if (!component) throw new Error(`Step ${step.id}: connected block not found.`);
    if (step.kind === 'hardware-uart-send' && component.kind === 'hardware-uart') {
      const hex = step.hex.replace(/[\s,:_-]/g, '').toLowerCase();
      if (hex.length % 2 || !/^[\da-f]*$/.test(hex)) throw new Error(`Step ${step.id}: HEX data must contain a whole number of bytes.`);
      if (!hex) throw new Error(`Step ${step.id}: enter at least one HEX byte.`);
      actions.push({ atNs, kind: 'set', endpoint: `${component.cpuId}.main.${component.port}`, value: { hex } });
    } else if (step.kind === 'gpio-set' && component.kind === 'gpio-control') {
      actions.push({
        atNs,
        kind: 'drive',
        net: netId(component.cpuId, component.pin),
        state: step.pressed ? component.active : 'hiz',
      });
    } else if (step.kind === 'soft-uart-send' && component.kind === 'soft-uart') {
      const bytes = new TextEncoder().encode(step.text);
      if (!bytes.length) throw new Error(`Step ${step.id}: enter text to send.`);
      if (bytes.length > 256) throw new Error(`Step ${step.id}: soft UART accepts up to 256 bytes at a time.`);
      pushUartBits(actions, netId(component.cpuId, component.rxPin), atNs, component.baud, bytes);
    } else {
      throw new Error(`Step ${step.id}: action type does not match the connected block.`);
    }
  }
  return actions.sort((a, b) => a.atNs - b.atNs);
}

/* Scenario actions use RPC so HEX commands stay binary-exact. The YAML
 * scenario parser currently accepts only scalar UART values. */

export function benchYaml(draft: BenchDraft): BenchYamlResult {
  if (!draft.cpus.length) throw new Error('Add at least one CPU block.');
  const needs: FirmwareNeed[] = [];
  const devices: ConfigObject[] = [];
  const nets: ConfigObject[] = [];
  const netLabels: Record<string, string> = {};
  const netPull = new Map<string, 'up' | 'down'>();
  const capturePaths: string[] = [];
  const hasRadio = draft.radioEnabled && draft.cpus.some((cpu) => modelInfo(cpu.model)?.radio);

  for (const cpu of draft.cpus) {
    const key = firmwareKey(cpu.id, 'main', 0);
    needs.push({ key, deviceId: cpu.id, mcuId: 'main', index: 0, sourcePath: `${cpu.id}.bin`, label: `${cpu.id}.main (${cpu.model}) · firmware` });
    const mcu: ConfigObject = { id: 'main', model: cpu.model, firmware: `firmware/${cpu.id}.bin` };
    if (cpu.model === 'tlsr8258') mcu.variant = 'F1K';
    if (hasRadio && modelInfo(cpu.model)?.radio) {
      mcu.radio = { air: 'air0', position: [draft.cpus.indexOf(cpu) * 3, 0, 1], tx_power_dbm: 10, protocols: ['zigbee'] };
    }
    devices.push({ id: cpu.id, mcus: [mcu] });
  }

  for (const component of draft.components) {
    const pins = component.kind === 'soft-uart'
      ? [component.txPin, component.rxPin]
      : component.kind === 'gpio-control' ? [component.pin] : [];
    for (const pin of pins) {
      const id = netId(component.cpuId, pin);
      netPull.set(id, component.kind === 'soft-uart' || component.kind === 'gpio-control' && component.active === 'low' ? 'up' : 'down');
      const label = `${component.cpuId}.main.${pin}`;
      netLabels[id] = label;
    }
  }
  for (const [id, pull] of netPull) {
    const label = netLabels[id];
    const cpuId = label.split('.')[0];
    const pin = label.slice(`${cpuId}.main.`.length);
    nets.push({ id, pull, pins: [`${cpuId}.main.${pin}`] });
  }

  const config: ConfigObject = {
    version: 1,
    world: { seed: 1, ...(hasRadio ? { radio: [{ id: 'air0', model: 'log_distance' }] } : {}) },
    devices,
    ...(nets.length ? { nets } : {}),
  };
  if (hasRadio && draft.capturePcap) {
    const path = 'captures/air0-zigbee.pcap';
    config.attach = [{ endpoint: 'air0', sink: `pcap:${path},zigbee` }];
    capturePaths.push(`/${path}`);
  }
  return { yaml: stringify(config, { lineWidth: 0 }), needs, netLabels, capturePaths };
}
