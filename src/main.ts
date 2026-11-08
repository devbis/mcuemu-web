import './style.css';
import './locales';
import { activeLocale, availableLocales, localizeUi, setLocale, translate } from './i18n';
import { EmulatorClient, type EndpointInfo, type SimStatus } from './emulator';
import { firmwareKey, gpioPins, models, modelInfo, type BenchComponent, type BenchCpu, type BenchDraft, type BenchStep, type FirmwareNeed, type GpioControlComponent, type SimEvent, type StagedFirmware, type StoredWorld, type WatchOptions } from './domain';
import { formatBytes, hashFile, WorldStore } from './storage';
import { parseWorldYaml } from './yaml';
import { RingBuffer } from './ring-buffer';
import { addBlockValue, editBlockValue, parseBlockYaml, removeBlockValue, renderBlockEditor, serializedWorld, type BlockModes } from './blocks';
import { benchActions, benchYaml, netId } from './bench';
import { SoftUartDecoder } from './soft-uart';
import { UartStreamGrouper } from './uart-stream';
import { stringify } from 'yaml';

const root = document.querySelector<HTMLDivElement>('#app')!;
const client = new EmulatorClient();
const eventBuffer = new RingBuffer<SimEvent>(10_000);
const uartGrouper = new UartStreamGrouper();
const commonFilter: Record<SimEvent['kind'], boolean> = { uart: true, radio: true, net: true };

let store: WorldStore | undefined;
let worlds: StoredWorld[] = [];
let storageEstimate: { usage?: number; quota?: number } = {};
let tab: 'preset' | 'yaml' | 'saved' = 'preset';
let yamlWatch: WatchOptions = { uart: true, radio: true };
let presetFiles: Record<string, StagedFirmware> = {};
let yamlFiles: Record<string, StagedFirmware> = {};
let yamlText = '';
let yamlName = 'My configuration';
let parsedYaml: ReturnType<typeof parseWorldYaml> | undefined;
let blockModes: BlockModes = {};
let activeWorld: StoredWorld | undefined;
let activeEndpoints: EndpointInfo[] = [];
let activeStatus: SimStatus = { loaded: false, running: false, speed: 0 };
let pinLevels = new Map<string, unknown>();
let busy = false;
let pumpFrame = 0;
let statusTimer = 0;
let renderTimer = 0;
let notice = '';
let noticeError = false;
let bench: BenchDraft = { cpus: [{ id: 'board', model: 'tlsr8258' }], components: [{ id: 'uart0-log', kind: 'hardware-uart', cpuId: 'board', port: 'uart0', baudNote: '115200' }], steps: [], radioEnabled: true, capturePcap: true };
let nextCpu = 2;
let nextComponent = 2;
let nextStep = 1;
const openYamlBlocks = new Set<string>();
const controlLevels = new Map<string, boolean>();
const softUartDecoders = new Map<string, { component: Extract<BenchComponent, { kind: 'soft-uart' }>; decoder: SoftUartDecoder }>();
const softUartNetDecoders = new Map<string, Array<{ endpoint: string; decoder: SoftUartDecoder }>>();
let activeCapturePaths: string[] = [];

const escapeHtml = (value: unknown): string => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function setNotice(message: string, isError = false): void {
  notice = message;
  noticeError = isError;
  const element = document.querySelector<HTMLElement>('#notice');
  if (element) {
    element.textContent = translate(notice);
    element.className = `notice ${isError ? 'is-error' : 'is-success'}`;
    element.hidden = !message;
  }
}

function selectedFirmwareRows(needs: Array<Pick<FirmwareNeed, 'key' | 'label'>>, staged: Record<string, StagedFirmware>): string {
  return needs.map((need) => {
    const item = staged[need.key];
    return `<label class="file-row">
      <span class="file-row__label">${escapeHtml(need.label)}</span>
      <span class="file-row__control">
        <input type="file" accept=".bin,.hex,.fw,application/octet-stream" data-fw-key="${escapeHtml(need.key)}" aria-label="Firmware file" />
        <span class="file-name ${item ? 'is-ready' : ''}">${item ? `${escapeHtml(item.name)} · ${formatBytes(item.size)}` : 'No file selected'}</span>
      </span>
    </label>`;
  }).join('');
}

function modelOptions(selected: string, radioOnly = false): string {
  return models.filter((model) => !radioOnly || model.radio).map((model) =>
    `<option value="${model.id}" ${model.id === selected ? 'selected' : ''}>${escapeHtml(model.label)}</option>`,
  ).join('');
}

function firmwareCount(count: number, kind: 'image' | 'file' = 'image'): string {
  const value = count.toLocaleString(activeLocale());
  if (activeLocale() !== 'ru') return `${value} ${kind === 'image' ? `firmware image${count === 1 ? '' : 's'}` : `file${count === 1 ? '' : 's'}`}`;
  const lastTwo = count % 100;
  const last = count % 10;
  const form = last === 1 && lastTwo !== 11 ? 0 : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 1 : 2;
  const words = kind === 'image'
    ? ['образ прошивки', 'образа прошивки', 'образов прошивки']
    : ['файл', 'файла', 'файлов'];
  return `${value} ${words[form]}`;
}

function eventCount(count: number): string {
  const value = count.toLocaleString(activeLocale());
  if (activeLocale() !== 'ru') return `${value} event${count === 1 ? '' : 's'} buffered`;
  const lastTwo = count % 100;
  const last = count % 10;
  const word = last === 1 && lastTwo !== 11 ? 'событие' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'события' : 'событий';
  return `${value} ${word} в буфере`;
}

function netCount(count: number): string {
  const value = count.toLocaleString(activeLocale());
  if (activeLocale() !== 'ru') return `${value} ${translate('nets')}`;
  const lastTwo = count % 100;
  const last = count % 10;
  const word = last === 1 && lastTwo !== 11 ? 'сеть' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'сети' : 'сетей';
  return `${value} ${word}`;
}

function watchControls(watch: WatchOptions, prefix: 'preset' | 'yaml', radioAvailable = true): string {
  return `<div class="watch-options" aria-label="What to monitor">
    <label class="check-card"><input type="checkbox" data-watch="${prefix}:uart" ${watch.uart ? 'checked' : ''} /> <span><strong>UART</strong><small>Port text and bytes</small></span></label>
    <label class="check-card ${radioAvailable ? '' : 'is-disabled'}"><input type="checkbox" data-watch="${prefix}:radio" ${watch.radio && radioAvailable ? 'checked' : ''} ${radioAvailable ? '' : 'disabled'} /> <span><strong>Radio traffic</strong><small>${radioAvailable ? 'Zigbee / 802.15.4 frame summaries' : 'Radio is not available on this model'}</small></span></label>
  </div>`;
}

function renderPreset(): string {
  const cpuBlocks = bench.cpus.map((cpu) => renderCpuBlock(cpu)).join('');
  const steps = bench.steps.map((step, index) => renderStepBlock(step, index)).join('');
  const radioCapable = bench.cpus.some((cpu) => modelInfo(cpu.model)?.radio);
  const needs = benchYaml(bench).needs;
  return `<section class="card setup-card bench-card">
    <div class="card-heading"><div><span class="eyebrow">Local test bench</span><h2>Build a test bench from blocks</h2><p class="card-lead">Add a CPU, then connect UART monitors, GPIO controls, and scenarios.</p></div><span class="step-mark">01</span></div>
    <div class="bench-stack">${cpuBlocks}</div>
    <button type="button" class="button button--quiet" id="add-cpu">＋ Add CPU</button>
    <section class="config-block radio-block"><header class="config-block__head"><div><span class="block-icon">◉</span><h3>Radio environment</h3></div><button type="button" class="yaml-icon" data-block-yaml-open="radio" aria-label="Edit radio environment YAML" title="YAML radio">YAML</button></header>
      <label class="check-card"><input id="bench-radio" type="checkbox" ${bench.radioEnabled ? 'checked' : ''} ${radioCapable ? '' : 'disabled'} /><span><strong>Connect supported 802.15.4 radios to air0</strong><small>${radioCapable ? 'Models share the same Zigbee air.' : 'The selected CPUs do not support radio.'}</small></span></label>
      ${bench.radioEnabled && radioCapable ? `<label class="check-card"><input id="bench-pcap" type="checkbox" ${bench.capturePcap ? 'checked' : ''} /><span><strong>Capture Zigbee traffic to PCAP</strong><small>The capture will be available to download after pausing.</small></span></label>` : ''}
      <p class="capability-note">IEEE 802.15.4 / Zigbee is currently supported. Wi-Fi, Bluetooth, and Ethernet capture are not available yet.</p>
      ${openYamlBlocks.has('radio') ? `<textarea class="bench-yaml" id="radio-yaml" spellcheck="false">${escapeHtml(stringify({ radio: bench.radioEnabled ? [{ id: 'air0', model: 'log_distance' }] : [], capture_pcap: bench.capturePcap }, { lineWidth: 0 }))}</textarea><button type="button" class="button button--quiet button--small" id="apply-radio-yaml">Apply YAML</button>` : ''}
    </section>
    <section class="scenario-block"><header><div><span class="eyebrow">Checks</span><h3>Scenario</h3><p>Each step delay is measured from the previous step.</p></div><button type="button" class="yaml-icon" data-block-yaml-open="scenario" aria-label="Edit scenario YAML" title="Scenario YAML">YAML</button></header>
      ${steps || '<p class="empty-inline">No steps added yet.</p>'}
      <div class="scenario-add">${bench.components.filter((item) => item.kind === 'hardware-uart').map((item) => `<button class="button button--quiet button--small" data-add-step="hardware-uart-send" data-component-id="${escapeHtml(item.id)}">＋ Send to ${escapeHtml(item.port)}</button>`).join('')}${bench.components.filter((item) => item.kind === 'soft-uart').map((item) => `<button class="button button--quiet button--small" data-add-step="soft-uart-send" data-component-id="${escapeHtml(item.id)}">＋ Send over soft UART</button>`).join('')}${bench.components.filter((item) => item.kind === 'gpio-control').map((item) => `<button class="button button--quiet button--small" data-add-step="gpio-set" data-component-id="${escapeHtml(item.id)}">＋ Press ${escapeHtml(item.label)}</button>`).join('')}</div>
      ${openYamlBlocks.has('scenario') ? `<textarea class="bench-yaml" id="scenario-yaml" spellcheck="false">${escapeHtml(stringify({ steps: bench.steps }, { lineWidth: 0 }))}</textarea><button type="button" class="button button--quiet button--small" id="apply-scenario-yaml">Apply YAML</button>` : ''}
    </section>
    <div class="form-footer"><p>${firmwareCount(needs.length)} · ${translate('saved locally')}</p><button type="button" class="button button--primary" id="launch-preset" ${busy || !needs.every((need) => presetFiles[need.key]) ? 'disabled' : ''}>${busy ? 'Preparing…' : 'Run test bench'} <span>↗</span></button></div>
  </section>`;
}

