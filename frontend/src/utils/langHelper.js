import { translatePokemonName } from './pokemonHelper.js';
import { langCode } from './languages.js';
import { loadNameDictionaries, nameDictionaries, onNameDictionaries } from './nameDictionaries.js';

// The name dictionaries are fetched on first use (see nameDictionaries.js). Until
// they land a name shows in English and a Japanese query goes unmapped; asking is
// what starts the fetch, and useNameDictionaries re-renders what was drawn
// meanwhile.
let POKEMON_TRANSLATIONS = null;
let LORCANA_TRANSLATIONS = null;
// Filled in place when the dictionaries arrive, so an importer's reference stays good.
export const POKEMON_EN_TO_JP = {};
export const POKEMON_JP_TO_EN = {};

const take = ({ pokemon, lorcana }) => {
  POKEMON_TRANSLATIONS = pokemon;
  LORCANA_TRANSLATIONS = lorcana;
  for (const [en, langs] of Object.entries(pokemon)) {
    if (langs.ja) {
      POKEMON_EN_TO_JP[en] = langs.ja;
      POKEMON_JP_TO_EN[langs.ja] = en;
    }
  }
};
if (nameDictionaries()) take(nameDictionaries());
else onNameDictionaries(take);

export const nameDictionariesReady = () => POKEMON_TRANSLATIONS !== null;
export { loadNameDictionaries, onNameDictionaries };

// Only text in Japanese script needs the dictionaries to map a search; the ranges
// are the ones translateJapaneseName keeps.
const JAPANESE_TEXT = /[\u3000-\u3fff\uff00-\uffef\u4e00-\u9faf]/;
export const hasJapaneseText = (text) => JAPANESE_TEXT.test(String(text || ''));

export const translateLorcanaName = (englishName, language) => {
  if (!englishName) return '';
  const lang = langCode(language);
  if (!lang || lang === 'en') return englishName;
  if (!LORCANA_TRANSLATIONS) {
    loadNameDictionaries();
    return englishName;
  }

  const { characters = {}, versions = {} } = LORCANA_TRANSLATIONS;

  const sep = englishName.includes(' - ') ? ' - ' : (englishName.includes(' – ') ? ' – ' : null);
  if (sep) {
    const parts = englishName.split(sep);
    const charPart = parts[0].trim();
    const verPart = parts.slice(1).join(sep).trim();

    const charTrans = characters[charPart]?.[lang] || charPart;
    const verTrans = versions[verPart]?.[lang] || verPart;

    return `${charTrans} - ${verTrans}`;
  }

  if (characters[englishName]?.[lang]) return characters[englishName][lang];
  if (versions[englishName]?.[lang]) return versions[englishName][lang];

  return englishName;
};

// The name to show for a card. A printed name from the provider always wins — it
// is what is actually on the card, in any language. Failing that, an entry marked
// non-English falls back to the dictionaries, and everything else shows the English name.
export const getCardDisplayName = (englishName, language, printedName, game) => {
  if (printedName) return printedName;
  if (!englishName) return '';
  const code = langCode(language);
  if (!code || code === 'en') return englishName;
  if (!nameDictionariesReady()) {
    loadNameDictionaries();
    return englishName;
  }

  // Lorcana translation check
  if (game === 'lorcana' || englishName.includes(' - ') || (LORCANA_TRANSLATIONS.characters && LORCANA_TRANSLATIONS.characters[englishName])) {
    const translated = translateLorcanaName(englishName, language);
    if (translated !== englishName) return translated;
  }

  // Pokemon translation check
  const pkmTranslated = translatePokemonName(englishName, language, POKEMON_TRANSLATIONS);
  if (pkmTranslated && pkmTranslated !== englishName) return pkmTranslated;

  return englishName;
};

const JP_EN_PREFIX = {
  'わるい': 'Dark ',
  'やさしい': 'Light ',
  'ひかる': 'Shining ',
  'かがやく': 'Radiant ',
  'ヒスイ ': 'Hisuian ',
  'ヒスイ': 'Hisuian ',
  'ガラル ': 'Galarian ',
  'ガラル': 'Galarian ',
  'アローラ ': 'Alolan ',
  'アローラ': 'Alolan ',
  'パルデア ': 'Paldean ',
  'パルデア': 'Paldean ',
  'マチスの': "Lt. Surge's ",
  'ロケット団の': "Rocket's ",
  'タケシの': "Brock's ",
  'カスミの': "Misty's ",
  'ナツメの': "Sabrina's ",
  'エリカの': "Erika's ",
  'キョウの': "Koga's ",
  'カツラの': "Blaine's ",
  'サカキの': "Giovanni's "
};

// A Japanese search string mapped back to the English name the card APIs use.
// Returns '' when nothing matches, so callers can fall back to the raw query.
export const translateJapaneseName = (rawJpName) => {
  let jp = String(rawJpName || '').replace(/[^\u3000-㿿぀-ゟ゠-ヿ＀-￯一-龯]/g, '').trim();
  if (!jp) return '';
  if (!nameDictionariesReady()) {
    loadNameDictionaries();
    return '';
  }

  let prefix = '';
  for (const [jpPrefix, en] of Object.entries(JP_EN_PREFIX)) {
    if (jp.startsWith(jpPrefix)) {
      prefix = en;
      jp = jp.slice(jpPrefix.length).trim();
      break;
    }
  }

  if (POKEMON_JP_TO_EN[jp]) return prefix + POKEMON_JP_TO_EN[jp];
  const foundKey = Object.keys(POKEMON_JP_TO_EN).find(k => jp.includes(k) || k.includes(jp));
  if (foundKey) return prefix + POKEMON_JP_TO_EN[foundKey];

  return '';
};
