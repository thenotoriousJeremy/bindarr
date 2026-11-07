// UI translation. Deliberately not a library: React context plus the platform's
// own Intl gives us plurals, number formatting and language names, which is the
// whole feature set we need. The pure part lives in translate.js.
//
// NOTE: this is the *interface* language. It has nothing to do with the language a
// card was printed in — that lives in utils/languages.js and is stored per
// collection entry. A German-speaking user may well collect Japanese cards, so the
// two settings never touch each other.
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import en from '../locales/en.json';
import { pickLocale, translate, setActiveLocale } from './translate';

// Every *.json in ../locales is picked up automatically, so a translator only has
// to drop de.json beside en.json — no registry to update, no import to add. Each
// is its own lazily-fetched chunk, so shipping twenty languages costs a user
// nothing until they pick one. en is excluded from the glob because it is already
// in the main bundle above, as the per-key fallback for every translation.
const LOCALE_FILES = Object.fromEntries(
  Object.entries(import.meta.glob(['../locales/*.json', '!../locales/en.json']))
    .map(([path, load]) => [path.match(/([^/\\]+)\.json$/)[1], load])
);

// eslint-disable-next-line react-refresh/only-export-components
export const LOCALES = ['en', ...Object.keys(LOCALE_FILES).sort()];

// Language names come from the platform, not a hand-kept table: 'de' renders as
// "Deutsch" to a German speaker and "German" to an English one. Locale files must
// therefore be named with a real BCP-47 tag (de.json, pt-BR.json, zh-Hant.json).
// eslint-disable-next-line react-refresh/only-export-components
export const localeName = (code, inLocale = code) => {
  try {
    return new Intl.DisplayNames([inLocale], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
};

const Ctx = createContext(null);

export function I18nProvider({ children }) {
  const [locale, setLocale] = useState(() => {
    const initial = localStorage.getItem('bindarr_ui_lang')
      || pickLocale(LOCALES, navigator.languages?.length ? navigator.languages : [navigator.language || 'en']);
    setActiveLocale(initial);
    return initial;
  });
  const [dict, setDict] = useState(() => (locale === 'en' ? en : null));

  useEffect(() => {
    const load = LOCALE_FILES[locale];
    if (!load) { setDict(en); return; }
    let live = true;
    load().then(mod => { if (live) setDict(mod.default || mod); })
      .catch(() => { if (live) setDict(en); });
    return () => { live = false; };
  }, [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({
    locale,
    setLocale: (next) => {
      localStorage.setItem('bindarr_ui_lang', next);
      // Before the re-render, so prices in it are already in the new notation.
      setActiveLocale(next);
      setLocale(next);
    },
    // t('key') / t('key', { name: 'Ash' }) / t('cards.count', { count: 3 })
    t: (key, vars) => translate(dict, en, locale, key, vars),
  }), [locale, dict]);

  // Hold the first paint until a non-English dictionary has landed, otherwise the
  // whole UI flashes English before swapping.
  if (!dict) return null;

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useT() {
  const ctx = useContext(Ctx);
  // Components rendered outside the provider (and unit checks) still need a t().
  if (!ctx) return { locale: 'en', setLocale: () => {}, t: (key, vars) => translate(en, en, 'en', key, vars) };
  return ctx;
}