function renderYamlButton(id: string): string {
  return `<button type="button" class="yaml-icon" data-component-yaml="${escapeHtml(id)}" aria-label="Edit block YAML" title="Edit block YAML">{ }</button>`;
}

function renderCpuBlock(cpu: BenchCpu): string {
  const key = firmwareKey(cpu.id, 'main', 0);
    const need = { key, label: translate(`${cpu.id} · firmware`) };
  const cardYaml = stringify({ id: cpu.id, model: cpu.model }, { lineWidth: 0 });
  const children = bench.components.filter((component) => component.cpuId === cpu.id).map((component) => renderComponentBlock(component)).join('');
  const choices = `<option value="hardware-uart" ${modelInfo(cpu.model)?.uarts.length ? '' : 'disabled'}>Hardware UART</option><option value="soft-uart" ${gpioPins(cpu.model).length ? '' : 'disabled'}>Soft UART</option><option value="button" ${gpioPins(cpu.model).length ? '' : 'disabled'}>Button / switch</option>`;
  return `<article class="cpu-block"><header class="cpu-block__head"><div><span class="block-icon">▦</span><div><strong>${escapeHtml(translate(`CPU · ${cpu.id}`))}</strong><small>${escapeHtml(modelInfo(cpu.model)?.label ?? cpu.model)}</small></div></div><div>${renderYamlButton(`cpu:${cpu.id}`)}${bench.cpus.length > 1 ? `<button type="button" class="text-button" data-remove-cpu="${escapeHtml(cpu.id)}">Remove</button>` : ''}</div></header>
    ${openYamlBlocks.has(`cpu:${cpu.id}`) ? `<textarea class="bench-yaml" data-cpu-yaml="${escapeHtml(cpu.id)}" spellcheck="false">${escapeHtml(cardYaml)}</textarea><button type="button" class="button button--quiet button--small" data-apply-cpu-yaml="${escapeHtml(cpu.id)}">Apply</button>` : ''}
    <div class="cpu-config"><label>Model<select data-cpu-model="${escapeHtml(cpu.id)}">${modelOptions(cpu.model)}</select></label><div class="field file-field"><label>Firmware</label>${selectedFirmwareRows([need], presetFiles)}</div></div>
    <div class="cpu-children"><div class="cpu-children__head"><strong>Connected devices</strong><span>Choose a port or GPIO</span></div>${children || '<p class="empty-inline">No devices connected.</p>'}<div class="add-component"><select data-component-kind="${escapeHtml(cpu.id)}">${choices}</select><button type="button" class="button button--quiet button--small" data-add-component="${escapeHtml(cpu.id)}">Add device</button></div></div>
  </article>`;
}

function pinOptions(model: BenchCpu['model'], selected: string): string {
  const pins = gpioPins(model);
  return pins.map((pin) => `<option value="${pin}" ${pin === selected ? 'selected' : ''}>${pin}</option>`).join('');
}

function renderComponentBlock(component: BenchComponent): string {
  const cpu = bench.cpus.find((item) => item.id === component.cpuId);
  if (!cpu) return '';
  let title = 'Device';
  let fields = '';
  let yaml: Record<string, unknown> = { ...component };
  if (component.kind === 'hardware-uart') {
    title = translate(`UART monitor · ${component.port}`);
    const ports = modelInfo(cpu.model)?.uarts ?? [];
    fields = `<label>UART endpoint<select data-component-field="${component.id}" data-field="port">${ports.map((port) => `<option value="${port}" ${port === component.port ? 'selected' : ''}>${port}</option>`).join('')}</select></label><label>Baud rate (reference)<input type="text" value="${escapeHtml(component.baudNote)}" placeholder="115200" data-component-field="${component.id}" data-field="baudNote" /></label><p class="hint">UART behavior is controlled by the emulated peripheral; this field does not change the CPU clock.</p>`;
  } else if (component.kind === 'soft-uart') {
    title = translate(`Soft UART · ${component.baud} baud`);
    const pins = pinOptions(cpu.model, '');
    fields = `<label>TX GPIO<select data-component-field="${component.id}" data-field="txPin">${pinOptions(cpu.model, component.txPin)}</select></label><label>RX GPIO<select data-component-field="${component.id}" data-field="rxPin">${pinOptions(cpu.model, component.rxPin)}</select></label><label>Baud<select data-component-field="${component.id}" data-field="baud">${[9600, 19200, 38400, 57600, 115200].map((baud) => `<option value="${baud}" ${component.baud === baud ? 'selected' : ''}>${baud}</option>`).join('')}${[9600, 19200, 38400, 57600, 115200].includes(component.baud) ? '' : `<option value="${component.baud}" selected>${component.baud}</option>`}</select></label><p class="hint">TX is decoded from GPIO transitions; RX is sent one bit at a time.</p>${pins ? '' : '<p class="capability-note">GPIO is not implemented for this model in mcuemu.</p>'}`;
  } else {
    title = translate(`${component.control === 'button' ? 'Button' : 'Switch'} · ${component.label}`);
    fields = `<label>Name<input type="text" value="${escapeHtml(component.label)}" data-component-field="${component.id}" data-field="label" /></label><label>GPIO<select data-component-field="${component.id}" data-field="pin">${pinOptions(cpu.model, component.pin)}</select></label><label>Control<select data-component-field="${component.id}" data-field="control"><option value="button" ${component.control === 'button' ? 'selected' : ''}>Button</option><option value="switch" ${component.control === 'switch' ? 'selected' : ''}>Switch</option></select></label><label>Active level<select data-component-field="${component.id}" data-field="active"><option value="low" ${component.active === 'low' ? 'selected' : ''}>LOW</option><option value="high" ${component.active === 'high' ? 'selected' : ''}>HIGH</option></select></label>`;
    yaml = { ...component, net: netId(component.cpuId, component.pin) };
  }
  const yamlOpen = openYamlBlocks.has(component.id);
  const endpoint = component.kind === 'hardware-uart' ? `${component.cpuId}.main.${component.port}` : '';
  return `<article class="instrument-block"><header><div><span class="block-icon">${component.kind === 'hardware-uart' ? '↔' : component.kind === 'soft-uart' ? '≋' : component.control === 'button' ? '●' : '◧'}</span><strong>${escapeHtml(title)}</strong></div><div>${renderYamlButton(component.id)}<button type="button" class="text-button" data-remove-component="${escapeHtml(component.id)}">Remove</button></div></header><div class="instrument-fields">${fields}</div>
    ${component.kind === 'hardware-uart' ? `<div class="instrument-endpoint">Stream: <code>${escapeHtml(endpoint)}</code></div>` : ''}
    ${yamlOpen ? `<textarea class="bench-yaml" data-instrument-yaml="${escapeHtml(component.id)}" spellcheck="false">${escapeHtml(stringify(yaml, { lineWidth: 0 }))}</textarea><button type="button" class="button button--quiet button--small" data-apply-instrument-yaml="${escapeHtml(component.id)}">Apply YAML</button>` : ''}</article>`;
}

function renderStepBlock(step: BenchStep, index: number): string {
  const component = bench.components.find((item) => item.id === step.componentId);
  const description = translate(step.kind === 'hardware-uart-send' ? `UART → ${component?.kind === 'hardware-uart' ? component.port : 'endpoint'}` : step.kind === 'soft-uart-send' ? 'Soft UART → RX' : `GPIO → ${component?.kind === 'gpio-control' ? component.label : 'control'}`);
  const action = step.kind === 'hardware-uart-send'
    ? `<label>HEX bytes<input type="text" value="${escapeHtml(step.hex)}" data-step-field="${step.id}" data-field="hex" placeholder="fe 00 ..." /></label>`
    : step.kind === 'soft-uart-send'
      ? `<label>Text<input type="text" value="${escapeHtml(step.text)}" data-step-field="${step.id}" data-field="text" /></label>`
      : `<label>State<select data-step-field="${step.id}" data-field="pressed"><option value="true" ${step.pressed ? 'selected' : ''}>Pressed / ON</option><option value="false" ${!step.pressed ? 'selected' : ''}>Released / OFF</option></select></label>`;
  const key = `step:${step.id}`;
  const yamlOpen = openYamlBlocks.has(key);
  return `<article class="scenario-step"><div class="scenario-step__index">${index + 1}</div><div class="scenario-step__body"><header><strong>${escapeHtml(description)}</strong><div>${renderYamlButton(key)}<button type="button" class="text-button" data-remove-step="${step.id}">Remove</button></div></header><label>Delay after the previous step (ms)<input type="number" min="0" step="1" value="${step.afterMs}" data-step-field="${step.id}" data-field="afterMs" /></label>${action}${yamlOpen ? `<textarea class="bench-yaml" data-step-yaml="${step.id}" spellcheck="false">${escapeHtml(stringify(step, { lineWidth: 0 }))}</textarea><button type="button" class="button button--quiet button--small" data-apply-step-yaml="${step.id}">Apply YAML</button>` : ''}</div></article>`;
}

