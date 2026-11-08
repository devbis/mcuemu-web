import { describe, expect, it } from 'vitest';
import { addBlockValue, editBlockValue, parseBlockYaml, removeBlockValue, renderBlockEditor, serializedWorld } from './blocks';

describe('block configuration editor', () => {
  it('edits scenario UART bytes and time without dropping unrelated YAML fields', () => {
    const root = {
      version: 1,
      devices: [{ id: 'coordinator', custom_option: 'keep-me', mcus: [{ id: 'main', model: 'tlsr8258', firmware: 'coordinator.bin' }] }],
      scenario: { events: [{ at: '2s', endpoint: 'coordinator.main.uart0', set: { hex: 'fe00' } }] },
      vendor_extension: { enabled: true },
    };
    editBlockValue(root, ['scenario', 'events', 0, 'at'], '3s');
    editBlockValue(root, ['scenario', 'events', 0, 'set', 'hex'], 'fe05');
    const roundTrip = parseBlockYaml(serializedWorld(root)) as typeof root;
    expect(roundTrip.scenario.events[0]).toMatchObject({ at: '3s', set: { hex: 'fe05' } });
    expect(roundTrip.devices[0].custom_option).toBe('keep-me');
    expect(roundTrip.vendor_extension).toEqual({ enabled: true });
  });

  it('can add and remove nested fields and array entries', () => {
    const root = { scenario: { events: [] as unknown[] } };
    addBlockValue(root, ['scenario', 'events'], 'item');
    expect(root.scenario.events).toEqual(['']);
    removeBlockValue(root, ['scenario', 'events', 0]);
    addBlockValue(root, ['scenario'], 'key', 'description');
    expect(root.scenario).toEqual({ events: [], description: '' });
  });

  it('renders unknown top-level sections as YAML-only blocks', () => {
    const html = renderBlockEditor({ version: 1, custom: { flag: true } }, {});
    expect(html).toContain('YAML only');
    expect(html).toContain('data-block-yaml="custom"');
  });
});
