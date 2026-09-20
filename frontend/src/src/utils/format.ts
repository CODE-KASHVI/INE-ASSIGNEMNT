/** Matches the backend parser's own display convention (en-IN, no decimal places) — see backend/src/scraper/parser.ts. */
export function formatPrice(price: number | null, currency: string | null): string {
  if (price == null) return '—';
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency ?? 'INR',
      maximumFractionDigits: 0,
    }).format(price);
  } catch {
    return `${currency ?? ''} ${price.toLocaleString('en-IN')}`.trim();
  }
}

export function formatPriceChange(change: number | null, percent: number | null, currency: string | null): string | null {
  if (change == null || change === 0) return null;
  const sign = change > 0 ? '+' : '−';
  const abs = formatPrice(Math.abs(change), currency);
  const pct = percent != null ? ` (${sign}${Math.abs(percent).toFixed(1)}%)` : '';
  return `${sign}${abs}${pct}`;
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diffSeconds = Math.round((Date.now() - then) / 1000);

  if (diffSeconds < 5) return 'just now';
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDuration(ms: number | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
