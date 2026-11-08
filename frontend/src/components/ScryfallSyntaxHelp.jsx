import { Fragment, useState } from 'react';
import { HelpCircle, ExternalLink } from 'lucide-react';
import { useT } from '../utils/i18n';

// The cheat sheet under Magic's search boxes: a one-line hint that opens a short
// list of Scryfall-syntax examples and a link to Scryfall's full guide.
//
// `context` is which box it sits under, because the two answer differently. Card
// search sends the query to Scryfall, so every keyword in the guide works there;
// the collection (and the deck builder's search of it) answers from the cached
// cards, so only the keywords below — see shared/scryfallQuery.mjs.
//
// The examples are syntax, so they are not translated; what each one does is.
const EXAMPLES = [
  ['t:creature', 'type'],
  ['o:"draw a card"', 'oracle'],
  ['c:g   c=wu', 'color'],
  ['id:esper', 'identity'],
  ['cmc<=3   mv=even', 'manaValue'],
  ['m:{2}{G}', 'manaCost'],
  ['pow>=4   tou<pow   loy=3', 'stats'],
  ['r:rare   r>=u', 'rarity'],
  ['s:mh3   cn:123', 'set'],
  ['kw:flying', 'keyword'],
  ['is:foil', 'foil'],
  ['lang:ja', 'lang'],
  ['usd>5   eur<1', 'price'],
  ['-t:land', 'negate'],
  ['(c:r or c:g)', 'either'],
  ['"bolt"   !"Lightning Bolt"', 'exact'],
];

const codeStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '0.72rem',
  color: 'var(--text-strong)',
  background: 'var(--surface-3)',
  borderRadius: '4px',
  padding: '0.05rem 0.35rem',
  whiteSpace: 'pre',
};

function ScryfallSyntaxHelp({ context = 'search' }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const inCollection = context === 'collection';
  // is:foil is about the copy in the collection, the printing in card search.
  const label = (key) => t(`syntax.ex.${key === 'foil' ? (inCollection ? 'foilCollection' : 'foilSearch') : key}`);

  return (
    <div style={{ fontSize: '0.75rem', minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        title={t('syntax.toggleHint')}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', flexWrap: 'wrap', textAlign: 'left' }}
      >
        <HelpCircle size={13} />
        <span>{t('syntax.toggle')}</span>
        <code style={codeStyle}>t:creature c:g cmc&lt;=3</code>
      </button>

      {open && (
        <div role="note" style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'var(--surface-1)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {t(inCollection ? 'syntax.introCollection' : 'syntax.introSearch')}
          </p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '0.35rem 0.75rem', margin: 0, alignItems: 'baseline' }}>
            {EXAMPLES.map(([example, key]) => (
              <Fragment key={key}>
                <dt style={{ margin: 0 }}><code style={codeStyle}>{example}</code></dt>
                <dd style={{ margin: 0, color: 'var(--text-secondary)' }}>{label(key)}</dd>
              </Fragment>
            ))}
          </dl>
          <p style={{ margin: 0, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            {t(inCollection ? 'syntax.collectionOnly' : 'syntax.searchAll')}
          </p>
          <a
            href="https://scryfall.com/docs/syntax"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent-blue)', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', width: 'fit-content' }}
          >
            {t('syntax.docs')} <ExternalLink size={11} />
          </a>
        </div>
      )}
    </div>
  );
}

export default ScryfallSyntaxHelp;
