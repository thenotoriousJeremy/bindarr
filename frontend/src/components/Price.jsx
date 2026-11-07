import { useFx } from '../utils/useFx';
import { priceText } from '../utils/formatPrice';
import { useT } from '../utils/i18n';

// One marketplace price in the owner's display currency. Converted at the ECB
// rate when one is known, with the quoted price and the rate's date on hover;
// otherwise shown exactly as quoted (priceText with the row's own currency).
export default function Price({ value, currency }) {
  const { t } = useT();
  const { show } = useFx();
  const d = show(value, currency);
  if (!d.converted) return d.text;
  return (
    <span title={t('fx.convertedFrom', { price: priceText(value, currency || 'USD'), date: d.date })}>
      {d.text}
    </span>
  );
}
