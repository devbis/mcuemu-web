export type ModelId =
  | 'tlsr8258'
  | 'ca51f253l3'
  | 'cc2530f256'
  | 'nrf52840'
  | 'efr32mg21'
  | 'esp32c6'
  | 'esp32h2'
  | 'bl702'
  | 'phy6252';

export interface ModelInfo {
  id: ModelId;
  label: string;
  radio: boolean;
  uarts: string[];
}

export const models: ModelInfo[] = [
  { id: 'tlsr8258', label: 'TLSR8258 · Telink', radio: true, uarts: ['uart0'] },
  { id: 'ca51f253l3', label: 'CA51F253L3 · Cmsemicron', radio: false, uarts: ['uart0', 'uart1'] },
  { id: 'cc2530f256', label: 'CC2530F256 · Texas Instruments', radio: true, uarts: ['uart0', 'uart1'] },
  { id: 'nrf52840', label: 'nRF52840 · Nordic', radio: true, uarts: ['uart0', 'uart1'] },
  { id: 'efr32mg21', label: 'EFR32MG21 · Silicon Labs', radio: true, uarts: [] },
  { id: 'esp32c6', label: 'ESP32-C6 · Espressif', radio: true, uarts: ['uart0'] },
  { id: 'esp32h2', label: 'ESP32-H2 · Espressif', radio: true, uarts: ['uart0'] },
  { id: 'bl702', label: 'BL702 · Bouffalo Lab', radio: true, uarts: ['uart0'] },
  { id: 'phy6252', label: 'PHY6252 · PHY+', radio: true, uarts: ['uart0'] },
];

export interface WatchOptions {
  uart: boolean;
  radio: boolean;
}

export interface FirmwareNeed {
  key: string;
  deviceId: string;
  mcuId: string;
  index: number;
  sourcePath: string;
  label: string;
}

export interface FirmwareRef {
  hash: string;
  name: string;
  size: number;
}

export interface StoredWorld {
  id: string;
  title: string;
  yaml: string;
  firmwares: Record<string, FirmwareRef>;
  watch: WatchOptions;
  netLabels: Record<string, string>;
  bench?: BenchDraft;
  captures?: string[];
  createdAt: number;
  lastRunAt: number;
  preset: 'single' | 'pair' | 'yaml';
}

export interface StagedFirmware {
  hash: string;
  name: string;
  size: number;
  bytes: ArrayBuffer;
}

export interface SimEvent {
  endpoint: string;
  kind: 'uart' | 'radio' | 'net';
  timeNs: number;
  value: unknown;
  receivedAt: number;
}

export interface BenchCpu { id: string; model: ModelId }
export interface HardwareUartComponent { id: string; kind: 'hardware-uart'; cpuId: string; port: string; baudNote: string }
export interface SoftUartComponent { id: string; kind: 'soft-uart'; cpuId: string; txPin: string; rxPin: string; baud: number }
export interface GpioControlComponent {
  id: string; kind: 'gpio-control'; cpuId: string; pin: string; label: string;
  control: 'button' | 'switch'; active: 'high' | 'low'; initial: boolean;
}
export type BenchComponent = HardwareUartComponent | SoftUartComponent | GpioControlComponent;
export type BenchStep =
  | { id: string; afterMs: number; kind: 'hardware-uart-send'; componentId: string; hex: string }
  | { id: string; afterMs: number; kind: 'soft-uart-send'; componentId: string; text: string }
  | { id: string; afterMs: number; kind: 'gpio-set'; componentId: string; pressed: boolean };
export interface BenchDraft {
  cpus: BenchCpu[];
  components: BenchComponent[];
  steps: BenchStep[];
  radioEnabled: boolean;
  capturePcap: boolean;
}

export function gpioPins(model: ModelId): string[] {
  if (model === 'tlsr8258') return ['A', 'B', 'C', 'D', 'E'].flatMap((port) => Array.from({ length: 8 }, (_, pin) => `P${port}${pin}`));
  if (model === 'nrf52840') return [...Array.from({ length: 32 }, (_, pin) => `P0.${String(pin).padStart(2, '0')}`), ...Array.from({ length: 16 }, (_, pin) => `P1.${String(pin).padStart(2, '0')}`)];
  if (model === 'efr32mg21') return ['A', 'B', 'C', 'D'].flatMap((port) => Array.from({ length: 16 }, (_, pin) => `P${port}${pin}`));
  if (model === 'esp32c6') return Array.from({ length: 31 }, (_, pin) => `GPIO${pin}`);
  if (model === 'esp32h2') return Array.from({ length: 28 }, (_, pin) => `GPIO${pin}`);
  if (model === 'phy6252') return Array.from({ length: 23 }, (_, pin) => `GPIO${pin}`);
  if (model === 'cc2530f256') return [...[0, 1].flatMap((port) => Array.from({ length: 8 }, (_, pin) => `P${port}.${pin}`)), ...Array.from({ length: 5 }, (_, pin) => `P2.${pin}`)];
  return [];
}

export function modelInfo(id: string | undefined): ModelInfo | undefined {
  return models.find((model) => model.id === id);
}

export function firmwareKey(deviceId: string, mcuId: string, index: number): string {
  return `${deviceId}.${mcuId}#${index}`;
}