function renderYamlImport(): string {
  let firmwareSection = '';
  if (parsedYaml) {
    firmwareSection = `<div class="field file-field"><div class="field-title"><label>Firmware images</label><span class="hint">${firmwareCount(parsedYaml.needs.length, 'file')}</span></div>${selectedFirmwareRows(parsedYaml.needs, yamlFiles)}</div>`;
  }
  return `<section class="card setup-card">
    <div class="card-heading"><div><span class="eyebrow">Custom system</span><h2>Load YAML</h2><p class="card-lead">Use a single self-contained file. Select firmware for each MCU.</p></div><span class="step-mark">02</span></div>
    <div class="yaml-file-row"><label class="button button--quiet" for="yaml-file">Choose YAML file</label><input id="yaml-file" type="file" accept=".yaml,.yml,text/yaml,text/plain" /><span class="muted">${escapeHtml(yamlName === 'My configuration' ? translate(yamlName) : yamlName)}</span></div>
    <div class="field"><label for="yaml-text">Configuration</label><textarea id="yaml-text" spellcheck="false" placeholder="version: 1&#10;devices:&#10;  - id: board&#10;    mcus:&#10;      - id: main&#10;        model: tlsr8258&#10;        firmware: firmware.bin">${escapeHtml(yamlText)}</textarea><p class="hint">No includes or Lua scripts. ROM, eFuse, RF calibration, and flash.persist are not supported yet.</p></div>
    <div class="button-row"><button type="button" class="button button--quiet" id="validate-yaml">Validate configuration</button>${parsedYaml ? `<span class="validation-ok">${escapeHtml(translate(`✓ MCUs found: ${parsedYaml.needs.length}`))}</span>` : ''}</div>
    ${parsedYaml ? `<div class="field"><div class="field-title"><label>Configuration blocks</label><span class="hint">Each block has a visual editor and a YAML editor</span></div>${renderBlockEditor(parsedYaml.value, blockModes)}</div>` : ''}
    ${firmwareSection}
    <div class="field"><div class="field-title"><label>Monitoring</label><span class="hint">Nets from the YAML will appear in the pins panel</span></div>${watchControls(yamlWatch, 'yaml', true)}</div>
    <div class="form-footer"><p>The YAML and selected firmware images will be saved to history.</p><button type="button" class="button button--primary" id="launch-yaml" ${busy || !parsedYaml ? 'disabled' : ''}>${busy ? 'Preparing…' : 'Run YAML'} <span>↗</span></button></div>
  </section>`;
}

function displayWorldTitle(world: StoredWorld): string {
  const cpus = world.bench?.cpus;
  if (!cpus?.length) return world.title;
  const modelsText = cpus.map((cpu) => modelInfo(cpu.model)?.label.split(' · ')[0] ?? cpu.model).join(' + ');
  return translate(`${cpus.length > 1 ? 'Multi-board bench' : 'Bench'} · ${modelsText}`);
}

function renderSaved(): string {
  const rows = worlds.map((world) => {
    const uniqueHashes = new Set(Object.values(world.firmwares).map((item) => item.hash));
    const bytes = Object.values(world.firmwares).filter((item, index, all) => all.findIndex((candidate) => candidate.hash === item.hash) === index).reduce((sum, item) => sum + item.size, 0);
    const kind = world.preset === 'yaml' ? 'YAML' : world.bench?.cpus.length ? `${world.bench.cpus.length} CPU` : world.preset === 'pair' ? 'Coordinator + router' : 'Single MCU';
    return `<article class="world-row">
      <div class="world-row__info"><span class="world-type">${escapeHtml(translate(kind))}</span><h3>${escapeHtml(displayWorldTitle(world))}</h3><p>${escapeHtml(`${translate('Last run')} ${new Date(world.lastRunAt).toLocaleString(activeLocale())} · ${formatBytes(bytes)} · ${firmwareCount(uniqueHashes.size, 'file')}`)}</p></div>
      <div class="world-row__actions"><button type="button" class="button button--small button--primary" data-run-world="${escapeHtml(world.id)}" ${busy ? 'disabled' : ''}>Run</button><button type="button" class="icon-button" data-delete-world="${escapeHtml(world.id)}" aria-label="Remove world">Remove</button></div>
    </article>`;
  }).join('');
  const quota = storageEstimate.quota ? ` ${translate('of')} ${formatBytes(storageEstimate.quota)}` : '';
  return `<section class="card history-card">
    <div class="card-heading"><div><span class="eyebrow">On this device</span><h2>Saved worlds</h2><p class="card-lead">Configuration history is stored in IndexedDB. Simulation logs are not saved.</p></div><span class="step-mark">03</span></div>
    <div class="storage-meter"><span class="storage-icon">▤</span><span>Used <strong>${formatBytes(storageEstimate.usage)}${quota}</strong></span><button type="button" class="text-button" id="refresh-worlds">Refresh</button></div>
    <div class="world-list">${rows || '<div class="empty-state"><span>◇</span><strong>No history yet</strong><p>Configurations you run will appear here.</p></div>'}</div>
  </section>`;
}

function renderSimulation(): string {
  if (!activeWorld) return '';
  const kinds = ['uart', 'radio', 'net'] as const;
  const labels: Record<(typeof kinds)[number], string> = { uart: 'UART', radio: 'Radio', net: 'Pins' };
  const watchedNets = activeEndpoints.filter((endpoint) => endpoint.kind === 'net');
  const drives = watchedNets.map((endpoint) => {
    const label = activeWorld!.netLabels[endpoint.name] ?? endpoint.name;
    const current = pinLevels.has(endpoint.name) ? (pinLevels.get(endpoint.name) ? 'HIGH' : 'LOW') : translate('floating');
    return `<div class="drive-row"><div class="drive-row__name"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(endpoint.name)} · ${escapeHtml(current)}</small></div><select data-drive-state="${escapeHtml(endpoint.name)}" aria-label="Level of ${escapeHtml(label)}"><option value="low">LOW</option><option value="high">HIGH</option><option value="hiz" selected>Hi-Z</option><option value="pullup">Pull-up</option><option value="pulldown">Pull-down</option></select><button type="button" class="button button--quiet button--small" data-drive-net="${escapeHtml(endpoint.name)}">Drive</button></div>`;
  }).join('');
  const liveControls = (activeWorld.bench?.components ?? []).filter((component): component is GpioControlComponent => component.kind === 'gpio-control').map((component) => {
    const pressed = controlLevels.get(component.id) ?? component.initial;
    if (component.control === 'button') {
      return `<button type="button" class="live-control" data-control-button="${escapeHtml(component.id)}" ${activeStatus.running ? '' : 'disabled'}>${escapeHtml(translate(`${component.label} · ${pressed ? 'pressed' : 'press'}`))}</button>`;
    }
    return `<button type="button" class="live-control ${pressed ? 'is-on' : ''}" data-toggle-control="${escapeHtml(component.id)}" ${activeStatus.running ? '' : 'disabled'}>${escapeHtml(translate(`${component.label} · ${pressed ? 'ON' : 'OFF'}`))}</button>`;
  }).join('');
  const captures = activeCapturePaths.length ? `<div class="capture-actions">${activeCapturePaths.map((path, index) => `<button type="button" class="button button--quiet button--small" data-download-capture="${index}" ${activeStatus.running ? 'disabled' : ''}>Download PCAP · ${escapeHtml(path.split('/').pop())}</button>`).join('')}<span>${activeStatus.running ? 'Pause the simulation to download the capture.' : 'The capture is updated as frames arrive.'}</span></div>` : '';
  return `<section class="simulation card" id="simulation">
    <div class="simulation-head"><div><span class="eyebrow">Current run</span><h2>${escapeHtml(displayWorldTitle(activeWorld))}</h2><p id="sim-status" class="sim-status">Preparing…</p></div><div class="simulation-controls"><button type="button" class="button button--quiet" id="pause-sim" ${activeStatus.running ? '' : 'disabled'}>Pause</button><button type="button" class="button button--primary" id="run-sim" ${activeStatus.running ? 'disabled' : ''}>Resume <span>↗</span></button></div></div>
    <div class="sim-summary"><span>${activeEndpoints.filter((item) => item.kind === 'uart' || item.kind === 'uart-frames').length} UART</span><span>${activeEndpoints.filter((item) => item.kind === 'radio').length} ${translate('radio')}</span><span>${netCount(watchedNets.length)}</span><span id="event-total">${escapeHtml(eventCount(0))}</span></div>
    ${liveControls ? `<section class="live-controls"><strong>Buttons and switches</strong><div>${liveControls}</div></section>` : ''}${captures}
    <div class="event-grid">
      <section class="event-panel event-panel--wide"><div class="panel-heading"><div><span class="panel-index">A</span><h3>All events</h3></div><div class="feed-filters">${kinds.map((kind) => `<label><input type="checkbox" data-feed-filter="${kind}" ${commonFilter[kind] ? 'checked' : ''} /><span class="dot dot--${kind}"></span>${labels[kind]}</label>`).join('')}</div></div><div class="event-list" id="event-feed"></div></section>
      <section class="event-panel"><div class="panel-heading"><div><span class="panel-index">B</span><h3>UART</h3></div><span class="panel-count" id="count-uart">0</span></div><div class="event-list" id="uart-feed"></div></section>
      <section class="event-panel"><div class="panel-heading"><div><span class="panel-index">C</span><h3>Radio traffic</h3></div><span class="panel-count" id="count-radio">0</span></div><div class="event-list" id="radio-feed"></div></section>
      <section class="event-panel event-panel--wide"><div class="panel-heading"><div><span class="panel-index">D</span><h3>Pins and nets</h3></div><span class="panel-count" id="count-net">${watchedNets.length}</span></div>${drives ? `<div class="drive-list">${drives}</div>` : '<p class="empty-inline">This YAML defines no nets. The built-in generator adds them automatically.</p>'}<div class="event-list event-list--compact" id="net-feed"></div></section>
    </div>
    <p class="buffer-note">The current simulation keeps up to 10,000 events. The feed is cleared when you start a new run.</p>
  </section>`;
}

