import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorldStore } from './storage';

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('mcuemu-web');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('database blocked'));
  });
}

describe('world history in IndexedDB', () => {
  let store: WorldStore;
  beforeAll(async () => {
    await deleteDatabase();
    store = await WorldStore.open();
  });
  afterAll(async () => {
    store.close();
    await deleteDatabase();
  });

  it('updates repeat launches, keeps edited configs separate, and deduplicates firmware blobs', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const staged = { 'board.main#0': { hash: 'content-hash', name: 'firmware.bin', size: 4, bytes } };
    const common = { staged, watch: { uart: true, radio: true }, netLabels: {}, preset: 'single' as const };
    const first = await store.save({ ...common, title: 'First', yaml: 'version: 1\ndevices: []\n' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const repeated = await store.save({ ...common, title: 'First', yaml: 'version: 1\ndevices: []\n' });
    expect(repeated.id).toBe(first.id);
    expect(repeated.createdAt).toBe(first.createdAt);
    expect(repeated.lastRunAt).toBeGreaterThan(first.lastRunAt);

    const edited = await store.save({ ...common, title: 'Edited', yaml: 'version: 1\ndevices: []\n# changed config\n' });
    expect(edited.id).not.toBe(first.id);
    expect((await store.list()).length).toBe(2);
    expect((await store.blob('content-hash')).size).toBe(4);

    await store.remove(first.id);
    expect((await store.blob('content-hash')).size).toBe(4);
    await store.remove(edited.id);
    await expect(store.blob('content-hash')).rejects.toThrow(/Firmware not found in IndexedDB/);
  });
});
