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

export const getCardDisplayName = (englishName, language) => {
  if (language !== 'Japanese') return englishName;

  let name = englishName;
  let prefix = '';
  
  if (name.startsWith('Dark ')) {
    prefix = 'わるい';
    name = name.substring(5);
  } else if (name.startsWith('Light ')) {
    prefix = 'やさしい';
    name = name.substring(6);
  } else if (name.startsWith('Shining ')) {
    prefix = 'ひかる';
    name = name.substring(8);
  } else if (name.startsWith("Giovanni's ")) {
    prefix = 'サカキの';
    name = name.substring(11);
  } else if (name.startsWith("Brock's ")) {
    prefix = 'タケシの';
    name = name.substring(8);
  } else if (name.startsWith("Misty's ")) {
    prefix = 'カスミの';
    name = name.substring(8);
  } else if (name.startsWith("Lt. Surge's ")) {
    prefix = 'マチスの';
    name = name.substring(12);
  } else if (name.startsWith("Erika's ")) {
    prefix = 'エリカの';
    name = name.substring(8);
  } else if (name.startsWith("Sabrina's ")) {
    prefix = 'ナツメの';
    name = name.substring(10);
  } else if (name.startsWith("Koga's ")) {
    prefix = 'キョウの';
    name = name.substring(7);
  } else if (name.startsWith("Blaine's ")) {
    prefix = 'カツラの';
    name = name.substring(9);
  }

  // Check mapped name
  const jpBase = POKEMON_EN_TO_JP[name];
  if (jpBase) {
    return prefix + jpBase;
  }

  return englishName;
};