function render(): void {
  document.documentElement.lang = activeLocale();
  document.title = translate('mcuemu — microcontroller lab in your browser');
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', translate('Run mcuemu microcontroller emulation locally in your browser.'));
  const activeClass = (name: string) => tab === name ? 'tab is-active' : 'tab';
  const currentContent = tab === 'preset' ? renderPreset() : tab === 'yaml' ? renderYamlImport() : renderSaved();
  const locales = availableLocales();
  root.innerHTML = `<div class="page-shell">
    <header class="topbar"><a class="brand" href="#" aria-label="mcuemu"><span class="brand-mark">μ</span><span>mcuemu<span class="brand-light">/web</span></span></a><span class="local-badge"><span></span> Runs entirely in your browser</span>${locales.length > 1 ? `<label class="language-picker"><span>Language</span><select id="language-select" aria-label="Language">${locales.map((locale) => `<option value="${escapeHtml(locale.code)}" ${locale.code === activeLocale() ? 'selected' : ''}>${escapeHtml(locale.name)}</option>`).join('')}</select></label>` : ''}<a class="source-link" href="https://github.com/devbis/mcuemu" target="_blank" rel="noreferrer">Source project ↗</a></header>
    <main>
      <section class="hero"><div class="hero-copy"><span class="eyebrow">WEBASSEMBLY · BROWSER SANDBOX</span><h1>Microcontrollers.<br /><em>In motion.</em></h1><p>Run firmware and monitor UART, radio traffic, and pins. YAML and firmware files stay on your device.</p></div><div class="hero-visual" aria-hidden="true"><div class="orbit orbit--outer"></div><div class="orbit orbit--inner"></div><div class="chip-core"><span>MCU</span><b>↗</b></div><i class="signal signal--one"></i><i class="signal signal--two"></i><i class="signal signal--three"></i><span class="visual-label visual-label--top">LOCAL SIM</span><span class="visual-label visual-label--bottom">32–160 MHz</span></div></section>
      <nav class="tabs" aria-label="Workspace"><button class="${activeClass('preset')}" data-tab="preset"><span class="tab-number">01</span>Bench</button><button class="${activeClass('yaml')}" data-tab="yaml"><span class="tab-number">02</span>Custom YAML</button><button class="${activeClass('saved')}" data-tab="saved"><span class="tab-number">03</span>History <span class="history-count">${worlds.length}</span></button></nav>
      <div id="notice" class="notice ${noticeError ? 'is-error' : 'is-success'}" ${notice ? '' : 'hidden'}>${escapeHtml(translate(notice))}</div>
      <div class="content-grid"><div class="main-column">${currentContent}${renderSimulation()}</div><aside class="side-column"><section class="side-card"><div class="side-icon">⌘</div><h3>Emulation without a server</h3><p>The WASM module runs the chip model in this tab. Firmware files never leave your device.</p><div class="side-divider"></div><div class="side-stat"><span>Storage</span><strong>IndexedDB</strong></div><div class="side-stat"><span>Event limit</span><strong>10 000</strong></div></section><section class="side-card side-card--accent"><span class="eyebrow">First time here?</span><h3>Start with TLSR8258</h3><p>Choose a firmware image and UART monitor. Add a second CPU if needed.</p><button type="button" class="text-button" data-tab="preset">Open bench <span>↗</span></button></section><div class="privacy-note"><span>▣</span><p>Storage belongs to this browser. Clearing site data will delete saved worlds.</p></div></aside></div>
      <footer class="footer"><span>mcuemu-web · Local lab</span><span>YAML and logs are never sent to a server</span></footer>
    </main>
  </div>`;
  localizeUi(root);
  bindUi();
  renderEventLists();
  updateStatusDom();
}

