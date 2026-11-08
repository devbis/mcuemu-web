import { parse, stringify } from 'yaml';
import { firmwareKey, modelInfo, type FirmwareNeed, type ModelId, type WatchOptions } from './domain';

export type ConfigObject = Record<string, unknown>;

function record(value: unknown, context: string): ConfigObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context}: expected an object`);
  }
  return value as ConfigObject;
}

function nonempty(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${context}: enter a text value`);
  return value;
}

function findUnsupported(value: unknown, path = 'yaml'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findUnsupported(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const object = value as ConfigObject;
  if ('include' in object) throw new Error(`${path}: includes are not supported; load a single self-contained YAML file`);
  if ('script' in object || object.type === 'script') {
    throw new Error(`${path}: Lua scripts are not supported yet`);
  }
  for (const [key, item] of Object.entries(object)) findUnsupported(item, `${path}.${key}`);
}

export function parseWorldYaml(text: string): { value: ConfigObject; needs: FirmwareNeed[] } {
  if (!text.trim()) throw new Error('Add a YAML configuration.');
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error('YAML exceeds 1 MiB.');
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse YAML: ${message}`);
  }
  const root = record(parsed, 'YAML root');
  findUnsupported(root);
  if (root.version !== 1) throw new Error('Expected version: 1.');
  if (!Array.isArray(root.devices) || !root.devices.length) throw new Error('YAML must contain a non-empty devices list.');

  const needs: FirmwareNeed[] = [];
  for (const [deviceIndex, rawDevice] of root.devices.entries()) {
    const device = record(rawDevice, `devices[${deviceIndex}]`);
    const deviceId = nonempty(device.id, `devices[${deviceIndex}].id`);
    if (!Array.isArray(device.mcus) || !device.mcus.length) {
      throw new Error(`Device “${deviceId}” must contain an mcus list.`);
    }
    for (const [mcuIndex, rawMcu] of device.mcus.entries()) {
      const mcu = record(rawMcu, `${deviceId}.mcus[${mcuIndex}]`);
      const mcuId = nonempty(mcu.id, `${deviceId}.mcus[${mcuIndex}].id`);
      const model = nonempty(mcu.model, `${deviceId}.${mcuId}.model`);
      if (!modelInfo(model)) throw new Error(`Model “${model}” on ${deviceId}.${mcuId} is not supported by this version of mcuemu-web.`);
      if ('efuse' in mcu || 'rom' in mcu || 'rf_calibration' in mcu) {
        throw new Error(`${deviceId}.${mcuId}: ROM, eFuse, and RF calibration files cannot be loaded in the browser yet.`);
      }
      if (mcu.flash && typeof mcu.flash === 'object' && 'persist' in (mcu.flash as ConfigObject)) {
        throw new Error(`${deviceId}.${mcuId}: flash.persist files are not supported in the browser yet.`);
      }
      const firmware = mcu.firmware;
      const addNeed = (index: number, file: unknown) => {
        const sourcePath = nonempty(file, `${deviceId}.${mcuId}.firmware`);
        needs.push({
          key: firmwareKey(deviceId, mcuId, index),
          deviceId,
          mcuId,
          index,
          sourcePath,
          label: `${deviceId}.${mcuId} (${model}) · ${sourcePath}`,
        });
      };
      if (typeof firmware === 'string') addNeed(0, firmware);
      else if (Array.isArray(firmware) && firmware.length) {
        firmware.forEach((piece, index) => {
          addNeed(index, record(piece, `${deviceId}.${mcuId}.firmware[${index}]`).file);
        });
      } else {
        throw new Error(`${deviceId}.${mcuId}: firmware must be a path or a non-empty list of flash fragments.`);
      }
    }
  }
  return { value: root, needs };
}

export function materializeYaml(
  text: string,
  refs: Record<string, { hash: string }>,
  worldId: string,
): string {
  const { value, needs } = parseWorldYaml(text);
  const next = structuredClone(value) as ConfigObject;
  const deviceMap = new Map<string, ConfigObject>();
  for (const rawDevice of next.devices as unknown[]) {
    const device = rawDevice as ConfigObject;
    deviceMap.set(String(device.id), device);
  }
  for (const need of needs) {
    const ref = refs[need.key];
    if (!ref) throw new Error(`No firmware selected for ${need.label}.`);
    const device = deviceMap.get(need.deviceId)!;
    const mcu = (device.mcus as ConfigObject[]).find((item) => item.id === need.mcuId)!;
    const virtualPath = `worlds/${worldId}/${ref.hash}.bin`;
    if (typeof mcu.firmware === 'string') mcu.firmware = virtualPath;
    else (mcu.firmware as ConfigObject[])[need.index].file = virtualPath;
  }
  return stringify(next, { lineWidth: 0 });
}

export interface PresetPin {
  mcu: 'main' | 'coordinator.main' | 'router.main';
  pin: string;
}

export interface PresetOptions {
  mode: 'single' | 'pair';
  singleModel: ModelId;
  coordinatorModel: ModelId;
  routerModel: ModelId;
  watch: WatchOptions;
  pins: PresetPin[];
}

export function presetYaml(options: PresetOptions): { yaml: string; needs: FirmwareNeed[]; netLabels: Record<string, string> } {
  const devices: ConfigObject[] = [];
  const needs: FirmwareNeed[] = [];
  const nets: ConfigObject[] = [];
  const netLabels: Record<string, string> = {};
  const radioModels = options.mode === 'pair'
    ? [options.coordinatorModel, options.routerModel]
    : [options.singleModel];
  const hasRadio = radioModels.some((model) => modelInfo(model)?.radio);
  const roles = options.mode === 'single'
    ? [{ id: 'board', mcu: 'main', model: options.singleModel }]
    : [
        { id: 'coordinator', mcu: 'main', model: options.coordinatorModel },
        { id: 'router', mcu: 'main', model: options.routerModel },
      ];

  for (const role of roles) {
    const key = firmwareKey(role.id, role.mcu, 0);
    needs.push({ key, deviceId: role.id, mcuId: role.mcu, index: 0, sourcePath: `${role.id}.bin`, label: `${role.id}.${role.mcu} · firmware` });
    const mcu: ConfigObject = {
      id: role.mcu,
      model: role.model,
      firmware: `firmware/${role.id}.bin`,
    };
    if (role.model === 'tlsr8258') mcu.variant = 'F1K';
    if (modelInfo(role.model)?.radio) {
      mcu.radio = {
        air: 'air0',
        position: role.id === 'router' ? [4, 0, 1] : [0, 0, 1],
        tx_power_dbm: role.id === 'router' ? 4 : 10,
        protocols: ['zigbee'],
      };
    }
    devices.push({ id: role.id, mcus: [mcu] });
  }

  options.pins.forEach(({ mcu, pin }, index) => {
    const [deviceId, mcuId] = options.mode === 'single' ? ['board', 'main'] : mcu.split('.');
    const id = `observed_pin_${index + 1}`;
    const endpoint = options.mode === 'single' ? `${deviceId}.${mcuId}.${pin}` : `${deviceId}.${mcuId}.${pin}`;
    nets.push({ id, pins: [endpoint] });
    netLabels[id] = `${deviceId}.${mcuId}.${pin}`;
  });

  const config: ConfigObject = {
    version: 1,
    world: {
      seed: 1,
      ...(hasRadio ? { radio: [{ id: 'air0', model: 'log_distance' }] } : {}),
    },
    devices,
    ...(nets.length ? { nets } : {}),
  };
  const yaml = stringify(config, { lineWidth: 0 });
  return { yaml, needs, netLabels };
}

