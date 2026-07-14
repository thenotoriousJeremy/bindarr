// Single source of truth for Pokémon English<->Japanese name display and search.
// Covers only ~45 popular species; anything unmapped falls back to English.
// ponytail: hardcoded micro-dictionary, not a real localization source — do not
// hand-expand it. If broad coverage is needed, replace it with a JP card dataset.
export const POKEMON_EN_TO_JP = {
  'Dragonite': 'カイリュー',
  'Dragonair': 'ハクリュー',
  'Dratini': 'ミニリュウ',
  'Charizard': 'リザードン',
  'Blastoise': 'カメックス',
  'Venusaur': 'フシギバナ',
  'Pikachu': 'ピカチュウ',
  'Raichu': 'ライチュウ',
  'Gyarados': 'ギャラドス',
  'Alakazam': 'フーディン',
  'Machamp': 'カイリキー',
  'Gengar': 'ゲンガー',
  'Mewtwo': 'ミュウツー',
  'Mew': 'ミュウ',
  'Lugia': 'ルギア',
  'Ho-Oh': 'ホウオウ',
  'Celebi': 'セレビィ',
  'Numel': 'ドンメル',
  'Camerupt': 'バクーダ',
  'Psyduck': 'コダック',
  'Ditto': 'メタモン',
  'Meowth': 'ニャース',
  'Snorlax': 'カビゴン',
  'Lucario': 'ルカリオ',
  'Greninja': 'ゲッコウガ',
  'Charmander': 'ヒトカゲ',
  'Bulbasaur': 'フシギダネ',
  'Squirtle': 'ゼニガメ',
  'Eevee': 'イーブイ',
  'Vaporeon': 'シャワーズ',
  'Jolteon': 'サンダース',
  'Flareon': 'ブースター',
  'Espeon': 'エーフィ',
  'Umbreon': 'ブラッキー',
  'Togepi': 'トゲピー',
  'Crobat': 'クロバット',
  'Ampharos': 'デンリュウ',
  'Scizor': 'ハッサム',
  'Heracross': 'ヘラクロス',
  'Pupitar': 'サナギラス',
  'Tyranitar': 'バンギラス',
  'Suicune': 'スイクン',
  'Raikou': 'ライコウ',
  'Entei': 'エンテイ',
  'Sprigatito': 'ニャオハ',
  'Fuecoco': 'ホゲータ',
  'Quaxly': 'クワッス'
};

// Inverse map, derived so the two directions can never drift apart.
const POKEMON_JP_TO_EN = Object.fromEntries(
  Object.entries(POKEMON_EN_TO_JP).map(([en, jp]) => [jp, en])
);

// Owner/variant name prefixes (e.g. "Dark Charizard" -> "わるいリザードン").
// Keyed English->Japanese; the search direction reads it in reverse.
const EN_JP_PREFIX = {
  'Dark ': 'わるい',
  'Light ': 'やさしい',
  'Shining ': 'ひかる',
  "Giovanni's ": 'サカキの',
  "Brock's ": 'タケシの',
  "Misty's ": 'カスミの',
  "Lt. Surge's ": 'マチスの',
  "Erika's ": 'エリカの',
  "Sabrina's ": 'ナツメの',
  "Koga's ": 'キョウの',
  "Blaine's ": 'カツラの'
};

// English card name shown in Japanese when the entry's language is Japanese.
// Unmapped names (or a non-Japanese language) return the English name unchanged.
export const getCardDisplayName = (englishName, language) => {
  if (language !== 'Japanese') return englishName;
  for (const [en, jp] of Object.entries(EN_JP_PREFIX)) {
    if (englishName.startsWith(en)) {
      const base = POKEMON_EN_TO_JP[englishName.slice(en.length)];
      return base ? jp + base : englishName;
    }
  }
  return POKEMON_EN_TO_JP[englishName] || englishName;
};

// A Japanese search string mapped back to the English name the card APIs use.
// Returns '' when nothing matches, so callers can fall back to the raw query.
export const translateJapaneseName = (rawJpName) => {
  let jp = rawJpName.replace(/[^\u3000-〿぀-ゟ゠-ヿ＀-￯一-龯]/g, '').trim();
  if (!jp) return '';

  let prefix = '';
  for (const [en, jpPrefix] of Object.entries(EN_JP_PREFIX)) {
    if (jp.startsWith(jpPrefix)) { prefix = en; jp = jp.slice(jpPrefix.length); break; }
  }

  let baseName = POKEMON_JP_TO_EN[jp];
  if (!baseName) {
    const foundKey = Object.keys(POKEMON_JP_TO_EN).find(k => jp.includes(k) || k.includes(jp));
    if (foundKey) baseName = POKEMON_JP_TO_EN[foundKey];
  }

  return baseName ? prefix + baseName : '';
};