function bindUi(): void {
  root.querySelector<HTMLSelectElement>('#language-select')?.addEventListener('change', (event) => {
    setLocale((event.currentTarget as HTMLSelectElement).value);
    render();
  });
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    const nextTab = button.dataset.tab;
    if (nextTab === 'preset' || nextTab === 'yaml' || nextTab === 'saved') {
      tab = nextTab;
      render();
    }
  }));
  root.querySelectorAll<HTMLInputElement>('[data-watch]').forEach((input) => input.addEventListener('change', () => {
    const [, category] = String(input.dataset.watch).split(':');
    if (category === 'uart') yamlWatch.uart = input.checked;
    if (category === 'radio') yamlWatch.radio = input.checked;
    render();
  }));
  root.querySelectorAll<HTMLInputElement>('[data-fw-key]').forEach((input) => input.addEventListener('change', () => {
    const file = input.files?.[0];
    const key = String(input.dataset.fwKey);
    const isYaml = tab === 'yaml';
    if (!file) return;
    void hashFile(file).then((staged) => {
      (isYaml ? yamlFiles : presetFiles)[key] = staged;
      setNotice(`Firmware image “${file.name}” loaded. It will be saved in IndexedDB after the run.`, false);
      render();
    }).catch((error: unknown) => setNotice(errorText(error), true));
  }));

  root.querySelector<HTMLButtonElement>('#add-cpu')?.addEventListener('click', () => {
    let id = `cpu${nextCpu++}`;
    while (bench.cpus.some((cpu) => cpu.id === id)) id = `cpu${nextCpu++}`;
    bench.cpus.push({ id, model: 'tlsr8258' });
    render();
  });
  root.querySelectorAll<HTMLSelectElement>('[data-cpu-model]').forEach((select) => select.addEventListener('change', () => {
    const cpu = bench.cpus.find((item) => item.id === select.dataset.cpuModel);
    if (!cpu) return;
    const previous = structuredClone(bench);
    cpu.model = select.value as BenchCpu['model'];
    const pins = new Set(gpioPins(cpu.model));
    const ports = modelInfo(cpu.model)?.uarts ?? [];
    const removed = new Set(bench.components.filter((component) => component.cpuId === cpu.id &&
      (component.kind === 'soft-uart' ? !pins.has(component.txPin) || !pins.has(component.rxPin) || !pins.size
        : component.kind === 'gpio-control' ? !pins.has(component.pin) || !pins.size
          : !ports.includes(component.port))).map((component) => component.id));
    if (removed.size) {
      bench.components = bench.components.filter((component) => !removed.has(component.id));
      bench.steps = bench.steps.filter((step) => !removed.has(step.componentId));
    }
    if (!bench.cpus.some((item) => modelInfo(item.model)?.radio)) bench.radioEnabled = false;
    delete presetFiles[firmwareKey(cpu.id, 'main', 0)];
    try { validateBenchDraft(bench); }
    catch (error) { bench = previous; setNotice(errorText(error), true); }
    render();
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-remove-cpu]').forEach((button) => button.addEventListener('click', () => {
    const id = String(button.dataset.removeCpu);
    bench.cpus = bench.cpus.filter((cpu) => cpu.id !== id);
    const removed = new Set(bench.components.filter((component) => component.cpuId === id).map((component) => component.id));
    bench.components = bench.components.filter((component) => component.cpuId !== id);
    bench.steps = bench.steps.filter((step) => !removed.has(step.componentId));
    delete presetFiles[firmwareKey(id, 'main', 0)];
    if (!bench.cpus.some((cpu) => modelInfo(cpu.model)?.radio)) bench.radioEnabled = false;
    render();
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-add-component]').forEach((button) => button.addEventListener('click', () => {
    const cpuId = String(button.dataset.addComponent);
    const cpu = bench.cpus.find((item) => item.id === cpuId);
    const kind = root.querySelector<HTMLSelectElement>(`[data-component-kind="${CSS.escape(cpuId)}"]`)?.value;
    if (!cpu || !kind) return;
    let id = `component${nextComponent++}`;
    while (bench.components.some((item) => item.id === id)) id = `component${nextComponent++}`;
    if (kind === 'hardware-uart') {
      const port = modelInfo(cpu.model)?.uarts.find((candidate) => !bench.components.some((item) => item.cpuId === cpuId && item.kind === 'hardware-uart' && item.port === candidate));
      if (!port) return setNotice('All hardware UART endpoints on this model are already connected.', true);
      bench.components.push({ id, kind: 'hardware-uart', cpuId, port, baudNote: '115200' });
    } else if (kind === 'soft-uart') {
      const used = new Set(bench.components.filter((item) => item.cpuId === cpuId).flatMap((item) => item.kind === 'soft-uart' ? [item.txPin, item.rxPin] : item.kind === 'gpio-control' ? [item.pin] : []));
      const pins = gpioPins(cpu.model).filter((pin) => !used.has(pin));
      if (pins.length < 2) return setNotice('Two unused GPIO pins are required for another soft UART.', true);
      bench.components.push({ id, kind: 'soft-uart', cpuId, txPin: pins[0], rxPin: pins[1], baud: 9600 });
    } else {
      const used = new Set(bench.components.filter((item) => item.cpuId === cpuId).flatMap((item) => item.kind === 'soft-uart' ? [item.txPin, item.rxPin] : item.kind === 'gpio-control' ? [item.pin] : []));
      const pin = gpioPins(cpu.model).find((candidate) => !used.has(candidate));
      if (!pin) return setNotice('GPIO is not implemented for this model in mcuemu.', true);
      bench.components.push({ id, kind: 'gpio-control', cpuId, pin, label: translate(`Button ${bench.components.filter((item) => item.kind === 'gpio-control').length + 1}`), control: 'button', active: 'low', initial: false });
    }
    render();
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-remove-component]').forEach((button) => button.addEventListener('click', () => {
    const id = String(button.dataset.removeComponent);
    bench.components = bench.components.filter((component) => component.id !== id);
    bench.steps = bench.steps.filter((step) => step.componentId !== id);
    openYamlBlocks.delete(id);
    render();
  }));
  const changeComponent = (control: HTMLInputElement | HTMLSelectElement) => {
    const id = String(control.dataset.componentField);
    const component = bench.components.find((item) => item.id === id);
    if (!component) return;
    const field = String(control.dataset.field);
    const previous = structuredClone(bench);
    (component as unknown as Record<string, unknown>)[field] = field === 'baud' ? Number(control.value) : control.value;
    try { validateBenchDraft(bench); }
    catch (error) { bench = previous; setNotice(errorText(error), true); }
    render();
  };
  root.querySelectorAll<HTMLInputElement>('[data-component-field]').forEach((control) => control.addEventListener('change', () => changeComponent(control)));
  root.querySelectorAll<HTMLSelectElement>('[data-component-field]').forEach((control) => control.addEventListener('change', () => changeComponent(control)));
  root.querySelectorAll<HTMLButtonElement>('[data-add-step]').forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.addStep;
    const componentId = String(button.dataset.componentId);
    let id = `step${nextStep++}`;
    while (bench.steps.some((item) => item.id === id)) id = `step${nextStep++}`;
    if (kind === 'hardware-uart-send') bench.steps.push({ id, kind, componentId, afterMs: 1000, hex: '' });
    else if (kind === 'soft-uart-send') bench.steps.push({ id, kind, componentId, afterMs: 1000, text: 'test\n' });
    else if (kind === 'gpio-set') bench.steps.push({ id, kind, componentId, afterMs: 1000, pressed: true });
    render();
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-remove-step]').forEach((button) => button.addEventListener('click', () => {
    const id = String(button.dataset.removeStep);
    bench.steps = bench.steps.filter((step) => step.id !== id);
    openYamlBlocks.delete(`step:${id}`);
    render();
  }));
  const changeStep = (control: HTMLInputElement | HTMLSelectElement) => {
    const step = bench.steps.find((item) => item.id === control.dataset.stepField);
    if (!step) return;
    const field = String(control.dataset.field);
    const previous = structuredClone(bench);
    (step as unknown as Record<string, unknown>)[field] = field === 'afterMs' ? Number(control.value) : field === 'pressed' ? control.value === 'true' : control.value;
    try { validateScenarioStructure(bench); }
    catch (error) { bench = previous; setNotice(errorText(error), true); }
    render();
  };
  root.querySelectorAll<HTMLInputElement>('[data-step-field]').forEach((control) => control.addEventListener('change', () => changeStep(control)));
  root.querySelectorAll<HTMLSelectElement>('[data-step-field]').forEach((control) => control.addEventListener('change', () => changeStep(control)));
  root.querySelectorAll<HTMLButtonElement>('[data-apply-step-yaml]').forEach((button) => button.addEventListener('click', () => {
    const id = String(button.dataset.applyStepYaml);
    const textarea = root.querySelector<HTMLTextAreaElement>(`[data-step-yaml="${CSS.escape(id)}"]`);
    try {
      const parsed = parseBenchStep(parseBlockYaml(textarea?.value ?? ''));
      if (parsed.id !== id) throw new Error('The step ID must stay the same.');
      const previous = structuredClone(bench.steps);
      bench.steps = bench.steps.map((step) => step.id === id ? parsed : step);
      try { validateScenarioStructure(bench); } catch (error) { bench.steps = previous; throw error; }
      render();
      setNotice(`Step “${id}” updated from YAML.`, false);
    } catch (error) { setNotice(`Step “${id}”: ${errorText(error)}`, true); }
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-component-yaml]').forEach((button) => button.addEventListener('click', () => {
    const key = String(button.dataset.componentYaml);
    if (openYamlBlocks.has(key)) openYamlBlocks.delete(key); else openYamlBlocks.add(key);
    render();
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-block-yaml-open]').forEach((button) => button.addEventListener('click', () => {
    const key = String(button.dataset.blockYamlOpen);
    if (openYamlBlocks.has(key)) openYamlBlocks.delete(key); else openYamlBlocks.add(key);
    render();
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-apply-cpu-yaml]').forEach((button) => button.addEventListener('click', () => {
    const oldId = String(button.dataset.applyCpuYaml);
    const textarea = root.querySelector<HTMLTextAreaElement>(`[data-cpu-yaml="${CSS.escape(oldId)}"]`);
    try {
      const value = asRecord(parseBlockYaml(textarea?.value ?? ''), 'CPU block');
      const cpu = bench.cpus.find((item) => item.id === oldId);
      const previous = structuredClone(bench);
      const id = requiredText(value.id, 'CPU.id');
      const model = requiredText(value.model, 'CPU.model') as BenchCpu['model'];
      if (!cpu || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) throw new Error('CPU.id must start with a letter and contain only letters, numbers, _ and -.');
      if (!modelInfo(model)) throw new Error(`Unknown MCU model: ${model}.`);
      if (id !== oldId && bench.cpus.some((item) => item.id === id)) throw new Error(`CPU “${id}” already exists.`);
      const oldKey = firmwareKey(oldId, 'main', 0);
      const staged = presetFiles[oldKey];
      const modelChanged = cpu.model !== model;
      cpu.id = id;
      cpu.model = model;
      bench.components.filter((item) => item.cpuId === oldId).forEach((item) => { item.cpuId = id; });
      try { validateBenchDraft(bench); } catch (error) { bench = previous; throw error; }
      if (modelChanged) delete presetFiles[oldKey];
      else if (id !== oldId && staged) { presetFiles[firmwareKey(id, 'main', 0)] = staged; delete presetFiles[oldKey]; }
      openYamlBlocks.delete(`cpu:${oldId}`);
      setNotice(`CPU block “${id}” updated from YAML.`, false);
      render();
    } catch (error) { setNotice(`CPU block: ${errorText(error)}`, true); }
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-apply-instrument-yaml]').forEach((button) => button.addEventListener('click', () => {
    const id = String(button.dataset.applyInstrumentYaml);
    const textarea = root.querySelector<HTMLTextAreaElement>(`[data-instrument-yaml="${CSS.escape(id)}"]`);
    try {
      const parsed = parseBenchComponent(parseBlockYaml(textarea?.value ?? ''));
      const current = bench.components.find((item) => item.id === id);
      if (!current || parsed.kind !== current.kind || parsed.id !== id) throw new Error('You can edit the parameters in this YAML, but the block ID and type must stay the same.');
      const previous = structuredClone(bench.components);
      bench.components = bench.components.map((item) => item.id === id ? parsed : item);
      try { validateBenchDraft(bench); } catch (error) { bench.components = previous; throw error; }
      setNotice(`Block “${id}” updated from YAML.`, false);
      render();
    } catch (error) { setNotice(`Block “${id}”: ${errorText(error)}`, true); }
  }));
  root.querySelector<HTMLButtonElement>('#apply-radio-yaml')?.addEventListener('click', () => {
    try {
      const value = asRecord(parseBlockYaml(root.querySelector<HTMLTextAreaElement>('#radio-yaml')?.value ?? ''), 'Radio');
      if (value.radio !== undefined && !Array.isArray(value.radio)) throw new Error('radio must be a list.');
      if (value.capture_pcap !== undefined && typeof value.capture_pcap !== 'boolean') throw new Error('capture_pcap must be true or false.');
      const enabled = Array.isArray(value.radio) && value.radio.length > 0;
      if (enabled && !bench.cpus.some((cpu) => modelInfo(cpu.model)?.radio)) throw new Error('None of the selected CPUs support radio.');
      bench.radioEnabled = enabled;
      if (value.capture_pcap !== undefined) bench.capturePcap = value.capture_pcap as boolean;
      render();
      setNotice('Radio block updated from YAML.', false);
    } catch (error) { setNotice(`Radio block: ${errorText(error)}`, true); }
  });
  root.querySelector<HTMLButtonElement>('#apply-scenario-yaml')?.addEventListener('click', () => {
    try {
      const value = asRecord(parseBlockYaml(root.querySelector<HTMLTextAreaElement>('#scenario-yaml')?.value ?? ''), 'Scenario');
      if (!Array.isArray(value.steps)) throw new Error('steps must be a list.');
      const steps = value.steps.map(parseBenchStep);
      const previous = bench.steps;
      bench.steps = steps;
      try { validateScenarioStructure(bench); } catch (error) { bench.steps = previous; throw error; }
      render();
      setNotice('Scenario updated from YAML.', false);
    } catch (error) { setNotice(`Scenario: ${errorText(error)}`, true); }
  });
  root.querySelector<HTMLInputElement>('#bench-radio')?.addEventListener('change', (event) => {
    bench.radioEnabled = (event.currentTarget as HTMLInputElement).checked;
    render();
  });
  root.querySelector<HTMLInputElement>('#bench-pcap')?.addEventListener('change', (event) => {
    bench.capturePcap = (event.currentTarget as HTMLInputElement).checked;
  });
  root.querySelector<HTMLButtonElement>('#launch-preset')?.addEventListener('click', () => void launchPreset());

  root.querySelector<HTMLInputElement>('#yaml-file')?.addEventListener('change', async (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      yamlText = await file.text();
      yamlName = file.name;
      yamlFiles = {};
      blockModes = {};
      parsedYaml = parseWorldYaml(yamlText);
      blockModes = {};
      setNotice(`YAML loaded: found ${parsedYaml.needs.length} MCU(s).`, false);
      render();
    } catch (error) {
      parsedYaml = undefined;
      setNotice(errorText(error), true);
      render();
    }
  });
  root.querySelector<HTMLTextAreaElement>('#yaml-text')?.addEventListener('input', (event) => {
    const text = (event.currentTarget as HTMLTextAreaElement).value;
    if (text === yamlText) return;
    yamlText = text;
    parsedYaml = undefined;
    yamlFiles = {};
    yamlName = 'My configuration';
  });
  root.querySelector<HTMLButtonElement>('#validate-yaml')?.addEventListener('click', () => {
    try {
      yamlText = root.querySelector<HTMLTextAreaElement>('#yaml-text')?.value ?? yamlText;
      parsedYaml = parseWorldYaml(yamlText);
      yamlFiles = {};
      setNotice(`Configuration is valid. Found ${parsedYaml.needs.length} MCU(s).`, false);
    } catch (error) {
      parsedYaml = undefined;
      setNotice(errorText(error), true);
    }
    render();
  });
  root.querySelector<HTMLButtonElement>('#launch-yaml')?.addEventListener('click', () => void launchYaml());
  root.querySelectorAll<HTMLButtonElement>('[data-block-mode]').forEach((button) => button.addEventListener('click', () => {
    const key = String(button.dataset.blockMode);
    if (button.dataset.mode === 'visual') {
      const textarea = root.querySelector<HTMLTextAreaElement>(`[data-block-yaml="${CSS.escape(key)}"]`);
      try {
        const rootValue = parseWorldYaml(yamlText).value;
        rootValue[key] = parseBlockYaml(textarea?.value ?? '');
        yamlText = serializedWorld(rootValue);
        parsedYaml = parseWorldYaml(yamlText);
        blockModes[key] = 'visual';
      } catch (error) { setNotice(`Block “${key}”: ${errorText(error)}`, true); return; }
    } else blockModes[key] = 'yaml';
    render();
  }));
  root.querySelector<HTMLButtonElement>('[data-add-uart-action]')?.addEventListener('click', () => {
    try {
      const rootValue = parseWorldYaml(yamlText).value;
      const scenario = rootValue.scenario && typeof rootValue.scenario === 'object' && !Array.isArray(rootValue.scenario)
        ? rootValue.scenario as Record<string, unknown>
        : { events: [] as unknown[] };
      const events = Array.isArray(scenario.events) ? scenario.events : [];
      const firstDevice = (Array.isArray(rootValue.devices) ? rootValue.devices as Array<Record<string, unknown>> : [])[0];
      const firstMcu = firstDevice && Array.isArray(firstDevice.mcus) ? (firstDevice.mcus as Array<Record<string, unknown>>)[0] : undefined;
      const endpoint = `${String(firstDevice?.id ?? 'device')}.${String(firstMcu?.id ?? 'main')}.uart0`;
      scenario.events = [...events, { at: '1s', endpoint, set: '' }];
      rootValue.scenario = scenario;
      yamlText = serializedWorld(rootValue);
      parsedYaml = parseWorldYaml(yamlText);
      render();
    } catch (error) { setNotice(errorText(error), true); }
  });
  root.querySelector<HTMLButtonElement>('[data-add-block]')?.addEventListener('click', () => {
    const key = root.querySelector<HTMLSelectElement>('#add-block-select')?.value;
    if (!key) return;
    try {
      const rootValue = parseWorldYaml(yamlText).value;
      const defaults: Record<string, unknown> = {
        world: { seed: 1 }, nets: [], links: [], attach: [], scenario: { events: [] },
      };
      if (!(key in defaults)) return;
      rootValue[key] = defaults[key];
      yamlText = serializedWorld(rootValue);
      parsedYaml = parseWorldYaml(yamlText);
      render();
    } catch (error) { setNotice(errorText(error), true); }
  });
  root.querySelectorAll<HTMLButtonElement>('[data-block-apply]').forEach((button) => button.addEventListener('click', () => {
    const key = String(button.dataset.blockApply);
    const textarea = root.querySelector<HTMLTextAreaElement>(`[data-block-yaml="${CSS.escape(key)}"]`);
    try {
      const rootValue = parseWorldYaml(yamlText).value;
      rootValue[key] = parseBlockYaml(textarea?.value ?? '');
      const nextText = serializedWorld(rootValue);
      parsedYaml = parseWorldYaml(nextText);
      yamlText = nextText;
      setNotice(`Block “${key}” applied.`, false);
      render();
    } catch (error) { setNotice(`Block “${key}”: ${errorText(error)}`, true); }
  }));
  const editBlock = (control: HTMLInputElement | HTMLSelectElement) => {
    try {
      const valueKind = control.dataset.blockKind;
      const path = JSON.parse(String(control.dataset.blockPath)) as Array<string | number>;
      const value = valueKind === 'boolean' ? control.value === 'true' : valueKind === 'number' ? Number(control.value) : control.value;
      const rootValue = parseWorldYaml(yamlText).value;
      editBlockValue(rootValue, path, value);
      const nextText = serializedWorld(rootValue);
      parsedYaml = parseWorldYaml(nextText);
      yamlText = nextText;
      render();
    } catch (error) { setNotice(errorText(error), true); }
  };
  root.querySelectorAll<HTMLInputElement>('[data-block-value]').forEach((input) => input.addEventListener('change', () => editBlock(input)));
  root.querySelectorAll<HTMLSelectElement>('[data-block-value]').forEach((input) => input.addEventListener('change', () => editBlock(input)));
  root.querySelectorAll<HTMLButtonElement>('[data-block-remove]').forEach((button) => button.addEventListener('click', () => {
    try {
      const rootValue = parseWorldYaml(yamlText).value;
      removeBlockValue(rootValue, JSON.parse(String(button.dataset.blockPath)) as Array<string | number>);
      yamlText = serializedWorld(rootValue);
      parsedYaml = parseWorldYaml(yamlText);
      render();
    } catch (error) { setNotice(errorText(error), true); }
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-block-add]').forEach((button) => button.addEventListener('click', () => {
    try {
      const rootValue = parseWorldYaml(yamlText).value;
      addBlockValue(rootValue, JSON.parse(String(button.dataset.blockPath)) as Array<string | number>, button.dataset.blockKind as 'key' | 'item');
      yamlText = serializedWorld(rootValue);
      parsedYaml = parseWorldYaml(yamlText);
      render();
    } catch (error) { setNotice(errorText(error), true); }
  }));
  root.querySelector<HTMLButtonElement>('#refresh-worlds')?.addEventListener('click', () => void refreshWorlds());
  root.querySelectorAll<HTMLButtonElement>('[data-run-world]').forEach((button) => button.addEventListener('click', () => {
    const world = worlds.find((item) => item.id === button.dataset.runWorld);
    if (world) void launchSaved(world);
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-delete-world]').forEach((button) => button.addEventListener('click', () => {
    const world = worlds.find((item) => item.id === button.dataset.deleteWorld);
    if (world && confirm(translate(`Delete “${displayWorldTitle(world)}” and firmware files no longer in use?`))) void removeWorld(world);
  }));

  root.querySelectorAll<HTMLInputElement>('[data-feed-filter]').forEach((input) => input.addEventListener('change', () => {
    const kind = input.dataset.feedFilter as SimEvent['kind'];
    commonFilter[kind] = input.checked;
    renderEventLists();
  }));
  root.querySelector<HTMLButtonElement>('#pause-sim')?.addEventListener('click', () => void pauseSimulation());
  root.querySelector<HTMLButtonElement>('#run-sim')?.addEventListener('click', () => void resumeSimulation());
  root.querySelectorAll<HTMLButtonElement>('[data-toggle-control]').forEach((button) => button.addEventListener('click', () => {
    const id = String(button.dataset.toggleControl);
    const component = activeWorld?.bench?.components.find((item): item is GpioControlComponent => item.id === id && item.kind === 'gpio-control');
    if (component) void setControl(component, !(controlLevels.get(id) ?? component.initial));
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-control-button]').forEach((button) => button.addEventListener('click', () => {
    const id = String(button.dataset.controlButton);
    const component = activeWorld?.bench?.components.find((item): item is GpioControlComponent => item.id === id && item.kind === 'gpio-control');
    if (!component) return;
    void setControl(component, true).then(() => window.setTimeout(() => {
      if (activeWorld?.bench?.components.some((item) => item.id === id)) void setControl(component, false);
    }, 140));
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-download-capture]').forEach((button) => button.addEventListener('click', () => {
    const path = activeCapturePaths[Number(button.dataset.downloadCapture)];
    if (!path) return;
    try {
      const capture = client.readCapture(path);
      const url = URL.createObjectURL(new Blob([capture.slice().buffer as ArrayBuffer], { type: 'application/vnd.tcpdump.pcap' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = path.split('/').pop() ?? 'capture.pcap';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) { setNotice(`PCAP is not available yet: ${errorText(error)}`, true); }
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-drive-net]').forEach((button) => button.addEventListener('click', () => {
    const net = String(button.dataset.driveNet);
    const state = root.querySelector<HTMLSelectElement>(`[data-drive-state="${CSS.escape(net)}"]`)?.value;
    if (state) void client.drive(net, state).then(() => setNotice(`${activeWorld?.netLabels[net] ?? net}: ${state}`, false)).catch((error: unknown) => setNotice(errorText(error), true));
  }));
}

