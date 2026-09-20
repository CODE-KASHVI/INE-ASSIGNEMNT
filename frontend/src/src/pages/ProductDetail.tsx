import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from '../api/client';
import type { HistoryPointDto, LogEntryDto, ProductDto } from '../api/types';
import { HealthBadge } from '../components/HealthBadge';
import { StockBadge } from '../components/StockBadge';
import { PriceDelta } from '../components/PriceDelta';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatDuration, formatPrice, formatRelativeTime, formatTimestamp } from '../utils/format';

type PageState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; product: ProductDto; history: HistoryPointDto[]; logs: LogEntryDto[] };

const LOG_STATUS_COLOR: Record<string, string> = {
  SUCCESS: 'text-healthy',
  RETRY: 'text-retrying',
  FAILED: 'text-failed',
  VALIDATION_FAILED: 'text-failed',
  TIMEOUT: 'text-retrying',
  STRUCTURE_CHANGED: 'text-failed',
};

export function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [scraping, setScraping] = useState(false);
  const [scrapeNote, setScrapeNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setState({ kind: 'loading' });
    try {
      const [product, history, logs] = await Promise.all([
        api.getProduct(id),
        api.getHistory(id),
        api.getLogs(id),
      ]);
      setState({ kind: 'ready', product, history: history.points, logs: logs.entries });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not load this product.';
      setState({ kind: 'error', message });
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleScrapeNow() {
    if (!id || scraping) return;
    setScraping(true);
    setScrapeNote(null);
    try {
      const outcome = await api.scrapeNow(id);
      setScrapeNote(
        outcome.outcome === 'SUCCESS'
          ? `Scrape succeeded: ${formatPrice(outcome.price, outcome.currency)}, ${outcome.stockStatus.replace('_', ' ').toLowerCase()}.`
          : `Scrape failed after ${outcome.attempts} attempt(s): ${outcome.message}`,
      );
      await load();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'The scrape request failed.';
      setScrapeNote(message);
    } finally {
      setScraping(false);
    }
  }

  async function handleUntrack() {
    if (!id) return;
    if (!window.confirm('Stop tracking this product? Its price history will be deleted.')) return;
    try {
      await api.untrackProduct(id);
      navigate('/');
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not untrack this product.';
      setScrapeNote(message);
    }
  }

  if (state.kind === 'loading') return <LoadingState label="Loading product" />;
  if (state.kind === 'error') return <ErrorState message={state.message} onRetry={load} />;

  const { product, history, logs } = state;

  return (
    <div>
      <Link to="/" className="mb-4 inline-block text-sm text-muted hover:text-ink">
        ← Dashboard
      </Link>

      <div className="mb-6 flex items-start justify-between gap-6 border-b border-line pb-6">
        <div className="flex items-start gap-4">
          {product.imageUrl ? (
            <img src={product.imageUrl} alt="" className="h-16 w-16 rounded object-cover" />
          ) : (
            <div className="h-16 w-16 rounded bg-line/60" aria-hidden="true" />
          )}
          <div>
            <h1 className="text-xl font-semibold text-ink">{product.name}</h1>
            <div className="mt-2 flex items-center gap-3 font-mono text-2xl text-ink">
              {formatPrice(product.currentPrice, product.currency)}
              <span className="font-sans text-sm">
                <PriceDelta change={product.priceChange} percent={product.priceChangePercent} currency={product.currency} />
              </span>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <StockBadge status={product.currentStock} />
              <HealthBadge status={product.healthStatus} />
            </div>
            <p className="mt-2 text-sm text-muted">Last scraped {formatRelativeTime(product.lastScrapedAt)}</p>
            <a href={product.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-healthy underline">
              View on storefront
            </a>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            onClick={handleScrapeNow}
            disabled={scraping}
            className="rounded bg-ink px-3 py-1.5 text-sm font-medium text-paper hover:bg-slate disabled:cursor-not-allowed disabled:opacity-60"
          >
            {scraping ? 'Scraping…' : 'Scrape now'}
          </button>
          <button onClick={handleUntrack} className="text-sm text-muted hover:text-failed">
            Untrack product
          </button>
        </div>
      </div>

      {scrapeNote && <p className="mb-6 rounded border border-line bg-line/10 px-3 py-2 text-sm text-slate">{scrapeNote}</p>}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Price history</h2>
        {history.length < 2 ? (
          <EmptyState
            title="Not enough data for a chart yet"
            description="Once there are at least two successful scrapes, a price trend line appears here."
          />
        ) : (
          <div className="h-64 rounded border border-line p-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={[...history].reverse()}>
                <CartesianGrid stroke="#DBD8D1" strokeDasharray="3 3" />
                <XAxis
                  dataKey="scrapedAt"
                  tickFormatter={(value: string) => formatTimestamp(value)}
                  tick={{ fontSize: 11, fill: '#6B7280' }}
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#6B7280' }}
                  tickFormatter={(value: number) => formatPrice(value, product.currency)}
                  width={80}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  formatter={(value: number) => formatPrice(value, product.currency)}
                  labelFormatter={(value: string) => formatTimestamp(value)}
                />
                <Line type="monotone" dataKey="price" stroke="#146C63" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">History</h2>
        {history.length === 0 ? (
          <EmptyState title="No history yet" description="This product hasn't had a successful scrape." />
        ) : (
          <div className="overflow-hidden rounded border border-line">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-line/20 text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2 font-medium">Timestamp</th>
                  <th className="px-4 py-2 font-medium">Price</th>
                  <th className="px-4 py-2 font-medium">Stock</th>
                </tr>
              </thead>
              <tbody>
                {history.map((point) => (
                  <tr key={point.scrapedAt} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-2 font-mono text-muted">{formatTimestamp(point.scrapedAt)}</td>
                    <td className="px-4 py-2 font-mono text-ink">{formatPrice(point.price, point.currency)}</td>
                    <td className="px-4 py-2">
                      <StockBadge status={point.stockStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Scrape log</h2>
        {logs.length === 0 ? (
          <EmptyState title="No scrape attempts yet" />
        ) : (
          <div className="overflow-hidden rounded border border-line">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-line/20 text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2 font-medium">Timestamp</th>
                  <th className="px-4 py-2 font-medium">Attempt</th>
                  <th className="px-4 py-2 font-medium">Outcome</th>
                  <th className="px-4 py-2 font-medium">Duration</th>
                  <th className="px-4 py-2 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, index) => (
                  <tr key={`${log.createdAt}-${index}`} className="border-b border-line last:border-b-0 align-top">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-muted">{formatTimestamp(log.createdAt)}</td>
                    <td className="px-4 py-2 font-mono text-muted">{log.attempt}</td>
                    <td className={`px-4 py-2 font-mono font-medium ${LOG_STATUS_COLOR[log.status] ?? 'text-slate'}`}>
                      {log.status}
                    </td>
                    <td className="px-4 py-2 font-mono text-muted">{formatDuration(log.durationMs)}</td>
                    <td className="px-4 py-2 text-slate">{log.errorMessage ?? log.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
