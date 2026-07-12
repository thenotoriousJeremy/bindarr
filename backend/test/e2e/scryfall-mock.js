const axios = require('axios');
const originalGet = axios.Axios.prototype.get;

axios.Axios.prototype.get = async function(url, config) {
  const fullUrl = (this.defaults.baseURL || '') + url;
  
  if (fullUrl.includes('api.scryfall.com')) {
    // Simulate API delay if requested
    if (process.env.MOCK_SCRYFALL_DELAY === 'true') {
      await new Promise(resolve => setTimeout(resolve, 7000));
    }
    
    // Simulate API error if requested
    if (process.env.MOCK_SCRYFALL_ERROR === 'true') {
      const err = new Error('Request failed with status code 500');
      err.response = { status: 500 };
      throw err;
    }

    // Determine card response based on query parameter
    let name = 'Black Lotus';
    let id = 'lea-232';
    let set = 'lea';
    let num = '232';
    let prices = { usd: '10000.00', usd_foil: null };
    let colors = [];
    let type_line = 'Artifact';
    let rarity = 'rare';
    let image_uris = { normal: 'https://images.scryfall.com/lotus.png' };

    if (fullUrl.includes('Lightning') || fullUrl.includes('146')) {
      name = 'Lightning Bolt';
      id = '54321';
      set = 'm10';
      num = '146';
      prices = { usd: '0.50', usd_foil: '2.50' };
      colors = ['R'];
      type_line = 'Instant';
      rarity = 'common';
      image_uris = { normal: 'https://images.scryfall.com/bolt.png' };
    } else if (fullUrl.includes('jp123') || fullUrl.includes('lang=ja') || fullUrl.includes('%e9%bb%92%e3%81%8d%e8%93%ae')) {
      name = '黒き蓮';
      id = 'jp123';
      set = 'lea';
      num = '232';
      prices = { usd: '12000.00', usd_foil: null };
      colors = [];
      type_line = 'Artifact';
      rarity = 'rare';
      image_uris = { normal: 'https://images.scryfall.com/lotus-ja.png' };
    } else if (fullUrl.includes('Delver')) {
      return {
        data: {
          object: 'list',
          data: [
            {
              id: 'dfc1',
              name: 'Delver of Secrets // Insectile Aberration',
              layout: 'transform',
              card_faces: [
                {
                  name: 'Delver of Secrets',
                  type_line: 'Creature - Human Wizard',
                  colors: ['U'],
                  image_uris: { normal: 'https://images.scryfall.com/delver.png' }
                },
                {
                  name: 'Insectile Aberration',
                  type_line: 'Creature - Human Insect',
                  colors: ['U'],
                  image_uris: { normal: 'https://images.scryfall.com/aberration.png' }
                }
              ],
              rarity: 'uncommon',
              set: 'isd',
              set_name: 'Innistrad',
              collector_number: '51',
              prices: { usd: '1.00', usd_foil: '5.00' }
            }
          ]
        }
      };
    } else if (fullUrl.includes('ELD') || fullUrl.includes('171')) {
      name = 'Questing Beast';
      id = 'eld-171';
      set = 'eld';
      num = '171';
      prices = { usd: '10.00', usd_foil: null };
      colors = ['G'];
      type_line = 'Creature';
      rarity = 'rare';
      image_uris = { normal: 'https://images.scryfall.com/image.png' };
    } else if (fullUrl.includes('NonExistentCardName') || fullUrl.includes('Spam')) {
      return { data: { object: 'list', data: [] } };
    }

    return {
      data: {
        object: 'list',
        data: [
          {
            id,
            name,
            type_line,
            rarity,
            set,
            set_name: 'Limited Edition Alpha',
            collector_number: num,
            image_uris,
            prices,
            colors
          }
        ]
      }
    };
  }
  
  return originalGet.call(this, url, config);
};