function requiredFilesPresent(needs: FirmwareNeed[], files: Record<string, StagedFirmware>): boolean {
  return needs.every((need) => Boolean(files[need.key]));
}

function capturePathsFromConfig(config: Record<string, unknown>): string[] {
  if (!Array.isArray(config.attach)) return [];
  const paths = new Set<string>();
  for (const attachment of config.attach) {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) continue;
    const sink = (attachment as Record<string, unknown>).sink;
    if (typeof sink !== 'string' || !sink.startsWith('pcap:')) continue;
    const path = sink.slice('pcap:'.length).split(',')[0].trim();
    if (!path || path.split('/').includes('..')) continue;
    paths.add(path.startsWith('/') ? path : `/${path}`);
  }
  return [...paths];
}

async function launchPreset(): Promise<void> {
  if (!store || busy) return;
  try {
    validateBenchDraft(bench);
    const result = benchYaml(bench);
    if (!requiredFilesPresent(result.needs, presetFiles)) return setNotice('Select firmware for every CPU.', true);
    const staged = Object.fromEntries(result.needs.map((need) => [need.key, presetFiles[need.key]]));
    const modelsText = bench.cpus.map((cpu) => modelInfo(cpu.model)?.label.split(' · ')[0] ?? cpu.model).join(' + ');
    const watch: WatchOptions = {
      uart: bench.components.some((component) => component.kind === 'hardware-uart' || component.kind === 'soft-uart'),
      radio: bench.radioEnabled,
    };
    await saveAndLaunch({
      title: translate(`${bench.cpus.length > 1 ? 'Multi-board bench' : 'Bench'} · ${modelsText}`),
      yaml: result.yaml,
      staged,
      watch,
      netLabels: result.netLabels,
      preset: bench.cpus.length > 1 ? 'pair' : 'single',
      bench: structuredClone(bench),
      captures: result.capturePaths,
    });
  } catch (error) { setNotice(errorText(error), true); }
}

