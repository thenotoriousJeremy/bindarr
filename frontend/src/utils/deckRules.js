// The deck builder's side of shared/deckRules.mjs. The rules live there, in the one
// copy the server enforces too; this adds the part only the UI needs — putting a
// rule warning into words.
export {
  rulesFor, formatNames, defaultFormat, defaultTargetSize, supportsAnyPrinting, defaultAnyPrinting,
  copyLimit, isBasicEnergyOrLand, deckWarnings,
} from '../../../shared/deckRules.mjs';

// Names in a list, cut short with the existing "(+N more)" so one wide warning
// cannot push the Deck Health panel off a phone screen.
const listNames = (t, names, max = 6) => {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} ${t('deck.andMore', { count: names.length - max })}` : shown;
};

// One sentence per warning from deckWarnings(). `format` is the rules' own format
// name, so a deck saved under an old spelling still reads as the format it is held to.
export function ruleWarningText(t, warning, format) {
  switch (warning.code) {
    case 'size_exact':
      return t('deck.ruleSizeExact', { format, expected: warning.expected, actual: warning.actual });
    case 'size_min':
      return t('deck.ruleSizeMin', { format, min: warning.min, actual: warning.actual });
    case 'size_max':
      return t('deck.ruleSizeMax', { format, max: warning.max, actual: warning.actual });
    case 'copy_limit':
      return t('deck.ruleCopyLimit', { name: warning.name, count: warning.count, limit: warning.limit });
    case 'commander_missing':
      return t('deck.ruleCommanderMissing');
    case 'commander_too_many':
      return t('deck.ruleCommanderTooMany', { count: warning.count, max: warning.max });
    case 'commander_not_legal':
      return t('deck.ruleCommanderNotLegal', { name: warning.name });
    case 'commander_pair':
      return t('deck.ruleCommanderPair', { first: warning.names[0], second: warning.names[1] });
    case 'color_identity':
      return t('deck.ruleColorIdentity', {
        count: warning.cards.length,
        identity: warning.identity.length ? warning.identity.join('') : t('deck.colorless'),
        names: listNames(t, warning.cards.map(c => `${c.name} (${c.colors.join('')})`)),
      });
    default:
      // Riftbound's own rules (shared/deckRules.mjs riftboundWarnings): one string
      // each under deck.rb.<rule>, with the warning's details as its placeholders.
      if (String(warning.code).startsWith('rb_')) return t(`deck.rb.${warning.code.slice(3)}`, warning);
      return warning.code;
  }
}
