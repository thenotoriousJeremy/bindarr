import { useState, useEffect, useRef } from 'react';
import { Globe } from 'lucide-react';
import { useT } from '../utils/i18n';

// Instance-wide settings: data providers, price source, refresh cadence. Lives in
// the Admin panel on a server and in Settings in device mode, where the phone's
// one account is the admin and there is no Admin tab (see App.jsx).
//
// deviceMode drops what only means something on a server: the public base URL
// (share links, which nothing can follow to a phone) and pokemontcgapi.com,
// whose key is server configuration.
function InstanceSettings({ showToast, deviceMode = false }) {
  const { t } = useT();
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [pokemonProvider, setPokemonProvider] = useState('pokemontcg');
  const [mtgPriceSource, setMtgPriceSource] = useState('tcgplayer');
  const [priceRefreshDays, setPriceRefreshDays] = useState(1);
  const [sealedTcgExtra, setSealedTcgExtra] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const mountedRef = useRef(true);

  const applySettings = (data) => {
    setPublicBaseUrl(data.public_base_url || '');
    setPokemonProvider(data.pokemon_provider || 'pokemontcg');
    setMtgPriceSource(data.mtg_price_source || 'tcgplayer');
    setPriceRefreshDays(data.price_refresh_days ?? 1);
    setSealedTcgExtra(!!data.sealed_tcg_extra_enabled);
  };

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const response = await fetch('/api/settings');
        if (response.ok) {
          const data = await response.json();
          if (mountedRef.current) applySettings(data);
        }
      } catch (err) {
        console.error(err);
      }
    })();
    return () => { mountedRef.current = false; };
  }, []);

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSettingsLoading(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(deviceMode ? {} : { public_base_url: publicBaseUrl }),
          pokemon_provider: pokemonProvider,
          mtg_price_source: mtgPriceSource,
          price_refresh_days: Number(priceRefreshDays),
          sealed_tcg_extra_enabled: sealedTcgExtra,
        })
      });

      if (response.ok) {
        applySettings(await response.json());
        showToast(t('admin.settingsUpdated'));
      } else {
        const data = await response.json();
        showToast(data.error || t('admin.errSettings'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errSettingsGeneric'));
    } finally {
      setSettingsLoading(false);
    }
  };

  // minWidth 0: the provider labels are long, and a select's natural width is its
  // longest option. Without it, inside Settings' 1fr grid, that one select widened
  // every panel on the page past a phone's screen.
  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', minWidth: 0 }}>
      <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Globe size={18} style={{ color: 'var(--accent-red)' }} />
        {t(deviceMode ? 'settings.dataSourcesTitle' : 'admin.instanceTitle')}
      </h3>
      <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {!deviceMode && (
          <>
            <div style={{ background: 'rgba(255, 71, 71, 0.03)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {t('admin.instanceHint', { envVar: 'PUBLIC_BASE_URL' })}
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-public-base-url">{t('admin.publicBaseUrl')}</label>
              <input
                id="admin-public-base-url"
                type="text"
                name="public-base-url"
                autoComplete="off"
                className="input-control"
                placeholder="https://cards.example.com"
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
                disabled={settingsLoading}
              />
            </div>
          </>
        )}
        {/* Which Pokémon API this install speaks to. It has always been a column
            in app_settings and a branch in utils/pokemonProvider, with no way
            to set it — so every install ran on pokemontcg.io whether or not it
            suited them. The two are not interchangeable: they number the same
            sets differently, so switching re-syncs the set table and rebuilds
            the TCGplayer product map behind it. */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="admin-pokemon-provider">{t('admin.pokemonProvider')}</label>
          <select
            id="admin-pokemon-provider"
            className="select-control"
            value={pokemonProvider}
            onChange={(e) => setPokemonProvider(e.target.value)}
            disabled={settingsLoading}
          >
            <option value="pokemontcg">{t('admin.providerPokemontcg')}</option>
            <option value="tcgdex">{t('admin.providerTcgdex')}</option>
            {!deviceMode && <option value="pokemontcgapi">pokemontcgapi.com</option>}
          </select>
          <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {t(pokemonProvider === 'pokemontcgapi' ? 'admin.pokemontcgapiHint' : 'admin.pokemonProviderHint')}
          </p>
        </div>
        {/* Which marketplace Magic prices are read from first (#93). Scryfall
            quotes TCGplayer in USD and Cardmarket in EUR; reading USD first left
            European collections a mix of the two, summed as one number on the
            dashboard. Instance-wide because card_cache is shared. There is no
            conversion either way — a printing with no quote in the chosen
            currency keeps the other one, and the row says which. */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="admin-mtg-price-source">{t('admin.mtgPriceSource')}</label>
          <select
            id="admin-mtg-price-source"
            className="select-control"
            value={mtgPriceSource}
            onChange={(e) => setMtgPriceSource(e.target.value)}
            disabled={settingsLoading}
          >
            <option value="tcgplayer">{t('admin.mtgPriceTcgplayer')}</option>
            <option value="cardmarket">{t('admin.mtgPriceCardmarket')}</option>
          </select>
          <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {t('admin.mtgPriceSourceHint')}
          </p>
        </div>
        {/* How often prices are refreshed automatically.
            Every provider here is free except one: the optional
            pokemontcgapi.com provider charges credits per card refreshed, so
            a daily sweep of a large collection is a recurring bill rather
            than a recurring courtesy. Daily stays the default — that is what
            every install did before this existed — but someone who checks
            their collection value monthly can now say so. */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="admin-price-refresh">{t('admin.priceRefresh')}</label>
          <select
            id="admin-price-refresh"
            className="select-control"
            value={priceRefreshDays}
            onChange={(e) => setPriceRefreshDays(Number(e.target.value))}
            disabled={settingsLoading}
          >
            <option value={1}>{t('admin.priceRefreshDaily')}</option>
            <option value={3}>{t('admin.priceRefresh3')}</option>
            <option value={7}>{t('admin.priceRefreshWeekly')}</option>
            <option value={30}>{t('admin.priceRefreshMonthly')}</option>
            <option value={0}>{t('admin.priceRefreshOff')}</option>
          </select>
          <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {t(deviceMode ? 'settings.devicePriceRefreshHint' : 'admin.priceRefreshHint')}
          </p>
        </div>
        {/* Off by default: pricing Magic/Lorcana sealed product means the daily
            TCGCSV sync also walks every MTG and Lorcana set, a multiple of the
            Pokémon requests (see tcgcsvApi.syncCategories). */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={sealedTcgExtra}
              onChange={(e) => setSealedTcgExtra(e.target.checked)}
              disabled={settingsLoading}
            />
            {t('admin.sealedTcgExtra')}
          </label>
          <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {t('admin.sealedTcgExtraHint')}
          </p>
        </div>
        <button type="submit" className="btn btn-primary" style={{ padding: '0.6rem', fontWeight: 700, alignSelf: 'flex-start' }} disabled={settingsLoading}>
          {settingsLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : t('admin.saveSettings')}
        </button>
      </form>
    </div>
  );
}

export default InstanceSettings;
