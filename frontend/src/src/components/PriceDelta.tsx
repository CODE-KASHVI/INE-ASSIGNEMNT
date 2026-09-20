import { formatPriceChange } from '../utils/format';

export function PriceDelta({
  change,
  percent,
  currency,
}: {
  change: number | null;
  percent: number | null;
  currency: string | null;
}) {
  const text = formatPriceChange(change, percent, currency);
  if (!text || change == null) return <span className="font-mono text-sm text-muted">no change</span>;

  const color = change > 0 ? 'text-failed' : 'text-healthy';
  return <span className={`font-mono text-sm font-medium ${color}`}>{text}</span>;
}
