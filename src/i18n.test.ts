import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './locales';
import { availableLocales, setLocale, translate } from './i18n';

describe('interface locales', () => {
  beforeEach(() => setLocale('ru'));
  afterEach(() => setLocale('en'));

  it('registers English and Russian for the language picker', () => {
    expect(availableLocales()).toEqual([
      { code: 'en', name: 'English' },
      { code: 'ru', name: 'Русский' },
    ]);
  });

  it('translates static and placeholder-based messages', () => {
    expect(translate('All events')).toBe('Все события');
    expect(translate('Step join: delay must be non-negative.')).toBe('Шаг join: задержка должна быть неотрицательной.');
    expect(translate('Firmware file')).toBe('Файл прошивки');
    expect(translate('board · firmware')).toBe('board · прошивка');
  });
});