async function launchYaml(): Promise<void> {
  if (!store || busy) return;
  try {
    const text = root.querySelector<HTMLTextAreaElement>('#yaml-text')?.value ?? yamlText;
    if (!parsedYaml || yamlText !== text) {
      yamlText = text;
      parsedYaml = parseWorldYaml(text);
      yamlFiles = {};
      render();
      return setNotice('Configuration validated. Select firmware images and run it again.', false);
    }
    if (!requiredFilesPresent(parsedYaml.needs, yamlFiles)) return setNotice('Select firmware for each MCU and each flash fragment.', true);
    const title = yamlName === 'My configuration' ? translate(yamlName) : yamlName.replace(/\.(ya?ml)$/i, '') || translate('My configuration');
    await saveAndLaunch({
      title,
      yaml: yamlText,
      staged: Object.fromEntries(parsedYaml.needs.map((need) => [need.key, yamlFiles[need.key]])),
      watch: yamlWatch,
      netLabels: {},
      preset: 'yaml',
      captures: capturePathsFromConfig(parsedYaml.value),
    });
  } catch (error) {
    setNotice(errorText(error), true);
  }
}

async function saveAndLaunch(input: {
  title: string;
  yaml: string;
  staged: Record<string, StagedFirmware>;
  watch: WatchOptions;
  netLabels: Record<string, string>;
  preset: StoredWorld['preset'];
  bench?: BenchDraft;
  captures?: string[];
}): Promise<void> {
  if (!store) return;
  busy = true;
  render();
  try {
    const world = await store.save(input);
    worlds = await store.list();
    await launchWorld(world);
    await refreshStorage();
    setNotice('World saved locally and started in the browser.', false);
  } catch (error) {
    setNotice(storageErrorText(error), true);
  } finally {
    busy = false;
    render();
  }
}

async function launchSaved(world: StoredWorld): Promise<void> {
  if (!store || busy) return;
  busy = true;
  render();
  try {
    const updated = await store.touch(world.id);
    worlds = await store.list();
    await launchWorld(updated);
    setNotice('Saved world loaded and started.', false);
  } catch (error) {
    setNotice(storageErrorText(error), true);
  } finally {
    busy = false;
    render();
  }
}

async function launchWorld(world: StoredWorld): Promise<void> {
  stopPump();
  uartGrouper.flushAll();
  eventBuffer.clear();
  pinLevels.clear();
  controlLevels.clear();
  softUartDecoders.clear();
  softUartNetDecoders.clear();
  activeWorld = world;
  activeCapturePaths = world.captures ?? [];
  for (const component of world.bench?.components ?? []) {
    if (component.kind === 'gpio-control') controlLevels.set(component.id, component.initial);
    if (component.kind === 'soft-uart') {
      const decoder = new SoftUartDecoder(component.baud);
      softUartDecoders.set(component.id, { component, decoder });
      const net = netId(component.cpuId, component.txPin);
      const list = softUartNetDecoders.get(net) ?? [];
      list.push({ endpoint: `${component.cpuId}.${component.id}`, decoder });
      softUartNetDecoders.set(net, list);
    }
  }
  activeEndpoints = [];
  activeStatus = { loaded: false, running: false, speed: 0 };
  tab = 'saved';
  render();
  activeEndpoints = await client.loadWorld(world, store!);
  for (const component of world.bench?.components ?? []) {
    if (component.kind === 'gpio-control') {
      const state = component.initial ? component.active : 'hiz';
      await client.drive(netId(component.cpuId, component.pin), state);
    }
  }
  for (const action of world.bench ? benchActions(world.bench) : []) {
    if (action.kind === 'set') await client.set(action.endpoint, action.value, action.atNs);
    else await client.drive(action.net, action.state, action.atNs);
  }
  await client.run();
  activeStatus = { loaded: true, running: true, speed: 0 };
  render();
  startPump();
}

async function setControl(component: GpioControlComponent, pressed: boolean): Promise<void> {
  if (!activeStatus.running) return;
  const state = pressed ? component.active : 'hiz';
  try {
    await client.drive(netId(component.cpuId, component.pin), state);
    controlLevels.set(component.id, pressed);
    const button = root.querySelector<HTMLElement>(`[data-toggle-control="${CSS.escape(component.id)}"], [data-control-button="${CSS.escape(component.id)}"]`);
    if (button) {
      button.classList.toggle('is-on', pressed);
      button.textContent = component.control === 'button'
        ? translate(`${component.label} · ${pressed ? 'pressed' : 'press'}`)
        : translate(`${component.label} · ${pressed ? 'ON' : 'OFF'}`);
    }
  } catch (error) { setNotice(errorText(error), true); }
}

async function removeWorld(world: StoredWorld): Promise<void> {
  if (!store) return;
  try {
    await store.remove(world.id);
    worlds = await store.list();
    await refreshStorage();
    setNotice(`“${displayWorldTitle(world)}” deleted. Unused firmware files were removed.`, false);
    render();
  } catch (error) { setNotice(storageErrorText(error), true); }
}

async function pauseSimulation(): Promise<void> {
  try {
    await client.pause();
    activeStatus = await client.status();
    stopPump();
    render();
  } catch (error) { setNotice(errorText(error), true); }
}

async function resumeSimulation(): Promise<void> {
  try {
    await client.run();
    activeStatus = await client.status();
    startPump();
    render();
  } catch (error) { setNotice(errorText(error), true); }
}

function startPump(): void {
  stopPump();
  const tick = () => {
    client.pump();
    pumpFrame = requestAnimationFrame(tick);
  };
  pumpFrame = requestAnimationFrame(tick);
  if (statusTimer) window.clearInterval(statusTimer);
  statusTimer = window.setInterval(() => {
    void client.status().catch((error: unknown) => setNotice(errorText(error), true));
  }, 1500);
}

function stopPump(): void {
  if (pumpFrame) cancelAnimationFrame(pumpFrame);
  pumpFrame = 0;
  if (statusTimer) window.clearInterval(statusTimer);
  statusTimer = 0;
}

