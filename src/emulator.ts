import type { SimEvent, StoredWorld } from './domain';
import { materializeYaml } from './yaml';
import { WorldStore } from './storage';

interface FileSystemApi {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
}

interface WasmModule {
  ccall(
    name: string,
    returnType: 'number' | 'string' | null,
    argumentTypes: Array<'number' | 'string'>,
    arguments_: Array<number | string>,
  ): number | string | null;
  FS: FileSystemApi;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
}

export interface EndpointInfo {
  name: string;
  kind: string;
}

export interface SimStatus {
  loaded: boolean;
  running: boolean;
  speed: number;
  time_ns?: number;
  mcus?: Array<{ name: string; model: string; state: string; time_ns: number; message?: string }>;
}

export class EmulatorClient {
  private module?: WasmModule;
  private session = 0;
  private nextId = 1;
  private running = false;
  private endpointKinds = new Map<string, string>();
  private firmwarePaths: string[] = [];
  private eventListener?: (event: SimEvent) => void;
  private statusListener?: (status: SimStatus) => void;
  private faultListener?: (message: string) => void;

  setEventListener(listener: (event: SimEvent) => void): void { this.eventListener = listener; }
  setStatusListener(listener: (status: SimStatus) => void): void { this.statusListener = listener; }
  setFaultListener(listener: (message: string) => void): void { this.faultListener = listener; }

