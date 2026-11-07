import { Suspense } from 'react';
import { BarChart2 } from 'lucide-react';
import { useT } from '../../utils/i18n';
import { lazyNamed } from '../../utils/lazyWithReload';
import ChartFallback from '../charts/ChartFallback';
import { cardGroup as cardGroupFor } from './deckHelpers';

// The analytics plots are code-split (charts/DeckCharts), so recharts is fetched
// when a deck's stats are first drawn rather than with the deck list.
const deckCharts = () => import('../charts/DeckCharts');
const CostCurveBars = lazyNamed(deckCharts, 'CostCurveBars');
const SupertypeDonut = lazyNamed(deckCharts, 'SupertypeDonut');
const TypeBars = lazyNamed(deckCharts, 'TypeBars');

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

// The open deck's statistics panels: cost curve, supertype breakdown and the
// energy / color distribution. Each panel is drawn only when it has data.
export default function DeckStats({ activeDeck, deckGame }) {
  const { t } = useT();
  const cardGroup = (card) => cardGroupFor(deckGame, card);

  // --- CHART DATA GENERATION ---
  const getSupertypeChartData = () => {
    if (!activeDeck) return [];
    const counts = {};
    activeDeck.cards.forEach(c => {
      const g = cardGroup(c);
      counts[g] = (counts[g] || 0) + c.quantity;
    });
    return Object.keys(counts).map(key => ({ name: key, value: counts[key] })).filter(d => d.value > 0);
  };

  const getManaCurveData = () => {
    if (!activeDeck) return [];
    const counts = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7+': 0 };
    activeDeck.cards.forEach(c => {
      const val = c.cmc !== undefined && c.cmc !== null
        ? c.cmc
        : (c.convertedEnergyCost !== undefined && c.convertedEnergyCost !== null ? c.convertedEnergyCost : null);
      if (val !== null) {
        const bucket = val >= 7 ? '7+' : String(Math.floor(val));
        if (counts[bucket] !== undefined) counts[bucket] += c.quantity;
      }
    });
    return Object.keys(counts).map(cost => ({ cost, count: counts[cost] }));
  };

  const getEnergyChartData = () => {
    if (!activeDeck) return [];
    const map = {};
    if (deckGame === 'mtg') {
      // Color and Land type distribution
      activeDeck.cards.forEach(c => {
        const subs = c.subtypes || [];
        const isLand = subs.includes('Land') || c.supertype === 'Land' || cardGroup(c) === 'Land';
        if (isLand) {
          const basicLandTypes = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
          const foundType = basicLandTypes.find(t => subs.includes(t) || c.name.includes(t));
          const label = foundType ? `Land (${foundType})` : 'Land (Nonbasic)';
          map[label] = (map[label] || 0) + c.quantity;
        } else {
          const colors = c.colors || c.types || [];
          if (colors.length === 0) {
            map['Colorless'] = (map['Colorless'] || 0) + c.quantity;
          } else {
            colors.forEach(col => {
              const colorName = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[col] || col;
              map[colorName] = (map[colorName] || 0) + c.quantity;
            });
          }
        }
      });
      return Object.keys(map).map(key => ({ name: key, value: map[key] }));
    }
    if (deckGame === 'lorcana') {
      activeDeck.cards.forEach(c => {
        const inks = Array.isArray(c.types) && c.types.length ? c.types : (c.ink ? [c.ink] : []);
        if (inks.length === 0) {
          map['Colorless'] = (map['Colorless'] || 0) + c.quantity;
        } else {
          inks.forEach(ink => { map[ink] = (map[ink] || 0) + c.quantity; });
        }
      });
      return Object.keys(map).map(key => ({ name: key, value: map[key] }));
    }
    activeDeck.cards.forEach(c => {
      if (c.supertype === 'Energy') {
        const name = c.name.replace(/\s*Energy/i, '').trim() || 'Special';
        map[name] = (map[name] || 0) + c.quantity;
      } else if (c.types && c.types.length > 0) {
        c.types.forEach(t => { map[t] = (map[t] || 0) + c.quantity; });
      }
    });
    return Object.keys(map).map(key => ({ name: key, value: map[key] }));
  };

  const supertypeData = getSupertypeChartData();
  const energyData = getEnergyChartData();
  const manaCurveData = getManaCurveData();

  return (
    <>
      {/* Bar Chart: Mana / Energy Cost Curve */}
      {manaCurveData.some(d => d.count > 0) && (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <BarChart2 size={14} style={{ color: '#3b82f6' }} /> Energy / Mana Cost Curve
          </h3>
          <div style={{ width: '100%', height: '180px' }}>
            <Suspense fallback={<ChartFallback />}>
              <CostCurveBars data={manaCurveData} />
            </Suspense>
          </div>
        </div>
      )}

      {/* Pie Chart: Supertypes */}
      {supertypeData.length > 0 && (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <BarChart2 size={14} style={{ color: 'var(--accent-red)' }} /> Supertype Breakdown
          </h3>
          <div style={{ width: '100%', height: '180px' }}>
            <Suspense fallback={<ChartFallback />}>
              <SupertypeDonut data={supertypeData} colors={PIE_COLORS} />
            </Suspense>
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
            {supertypeData.map((d, index) => (
              <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem' }}>
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }}></div>
                <span style={{ color: 'var(--text-secondary)' }}>{d.name}: <strong>{d.value}</strong></span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bar Chart: Energy & Types Distribution */}
      {energyData.length > 0 && (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <BarChart2 size={14} style={{ color: 'var(--accent-yellow)' }} /> {t(deckGame === 'mtg' ? 'deck.colorLandDist' : 'dash.typeDistribution')}
          </h3>
          <div style={{ width: '100%', height: '220px' }}>
            <Suspense fallback={<ChartFallback />}>
              <TypeBars data={energyData} />
            </Suspense>
          </div>
        </div>
      )}
    </>
  );
}