function formatTime(timeNs: number): string {
  const milliseconds = timeNs / 1_000_000;
  if (milliseconds < 1000) return `${milliseconds.toLocaleString(activeLocale(), { minimumFractionDigits: 3, maximumFractionDigits: 3 })} ${translate('ms')}`;
  return `${(milliseconds / 1000).toLocaleString(activeLocale(), { minimumFractionDigits: 3, maximumFractionDigits: 3 })} ${translate('s')}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected a YAML object.`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: enter a non-empty string.`);
  return value.trim();
}

function parseBenchComponent(input: unknown): BenchComponent {
  const value = asRecord(input, 'Device block');
  const id = requiredText(value.id, 'id');
  const cpuId = requiredText(value.cpuId, 'cpuId');
  const kind = requiredText(value.kind, 'kind');
  if (kind === 'hardware-uart') {
    return { id, cpuId, kind, port: requiredText(value.port, 'port'), baudNote: String(value.baudNote ?? '') };
  }
  if (kind === 'soft-uart') {
    return {
      id, cpuId, kind,
      txPin: requiredText(value.txPin, 'txPin'),
      rxPin: requiredText(value.rxPin, 'rxPin'),
      baud: Number(value.baud),
    };
  }
  if (kind === 'gpio-control') {
    const control = requiredText(value.control, 'control');
    const active = requiredText(value.active, 'active');
    if (control !== 'button' && control !== 'switch') throw new Error('control must be button or switch.');
    if (active !== 'high' && active !== 'low') throw new Error('active must be high or low.');
    return {
      id, cpuId, kind, pin: requiredText(value.pin, 'pin'), label: requiredText(value.label, 'label'),
      control, active, initial: value.initial === true,
    };
  }
  throw new Error(`Unknown block kind: ${kind}.`);
}

function parseBenchStep(input: unknown): BenchStep {
  const value = asRecord(input, 'Scenario step');
  const id = requiredText(value.id, 'step.id');
  const componentId = requiredText(value.componentId, 'step.componentId');
  const afterMs = Number(value.afterMs);
  const kind = requiredText(value.kind, 'step.kind');
  if (kind === 'hardware-uart-send') return { id, componentId, afterMs, kind, hex: String(value.hex ?? '') };
  if (kind === 'soft-uart-send') return { id, componentId, afterMs, kind, text: String(value.text ?? '') };
  if (kind === 'gpio-set') return { id, componentId, afterMs, kind, pressed: value.pressed === true };
  throw new Error(`Unknown step kind: ${kind}.`);
}

function validateScenarioStructure(draft: BenchDraft): void {
  const stepIds = new Set<string>();
  for (const step of draft.steps) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(step.id) || stepIds.has(step.id)) throw new Error(`Invalid or duplicate step ID: ${step.id}.`);
    stepIds.add(step.id);
    if (!Number.isFinite(step.afterMs) || step.afterMs < 0 || step.afterMs > 86_400_000) throw new Error(`${step.id}: delay must be between 0 and 24 hours.`);
    const component = draft.components.find((item) => item.id === step.componentId);
    if (!component) throw new Error(`${step.id}: connected block not found.`);
    if (step.kind === 'hardware-uart-send' && component.kind !== 'hardware-uart' ||
        step.kind === 'soft-uart-send' && component.kind !== 'soft-uart' ||
        step.kind === 'gpio-set' && component.kind !== 'gpio-control') {
      throw new Error(`${step.id}: action type does not match the connected block.`);
    }
  }
}

function validateBenchDraft(draft: BenchDraft): void {
  if (!draft.cpus.length) throw new Error('Add at least one CPU.');
  const cpuIds = new Set<string>();
  for (const cpu of draft.cpus) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(cpu.id) || cpuIds.has(cpu.id)) throw new Error(`Invalid or duplicate CPU ID: ${cpu.id}.`);
    if (!modelInfo(cpu.model)) throw new Error(`Unknown CPU model: ${cpu.model}.`);
    cpuIds.add(cpu.id);
  }
  const componentIds = new Set<string>();
  const usedPins = new Set<string>();
  for (const component of draft.components) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(component.id) || componentIds.has(component.id)) throw new Error(`Invalid or duplicate block ID: ${component.id}.`);
    componentIds.add(component.id);
    const cpu = draft.cpus.find((item) => item.id === component.cpuId);
    if (!cpu) throw new Error(`Block ${component.id}: CPU “${component.cpuId}” not found.`);
    if (component.kind === 'hardware-uart') {
      if (!modelInfo(cpu.model)?.uarts.includes(component.port)) throw new Error(`${cpu.id}: model ${cpu.model} has no endpoint ${component.port}.`);
      if (draft.components.some((other) => other !== component && other.kind === 'hardware-uart' && other.cpuId === component.cpuId && other.port === component.port)) throw new Error(`${cpu.id}: ${component.port} is already connected.`);
    } else if (component.kind === 'soft-uart') {
      const pins = gpioPins(cpu.model);
      if (!pins.includes(component.txPin) || !pins.includes(component.rxPin)) throw new Error(`${component.id}: GPIO is not available on ${cpu.model}.`);
      if (component.txPin === component.rxPin) throw new Error(`${component.id}: TX and RX must use different GPIO pins.`);
      if (!Number.isFinite(component.baud) || component.baud < 1 || component.baud > 1_000_000) throw new Error(`${component.id}: baud rate must be between 1 and 1,000,000.`);
      for (const pin of [component.txPin, component.rxPin]) {
        const key = `${component.cpuId}.${pin}`;
        if (usedPins.has(key)) throw new Error(`${component.id}: ${pin} is already assigned to another block.`);
        usedPins.add(key);
      }
    } else {
      if (!gpioPins(cpu.model).includes(component.pin)) throw new Error(`${component.id}: GPIO ${component.pin} is not available on ${cpu.model}.`);
      if (!component.label.trim()) throw new Error(`${component.id}: enter a button or switch name.`);
      const key = `${component.cpuId}.${component.pin}`;
      if (usedPins.has(key)) throw new Error(`${component.id}: ${component.pin} is already assigned to another block.`);
      usedPins.add(key);
    }
  }
  if (draft.radioEnabled && !draft.cpus.some((cpu) => modelInfo(cpu.model)?.radio)) throw new Error('No CPU in this bench supports radio.');
  validateScenarioStructure(draft);
  benchActions(draft);
}

function eventValue(event: SimEvent): string {
  const value = event.value;
  if (value && typeof value === 'object' && 'hex' in value && typeof (value as { hex?: unknown }).hex === 'string') {
    const hex = (value as { hex: string }).hex;
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);
    const text = new TextDecoder().decode(bytes).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '·').trim();
    return `${text ? `«${text}» · ` : ''}${hex.match(/.{1,2}/g)?.join(' ') ?? ''}`;
  }
  if (typeof value === 'boolean') return value ? 'HIGH' : 'LOW';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function renderEventRow(event: SimEvent): string {
  return `<article class="event-row"><span class="event-time">${escapeHtml(formatTime(event.timeNs))}</span><span class="event-tag event-tag--${event.kind}">${event.kind === 'uart' ? 'UART' : event.kind === 'radio' ? 'AIR' : 'NET'}</span><div class="event-body"><strong>${escapeHtml(event.endpoint)}</strong><code>${escapeHtml(eventValue(event))}</code></div></article>`;
}

function rowsFor(kind?: SimEvent['kind']): SimEvent[] {
  let events = eventBuffer.values();
  if (kind) events = events.filter((event) => event.kind === kind);
  return events.slice(-100);
}

function replaceEventRows(list: HTMLElement, content: SimEvent[]): void {
  const followOutput = list.scrollHeight - list.scrollTop - list.clientHeight < 28;
  list.innerHTML = content.length ? content.map(renderEventRow).join('') : `<div class="empty-inline">${escapeHtml(translate('No events yet.'))}</div>`;
  if (followOutput) list.scrollTop = list.scrollHeight;
}

function renderEventLists(): void {
  const feed = document.querySelector<HTMLElement>('#event-feed');
  if (!feed) return;
  const events = eventBuffer.values();
  const visible = events.filter((event) => commonFilter[event.kind]).slice(-100);
  replaceEventRows(feed, visible);
  const mapping: Array<[SimEvent['kind'], string, string]> = [
    ['uart', '#uart-feed', '#count-uart'],
    ['radio', '#radio-feed', '#count-radio'],
    ['net', '#net-feed', '#count-net'],
  ];
  for (const [kind, listId, countId] of mapping) {
    const list = document.querySelector<HTMLElement>(listId);
    const count = document.querySelector<HTMLElement>(countId);
    const categoryEvents = rowsFor(kind);
    if (list) replaceEventRows(list, categoryEvents);
    if (count && kind !== 'net') count.textContent = String(events.filter((event) => event.kind === kind).length);
  }
  const total = document.querySelector<HTMLElement>('#event-total');
  if (total) total.textContent = eventCount(eventBuffer.size);
  for (const endpoint of activeEndpoints.filter((item) => item.kind === 'net')) {
    const latest = [...events].reverse().find((event) => event.kind === 'net' && event.endpoint === endpoint.name);
    if (latest) pinLevels.set(endpoint.name, latest.value);
  }
  if (document.querySelector('.drive-list')) updateDriveStates();
}

function updateDriveStates(): void {
  for (const endpoint of activeEndpoints.filter((item) => item.kind === 'net')) {
    const label = activeWorld?.netLabels[endpoint.name] ?? endpoint.name;
    const rows = document.querySelectorAll<HTMLElement>('.drive-row');
    rows.forEach((row) => {
      const select = row.querySelector<HTMLSelectElement>('[data-drive-state]');
      if (select?.dataset.driveState !== endpoint.name) return;
      const detail = row.querySelector<HTMLElement>('.drive-row__name small');
      if (detail) {
        const current = pinLevels.has(endpoint.name) ? (pinLevels.get(endpoint.name) ? 'HIGH' : 'LOW') : translate('floating');
        detail.textContent = translate(`${endpoint.name} · ${current}`);
      }
      void label;
    });
  }
}

function updateStatusDom(): void {
  const status = document.querySelector<HTMLElement>('#sim-status');
  if (!status) return;
  const mcuSummary = activeStatus.mcus?.map((mcu) => `${mcu.name}: ${translate(mcu.state)}`).join(' · ');
  const time = activeStatus.time_ns === undefined ? '' : ` · ${formatTime(activeStatus.time_ns)}`;
  status.textContent = `${translate(activeStatus.running ? 'Running' : activeStatus.loaded ? 'Paused' : 'Loading')}${time}${mcuSummary ? ` · ${mcuSummary}` : ''}`;
  const pause = document.querySelector<HTMLButtonElement>('#pause-sim');
  const run = document.querySelector<HTMLButtonElement>('#run-sim');
  if (pause) pause.disabled = !activeStatus.running;
  if (run) run.disabled = activeStatus.running || !activeStatus.loaded;
}

function scheduleEventRender(): void {
  if (renderTimer) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = 0;
    renderEventLists();
  }, 150);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storageErrorText(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: string }).name) : '';
  const message = errorText(error);
  if (name === 'QuotaExceededError' || /quota|storage.*full|disk.*full/i.test(message)) {
    return 'Browser storage is full. Delete unused worlds in History and try again.';
  }
  return message;
}

async function refreshStorage(): Promise<void> {
  if (!store) return;
  storageEstimate = await store.estimate().catch(() => ({}));
}

async function refreshWorlds(): Promise<void> {
  if (!store) return;
  try {
    worlds = await store.list();
    await refreshStorage();
    render();
  } catch (error) { setNotice(storageErrorText(error), true); }
}

client.setEventListener((event) => {
  recordEvent(event);
  if (event.kind === 'net' && typeof event.value === 'boolean') {
    for (const watcher of softUartNetDecoders.get(event.endpoint) ?? []) {
      const bytes = watcher.decoder.feed(event.timeNs, event.value);
      if (bytes.length) pushSoftUartBytes(watcher.endpoint, bytes, event.timeNs);
    }
  }
  scheduleEventRender();
});
client.setStatusListener((status) => {
  activeStatus = status;
  if (status.time_ns !== undefined) {
    for (const [id, item] of softUartDecoders) {
      const bytes = item.decoder.advance(status.time_ns);
      if (bytes.length) pushSoftUartBytes(`${item.component.cpuId}.${id}`, bytes, status.time_ns);
    }
    for (const event of uartGrouper.advance(status.time_ns)) eventBuffer.push(event);
  }
  if (!status.running) for (const event of uartGrouper.flushAll()) eventBuffer.push(event);
  scheduleEventRender();
  updateStatusDom();
});
client.setFaultListener((message) => setNotice(message, true));
async function init(): Promise<void> {
  render();
  try {
    store = await WorldStore.open();
    worlds = await store.list();
    await refreshStorage();
    render();
  } catch (error) {
    setNotice(`Local storage is unavailable: ${errorText(error)}`, true);
  }
}

window.addEventListener('pagehide', () => {
  stopPump();
  client.close();
  store?.close();
});

void init();

function pushSoftUartBytes(endpoint: string, bytes: number[], timeNs: number): void {
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  recordEvent({ endpoint, kind: 'uart', timeNs, value: { hex }, receivedAt: Date.now() });
}

function recordEvent(event: SimEvent): void {
  for (const grouped of uartGrouper.feed(event)) eventBuffer.push(grouped);
  scheduleEventRender();
}
