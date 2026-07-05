// Japanese-to-English Pokémon name lookup used by the camera scanner's OCR
// pipeline to recognize cards printed in Japanese.
const POKEMON_JP_TO_EN = {
  'カイリュー': 'Dragonite',
  'ハクリュー': 'Dragonair',
  'ミニリュウ': 'Dratini',
  'リザードン': 'Charizard',
  'カメックス': 'Blastoise',
  'フシギバナ': 'Venusaur',
  'ピカチュウ': 'Pikachu',
  'ライチュウ': 'Raichu',
  'ギャラドス': 'Gyarados',
  'フーディン': 'Alakazam',
  'カイリキー': 'Machamp',
  'ゲンガー': 'Gengar',
  'ミュウツー': 'Mewtwo',
  'ミュウ': 'Mew',
  'ルギア': 'Lugia',
  'ホウオウ': 'Ho-Oh',
  'セレビィ': 'Celebi',
  'ドンメル': 'Numel',
  'バクーダ': 'Camerupt',
  'コダック': 'Psyduck',
  'メタモン': 'Ditto',
  'ニャース': 'Meowth',
  'カビゴン': 'Snorlax',
  'ルカリオ': 'Lucario',
  'ゲッコウガ': 'Greninja',
  'ヒトカゲ': 'Charmander',
  'フシギダネ': 'Bulbasaur',
  'ゼニガメ': 'Squirtle',
  'イーブイ': 'Eevee',
  'シャワーズ': 'Vaporeon',
  'サンダース': 'Jolteon',
  'ブースター': 'Flareon',
  'エーフィ': 'Espeon',
  'ブラッキー': 'Umbreon',
  'トゲピー': 'Togepi',
  'クロバット': 'Crobat',
  'デンリュウ': 'Ampharos',
  'ハッサム': 'Scizor',
  'ヘラクロス': 'Heracross',
  'サナギラス': 'Pupitar',
  'バンギラス': 'Tyranitar',
  'スイクン': 'Suicune',
  'ライコウ': 'Raikou',
  'エンテイ': 'Entei',
  'ニャオハ': 'Sprigatito',
  'ホゲータ': 'Fuecoco',
  'クワッス': 'Quaxly'
};

export const translateJapaneseName = (rawJpName) => {
  let jp = rawJpName.replace(/[^　-〿぀-ゟ゠-ヿ＀-￯一-龯]/g, '').trim();
  if (!jp) return '';

  let prefix = '';
  if (jp.startsWith('わるい')) {
    prefix = 'Dark ';
    jp = jp.substring(3);
  } else if (jp.startsWith('やさしい')) {
    prefix = 'Light ';
    jp = jp.substring(4);
  } else if (jp.startsWith('ひかる')) {
    prefix = 'Shining ';
    jp = jp.substring(3);
  } else if (jp.startsWith('サカキの')) {
    prefix = "Giovanni's ";
    jp = jp.substring(4);
  } else if (jp.startsWith('タケシの')) {
    prefix = "Brock's ";
    jp = jp.substring(4);
  } else if (jp.startsWith('カスミの')) {
    prefix = "Misty's ";
    jp = jp.substring(4);
  } else if (jp.startsWith('マチスの')) {
    prefix = "Lt. Surge's ";
    jp = jp.substring(4);
  } else if (jp.startsWith('エリカの')) {
    prefix = "Erika's ";
    jp = jp.substring(4);
  } else if (jp.startsWith('ナツメの')) {
    prefix = "Sabrina's ";
    jp = jp.substring(4);
  } else if (jp.startsWith('キョウの')) {
    prefix = "Koga's ";
    jp = jp.substring(4);
  } else if (jp.startsWith('カツラの')) {
    prefix = "Blaine's ";
    jp = jp.substring(4);
  }

  let baseName = POKEMON_JP_TO_EN[jp];
  if (!baseName) {
    const foundKey = Object.keys(POKEMON_JP_TO_EN).find(k => jp.includes(k) || k.includes(jp));
    if (foundKey) {
      baseName = POKEMON_JP_TO_EN[foundKey];
    }
  }

  if (baseName) {
    return prefix + baseName;
  }
  return '';
};
