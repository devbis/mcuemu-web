import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { firmwareKey } from './domain';
import { RingBuffer } from './ring-buffer';
import { materializeYaml, parseWorldYaml, presetYaml } from './yaml';

const watch = { uart: true, radio: true };

describe('preset YAML', () => {
  it('generates one MCU config and creates nets for selected pins', () => {
    const generated = presetYaml({
      mode: 'single', singleModel: 'tlsr8258', coordinatorModel: 'tlsr8258', routerModel: 'nrf52840',
      watch, pins: [{ mcu: 'main', pin: 'PA0' }, { mcu: 'main', pin: 'PB1' }],
    });
    const config = parse(generated.yaml) as Record<string, any>;
    expect(config.devices[0].mcus[0]).toMatchObject({ model: 'tlsr8258', variant: 'F1K', firmware: 'firmware/board.bin' });
    expect(config.world.radio[0].id).toBe('air0');
    expect(config.nets).toHaveLength(2);
    expect(config.nets[0].pins).toEqual(['board.main.PA0']);
    expect(generated.netLabels.observed_pin_2).toBe('board.main.PB1');
    expect(generated.needs[0].key).toBe(firmwareKey('board', 'main', 0));
  });

  it('generates a radio-compatible coordinator/router pair with independent images', () => {
    const generated = presetYaml({
      mode: 'pair', singleModel: 'tlsr8258', coordinatorModel: 'tlsr8258', routerModel: 'nrf52840',
      watch, pins: [{ mcu: 'router.main', pin: 'P0.13' }],
    });
    const config = parse(generated.yaml) as Record<string, any>;
    expect(config.devices.map((device: any) => device.id)).toEqual(['coordinator', 'router']);
    expect(config.devices[0].mcus[0].radio.air).toBe('air0');
    expect(config.devices[1].mcus[0].radio.protocols).toEqual(['zigbee']);
    expect(config.nets[0].pins).toEqual(['router.main.P0.13']);
    expect(generated.needs.map((need) => need.key)).toEqual([
      firmwareKey('coordinator', 'main', 0), firmwareKey('router', 'main', 0),
    ]);
  });
});

describe('user YAML', () => {
  const valid = `version: 1
world:
  radio:
    - { id: air0, model: log_distance }
devices:
  - id: left
    mcus:
      - id: main
        model: tlsr8258
        firmware: images/gateway.bin
  - id: right
    mcus:
      - id: zb
        model: nrf52840
        firmware:
          - { file: images/sensor.bin, offset: 0 }
nets:
  - { id: led, pins: [right.zb.P0.13] }
`;

  it('finds images across MCUs and rewrites paths into the browser filesystem', () => {
    const result = parseWorldYaml(valid);
    expect(result.needs.map((need) => need.sourcePath)).toEqual(['images/gateway.bin', 'images/sensor.bin']);
    const refs = Object.fromEntries(result.needs.map((need) => [need.key, { hash: need.key === firmwareKey('left', 'main', 0) ? 'a'.repeat(64) : 'b'.repeat(64) }]));
    const loaded = parse(materializeYaml(valid, refs, 'test-world')) as Record<string, any>;
    expect(loaded.devices[0].mcus[0].firmware).toBe(`worlds/test-world/${'a'.repeat(64)}.bin`);
    expect(loaded.devices[1].mcus[0].firmware[0].file).toBe(`worlds/test-world/${'b'.repeat(64)}.bin`);
    expect(loaded.nets[0].id).toBe('led');
  });

  it('rejects include and Lua scripts with an actionable message', () => {
    expect(() => parseWorldYaml('version: 1\ndevices:\n  - include: node.yaml\n')).toThrow(/includes are not supported/);
    expect(() => parseWorldYaml('version: 1\ndevices: []\nparts:\n  - type: script\n    script: test.lua\n')).toThrow(/Lua scripts are not supported yet/);
  });

});

describe('event buffer', () => {
  it('keeps the most recent events up to its fixed capacity', () => {
    const ring = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((item) => ring.push(item));
    expect(ring.size).toBe(3);
    expect(ring.values()).toEqual([3, 4, 5]);
    ring.clear();
    expect(ring.values()).toEqual([]);
  });
});
