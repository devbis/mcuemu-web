import { parse, stringify } from 'yaml';
import type { ConfigObject } from './yaml';

export type BlockModes = Record<string, 'visual' | 'yaml'>;

const escapeHtml = (value: unknown): string => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function blockYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

function pathAttr(path: Array<string | number>): string {
  return escapeHtml(JSON.stringify(path));
}

function renderValue(section: string, path: Array<string | number>, value: unknown, label: string): string {
  const pathValue = pathAttr(path);
  if (Array.isArray(value)) {
    return `<fieldset class="yaml-value yaml-value--array"><legend>${escapeHtml(label)} <span>${value.length}</span></legend><div class="yaml-children">${value.map((item, index) => `<div class="yaml-item"><div class="yaml-item__head"><span>${index + 1}</span><button type="button" class="text-button" data-block-remove="${escapeHtml(section)}" data-block-path="${pathAttr([...path, index])}">Remove</button></div>${renderValue(section, [...path, index], item, `Item ${index + 1}`)}</div>`).join('')}</div><button type="button" class="button button--quiet button--small" data-block-add="${escapeHtml(section)}" data-block-path="${pathValue}" data-block-kind="item">Add item</button></fieldset>`;
  }
  if (value !== null && typeof value === 'object') {
    return `<fieldset class="yaml-value"><legend>${escapeHtml(label)}</legend><div class="yaml-children">${Object.entries(value as ConfigObject).map(([key, child]) => `<div class="yaml-item">${renderValue(section, [...path, key], child, key)}<button type="button" class="text-button yaml-remove" data-block-remove="${escapeHtml(section)}" data-block-path="${pathAttr([...path, key])}">Remove field</button></div>`).join('')}</div><button type="button" class="button button--quiet button--small" data-block-add="${escapeHtml(section)}" data-block-path="${pathValue}" data-block-kind="key">Add field</button></fieldset>`;
  }
  const kind = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string';
  const input = kind === 'boolean'
    ? `<select data-block-value="${escapeHtml(section)}" data-block-path="${pathValue}" data-block-kind="boolean"><option value="true" ${value === true ? 'selected' : ''}>true</option><option value="false" ${value === false ? 'selected' : ''}>false</option></select>`
    : `<input type="${kind === 'number' ? 'number' : 'text'}" ${kind === 'number' ? 'step="any"' : ''} value="${escapeHtml(value ?? '')}" data-block-value="${escapeHtml(section)}" data-block-path="${pathValue}" data-block-kind="${kind}" />`;
  return `<label class="yaml-scalar"><span>${escapeHtml(label)}</span>${input}</label>`;
}

export function renderBlockEditor(root: ConfigObject, modes: BlockModes): string {
  const knownSections: Array<[string, string]> = [
    ['world', 'World settings'], ['devices', 'Devices and MCUs'], ['nets', 'Nets and pins'],
    ['links', 'Links'], ['attach', 'Monitoring'], ['scenario', 'Scenario'],
  ];
  const missing = knownSections.filter(([key]) => !(key in root));
  const addBlock = missing.length
    ? `<div class="block-add"><select id="add-block-select" aria-label="Block type">${missing.map(([key, title]) => `<option value="${escapeHtml(key)}">${escapeHtml(title)}</option>`).join('')}</select><button type="button" class="button button--quiet button--small" data-add-block>Add block</button></div>`
    : '';
  const uartAction = root.scenario
    ? '<button type="button" class="button button--quiet button--small" data-add-uart-action>Add UART action</button>'
    : '';
  return `<section class="block-editor" aria-label="Block editor">${addBlock}${uartAction}${Object.entries(root).map(([key, value]) => {
    const title = ({ world: 'World settings', devices: 'Devices and MCUs', nets: 'Nets and pins', links: 'Links', attach: 'Monitoring', scenario: 'Scenario', version: 'Version' } as Record<string, string>)[key] ?? `YAML: ${key}`;
    const mode = modes[key] ?? 'visual';
    const supported = ['world', 'devices', 'nets', 'links', 'attach', 'scenario', 'version'].includes(key);
    const content = mode === 'yaml' || !supported
      ? `<textarea class="block-yaml" data-block-yaml="${escapeHtml(key)}" spellcheck="false">${escapeHtml(blockYaml(value))}</textarea><button type="button" class="button button--quiet button--small" data-block-apply="${escapeHtml(key)}">Apply YAML</button>`
      : renderValue(key, [key], value, title);
    return `<article class="config-block"><header class="config-block__head"><div><span class="block-grip">⠿</span><h3>${escapeHtml(title)}</h3></div><div>${supported ? `<button type="button" class="text-button" data-block-mode="${escapeHtml(key)}" data-mode="${mode === 'visual' ? 'yaml' : 'visual'}">${mode === 'visual' ? 'Edit YAML' : 'Visual editor'}</button>` : '<span class="block-raw-label">YAML only</span>'}</div></header><div class="config-block__body">${content}</div></article>`;
  }).join('')}</section>`;
}

function setAtPath(root: ConfigObject, path: Array<string | number>, value: unknown): void {
  const key = path.pop();
  if (key === undefined) return;
  let target: unknown = root;
  for (const part of path) target = (target as Record<string | number, unknown>)[part];
  (target as Record<string | number, unknown>)[key] = value;
}

function removeAtPath(root: ConfigObject, path: Array<string | number>): void {
  const key = path.pop();
  if (key === undefined) return;
  let target: unknown = root;
  for (const part of path) target = (target as Record<string | number, unknown>)[part];
  if (Array.isArray(target)) target.splice(Number(key), 1);
  else delete (target as Record<string, unknown>)[String(key)];
}

export function editBlockValue(root: ConfigObject, path: Array<string | number>, value: unknown): void {
  setAtPath(root, [...path], value);
}

export function removeBlockValue(root: ConfigObject, path: Array<string | number>): void {
  removeAtPath(root, [...path]);
}

export function addBlockValue(root: ConfigObject, path: Array<string | number>, kind: 'key' | 'item', key = 'new_field'): void {
  let target: unknown = root;
  for (const part of path) target = (target as Record<string | number, unknown>)[part];
  if (kind === 'item' && Array.isArray(target)) target.push('');
  if (kind === 'key' && target && typeof target === 'object' && !Array.isArray(target)) {
    let name = key;
    let suffix = 2;
    while (name in target) name = `${key}_${suffix++}`;
    (target as ConfigObject)[name] = '';
  }
}

export function parseBlockYaml(text: string): unknown {
  return parse(text);
}

export function serializedWorld(root: ConfigObject): string {
  return stringify(root, { lineWidth: 0 });
}
