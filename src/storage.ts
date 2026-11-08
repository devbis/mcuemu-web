import type { BenchDraft, FirmwareRef, StagedFirmware, StoredWorld, WatchOptions } from './domain';
import { activeLocale, translate } from './i18n';

interface BlobRow {
  hash: string;
  bytes: ArrayBuffer;
  size: number;
  name: string;
}

interface SaveWorldInput {
  title: string;
  yaml: string;
  staged: Record<string, StagedFirmware>;
  watch: WatchOptions;
  netLabels: Record<string, string>;
  preset: StoredWorld['preset'];
  bench?: BenchDraft;
  captures?: string[];
}

const DB_NAME = 'mcuemu-web';
const DB_VERSION = 1;

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB error.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not read from IndexedDB.'));
  });
}

async function sha256(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashFile(file: File): Promise<StagedFirmware> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { hash, name: file.name, size: bytes.byteLength, bytes };
}

export class WorldStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<WorldStore> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('worlds')) database.createObjectStore('worlds', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('blobs')) database.createObjectStore('blobs', { keyPath: 'hash' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB.'));
      request.onblocked = () => reject(new Error('IndexedDB is locked by another tab. Close it and reload the page.'));
    });
    return new WorldStore(db);
  }

  async save(input: SaveWorldInput): Promise<StoredWorld> {
    const firmwares: Record<string, FirmwareRef> = {};
    const sortedRefs: Record<string, string> = {};
    for (const [key, item] of Object.entries(input.staged).sort(([a], [b]) => a.localeCompare(b))) {
      firmwares[key] = { hash: item.hash, name: item.name, size: item.size };
      sortedRefs[key] = item.hash;
    }
    const signature = JSON.stringify({
      yaml: input.yaml.replace(/\r\n/g, '\n'),
      firmwares: sortedRefs,
      watch: input.watch,
      preset: input.preset,
      bench: input.bench ?? null,
      captures: input.captures ?? [],
    });
    const id = (await sha256(signature)).slice(0, 24);
    const worldsStore = this.db.transaction('worlds', 'readonly').objectStore('worlds');
    const existing = await requestValue(worldsStore.get(id)) as StoredWorld | undefined;
    const now = Date.now();
    const world: StoredWorld = {
      id,
      title: input.title.trim() || translate('Untitled'),
      yaml: input.yaml,
      firmwares,
      watch: { ...input.watch },
      netLabels: { ...input.netLabels },
      ...(input.bench ? { bench: structuredClone(input.bench) } : {}),
      ...(input.captures ? { captures: [...input.captures] } : {}),
      createdAt: existing?.createdAt ?? now,
      lastRunAt: now,
      preset: input.preset,
    };
    const transaction = this.db.transaction(['worlds', 'blobs'], 'readwrite');
    const blobStore = transaction.objectStore('blobs');
    for (const item of Object.values(input.staged)) {
      blobStore.put({ hash: item.hash, bytes: item.bytes, size: item.size, name: item.name } satisfies BlobRow);
    }
    transaction.objectStore('worlds').put(world);
    await transactionDone(transaction);
    return world;
  }

  async touch(id: string): Promise<StoredWorld> {
    const read = this.db.transaction('worlds', 'readonly');
    const current = await requestValue(read.objectStore('worlds').get(id)) as StoredWorld | undefined;
    await transactionDone(read);
    if (!current) {
      throw new Error('The saved world was already deleted. Refresh the list.');
    }
    const updated = { ...current, lastRunAt: Date.now() };
    const transaction = this.db.transaction('worlds', 'readwrite');
    transaction.objectStore('worlds').put(updated);
    await transactionDone(transaction);
    return updated;
  }

  async list(): Promise<StoredWorld[]> {
    const transaction = this.db.transaction('worlds', 'readonly');
    const rows = await requestValue(transaction.objectStore('worlds').getAll()) as StoredWorld[];
    await transactionDone(transaction);
    return rows.sort((a, b) => b.lastRunAt - a.lastRunAt);
  }

  async blob(hash: string): Promise<BlobRow> {
    const transaction = this.db.transaction('blobs', 'readonly');
    const row = await requestValue(transaction.objectStore('blobs').get(hash)) as BlobRow | undefined;
    await transactionDone(transaction);
    if (!row) throw new Error(`Firmware not found in IndexedDB: ${hash.slice(0, 12)}.`);
    return row;
  }

  async remove(id: string): Promise<void> {
    const read = this.db.transaction(['worlds', 'blobs'], 'readonly');
    const worldsRequest = read.objectStore('worlds').getAll();
    const blobsRequest = read.objectStore('blobs').getAll();
    const [worlds, blobs] = await Promise.all([
      requestValue(worldsRequest) as Promise<StoredWorld[]>,
      requestValue(blobsRequest) as Promise<BlobRow[]>,
    ]);
    await transactionDone(read);
    const transaction = this.db.transaction(['worlds', 'blobs'], 'readwrite');
    const worldsStore = transaction.objectStore('worlds');
    worldsStore.delete(id);
    const referenced = new Set<string>();
    for (const world of worlds) {
      if (world.id === id) continue;
      Object.values(world.firmwares).forEach((firmware) => referenced.add(firmware.hash));
    }
    const blobsStore = transaction.objectStore('blobs');
    for (const blob of blobs) if (!referenced.has(blob.hash)) blobsStore.delete(blob.hash);
    await transactionDone(transaction);
  }

  async estimate(): Promise<{ usage?: number; quota?: number }> {
    if (!navigator.storage?.estimate) return {};
    return navigator.storage.estimate();
  }

  close(): void {
    this.db.close();
  }
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return translate('unavailable');
  const russian = activeLocale() === 'ru';
  if (value < 1024) return `${value.toLocaleString(activeLocale())} ${russian ? 'Б' : 'B'}`;
  const units = russian ? ['КиБ', 'МиБ', 'ГиБ'] : ['KiB', 'MiB', 'GiB'];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; size >= 1024 && index < units.length; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toLocaleString(activeLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
}
