export type LocaleCatalog = Readonly<Record<string, string>>;

interface LocaleEntry {
  name: string;
  messages: LocaleCatalog;
}

const locales = new Map<string, LocaleEntry>();
let currentLocale = 'en';

export function registerLocale(code: string, name: string, messages: LocaleCatalog): void {
  locales.set(code, { name, messages });
  try {
    if (localStorage.getItem('mcuemu-web.locale') === code) currentLocale = code;
  } catch {
    // Storage may be disabled; English remains the default.
  }
}

export function availableLocales(): Array<{ code: string; name: string }> {
  return [...locales].map(([code, locale]) => ({ code, name: locale.name }));
}

export function activeLocale(): string {
  return currentLocale;
}

export function setLocale(code: string): void {
  if (!locales.has(code)) throw new Error(`Unsupported locale: ${code}`);
  currentLocale = code;
  if (typeof document !== 'undefined') document.documentElement.lang = code;
  try {
    localStorage.setItem('mcuemu-web.locale', code);
  } catch {
    // Keep the selection for this page even when storage is unavailable.
  }
}

export function translate(source: string): string {
  const catalog = locales.get(currentLocale)?.messages;
  if (!catalog) return source;
  if (catalog[source]) return catalog[source];

  for (const [pattern, translation] of Object.entries(catalog)) {
    if (!pattern.includes('{')) continue;
    const names: string[] = [];
    const expression = new RegExp(`^${pattern.split(/(\{[A-Za-z][A-Za-z0-9_]*\})/).map((part) => {
      if (part.startsWith('{') && part.endsWith('}')) {
        names.push(part.slice(1, -1));
        return '(.*?)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('')}$`);
    const match = source.match(expression);
    if (!match) continue;
    return translation.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
      const index = names.indexOf(name);
      return index < 0 ? placeholder : match[index + 1];
    });
  }
  return source;
}

function isUserContent(node: Node): boolean {
  const parent = node.parentElement;
  return Boolean(parent?.closest(
    'textarea, code, pre, .muted, .world-row__info h3, #simulation h2, .file-name, .drive-row__name, .event-body, .live-control, .cpu-block__head strong, .instrument-block header strong, .scenario-step header strong',
  ));
}

export function localizeUi(root: HTMLElement): void {
  if (currentLocale === 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? '';
    const trimmed = text.trim();
    if (!isUserContent(node) && trimmed) {
      const localized = translate(trimmed);
      if (localized !== trimmed) node.textContent = text.replace(trimmed, localized);
    }
    node = walker.nextNode();
  }

  root.querySelectorAll<HTMLElement>('[aria-label], [title], [placeholder]').forEach((element) => {
    for (const attribute of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, translate(value));
    }
  });
}
