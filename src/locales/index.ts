import { registerLocale } from '../i18n';
import { russian } from './ru';

// English phrases in the interface are the source keys. Add another locale by
// registering a phrase-to-translation catalog here; the language picker appears
// automatically once more than one locale is available.
registerLocale('en', 'English', {});
registerLocale('ru', 'Русский', russian);