  async open(): Promise<void> {
    if (this.module) return;
    const modulePath = `${import.meta.env.BASE_URL}wasm/mcuemu-wasm.mjs`;
    const wasmPath = `${import.meta.env.BASE_URL}wasm/mcuemu-wasm.wasm`;
    let factory: (options?: Record<string, unknown>) => Promise<WasmModule>;
    let moduleUrl: string | undefined;
    try {
      const response = await fetch(modulePath);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${modulePath}`);
      moduleUrl = URL.createObjectURL(await response.blob());
      const imported = await import(/* @vite-ignore */ moduleUrl) as { default: typeof factory };
      factory = imported.default;
    } catch (error) {
      throw new Error(`Could not load the WASM module (${error instanceof Error ? error.message : String(error)}). Check the files in public/wasm/.`);
    } finally {
      if (moduleUrl) URL.revokeObjectURL(moduleUrl);
    }
    this.module = await factory({ locateFile: (path: string) => path.endsWith('.wasm') ? wasmPath : path });
    const session = this.module.ccall('mcuemu_wasm_session_create', 'number', ['string'], ['/']);
    if (typeof session !== 'number' || session === 0) throw new Error('Could not create a WASM emulator session.');
    this.session = session;
  }

  async loadWorld(world: StoredWorld, store: WorldStore): Promise<EndpointInfo[]> {
    await this.open();
    if (this.running) await this.call('pause');
    await this.call('unload').catch(() => undefined);
    for (const path of this.firmwarePaths) {
      try { this.module!.FS.unlink(path); } catch { /* the VFS may have been reset */ }
    }
    this.firmwarePaths = [];
    const needed = new Map<string, ArrayBuffer>();
    for (const ref of Object.values(world.firmwares)) {
      if (!needed.has(ref.hash)) needed.set(ref.hash, (await store.blob(ref.hash)).bytes);
    }
    const directory = `/worlds/${world.id}`;
    this.module!.FS.mkdirTree(directory);
    for (const capture of world.captures ?? []) {
      const parent = capture.slice(0, capture.lastIndexOf('/')) || '/';
      this.module!.FS.mkdirTree(parent);
    }
    for (const [hash, bytes] of needed) {
      const path = `${directory}/${hash}.bin`;
      this.module!.FS.writeFile(path, new Uint8Array(bytes));
      this.firmwarePaths.push(path);
    }
    const yaml = materializeYaml(world.yaml, world.firmwares, world.id);
    await this.call('load', { yaml });
    const endpoints = await this.call<EndpointInfo[]>('list_endpoints');
    this.endpointKinds = new Map(endpoints.map((endpoint) => [endpoint.name, endpoint.kind]));
    const selectedBenchUarts = new Set((world.bench?.components ?? [])
      .filter((component) => component.kind === 'hardware-uart')
      .map((component) => `${component.cpuId}.main.${component.port}`));
    const selected = endpoints.filter((endpoint) =>
      endpoint.kind === 'net' ||
      (world.watch.uart && (endpoint.kind === 'uart' || endpoint.kind === 'uart-frames') &&
        (!world.bench || selectedBenchUarts.has(endpoint.name))) ||
      (world.watch.radio && endpoint.kind === 'radio'),
    );
    for (const endpoint of selected) await this.call('subscribe', { endpoint: endpoint.name });
    const status = await this.call<SimStatus>('status');
    this.running = status.running;
    this.statusListener?.(status);
    return endpoints;
  }

  async run(): Promise<void> {
    await this.call('run');
    this.running = true;
    this.statusListener?.({ loaded: true, running: true, speed: 0 });
  }

  async pause(): Promise<void> {
    await this.call('pause');
    this.running = false;
    const status = await this.call<SimStatus>('status');
    this.statusListener?.(status);
  }

  async status(): Promise<SimStatus> {
    const status = await this.call<SimStatus>('status');
    this.running = status.running;
    this.statusListener?.(status);
    return status;
  }

  async set(endpoint: string, value: unknown, atNs?: number): Promise<void> {
    await this.call('set', { endpoint, value, ...(atNs === undefined ? {} : { at: `${Math.round(atNs)}ns` }) });
  }

  async drive(net: string, state: string, atNs?: number): Promise<void> {
    await this.call('drive', { net, state, ...(atNs === undefined ? {} : { at: `${Math.round(atNs)}ns` }) });
  }

  readCapture(path: string): Uint8Array {
    if (!this.module) throw new Error('The emulator is not running yet.');
    return this.module.FS.readFile(path);
  }

  pump(): void {
    if (!this.module || !this.session || !this.running) return;
    const raw = this.module.ccall('mcuemu_wasm_session_pump', 'string', ['number', 'number'], [this.session, 12]);
    if (typeof raw !== 'string' || !raw) return;
    try {
      this.consume(JSON.parse(raw) as RpcMessage[]);
    } catch (error) {
      this.faultListener?.(`Error reading the WASM response: ${String(error)}`);
    }
  }

  close(): void {
    if (!this.module || !this.session) return;
    this.module.ccall('mcuemu_wasm_session_destroy', null, ['number'], [this.session]);
    this.session = 0;
    this.running = false;
    this.firmwarePaths = [];
    this.module = undefined;
  }

  private async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.module || !this.session) throw new Error('The emulator is not running yet.');
    const id = this.nextId++;
    const request = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
    const raw = this.module.ccall(
      'mcuemu_wasm_session_request', 'string', ['number', 'string'], [this.session, JSON.stringify(request)],
    );
    if (typeof raw !== 'string') throw new Error(`Empty emulator response for ${method}.`);
    const messages = JSON.parse(raw) as RpcMessage[];
    this.consume(messages);
    const response = messages.find((message) => message.id === id);
    if (!response) throw new Error(`No response for RPC ${method}.`);
    if (response.error) throw new Error(response.error.message);
    return response.result as T;
  }

  private consume(messages: RpcMessage[]): void {
    for (const message of messages) {
      if (message.method === 'event' && message.params) {
        const endpoint = String(message.params.endpoint ?? '');
        const rawKind = this.endpointKinds.get(endpoint);
        if (rawKind === 'uart' || rawKind === 'uart-frames' || rawKind === 'radio' || rawKind === 'net') {
          this.eventListener?.({
            endpoint,
            kind: rawKind === 'uart-frames' ? 'uart' : rawKind,
            timeNs: Number(message.params.time_ns ?? 0),
            value: message.params.value,
            receivedAt: Date.now(),
          });
        }
      } else if (message.method === 'mcu_stopped' && message.params) {
        const state = String(message.params.state ?? 'stopped');
        const mcu = String(message.params.mcu ?? 'MCU');
        const detail = String(message.params.message ?? '');
        if (state === 'fault') this.faultListener?.(`${mcu}: fault${detail ? ` — ${detail}` : ''}`);
      } else if (message.method === 'stopped') {
        this.running = false;
      }
    }
  }

}
