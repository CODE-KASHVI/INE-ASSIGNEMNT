import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { ProductDto } from '../api/types';
import { HealthBadge } from '../components/HealthBadge';
import { StockBadge } from '../components/StockBadge';
import { PriceDelta } from '../components/PriceDelta';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatPrice, formatRelativeTime } from '../utils/format';

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; products: ProductDto[] };

export function Dashboard() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const { products } = await api.listProducts();
      setState({ kind: 'ready', products });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not load tracked products.';
      setState({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">Tracked products</h1>
          <p className="mt-1 text-sm text-muted">Scraped roughly every 2 hours. Failures never overwrite the last known-good price.</p>
        </div>
        <Link to="/add" className="rounded bg-ink px-3 py-1.5 text-sm font-medium text-paper hover:bg-slate">
          Add product
        </Link>
      </div>

      {state.kind === 'loading' && <LoadingState label="Loading tracked products" />}
      {state.kind === 'error' && <ErrorState message={state.message} onRetry={load} />}
      {state.kind === 'ready' && state.products.length === 0 && (
        <EmptyState
          title="Nothing tracked yet"
          description="Search the storefront and track a product to start collecting price history."
        />
      )}
      {state.kind === 'ready' && state.products.length > 0 && (
        <div className="overflow-hidden rounded border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-line/20 text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-medium">Product</th>
                <th className="px-4 py-2 font-medium">Price</th>
                <th className="px-4 py-2 font-medium">Change</th>
                <th className="px-4 py-2 font-medium">Stock</th>
                <th className="px-4 py-2 font-medium">Health</th>
                <th className="px-4 py-2 font-medium">Last scraped</th>
              </tr>
            </thead>
            <tbody>
              {state.products.map((product) => (
                <tr key={product.id} className="border-b border-line last:border-b-0 hover:bg-line/10">
                  <td className="px-4 py-3">
                    <Link to={`/products/${product.id}`} className="flex items-center gap-3">
                      {product.imageUrl ? (
                        <img src={product.imageUrl} alt="" className="h-9 w-9 rounded object-cover" />
                      ) : (
                        <div className="h-9 w-9 rounded bg-line/60" aria-hidden="true" />
                      )}
                      <span className="font-medium text-ink hover:underline">{product.name}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-ink">{formatPrice(product.currentPrice, product.currency)}</td>
                  <td className="px-4 py-3">
                    <PriceDelta change={product.priceChange} percent={product.priceChangePercent} currency={product.currency} />
                  </td>
                  <td className="px-4 py-3">
                    <StockBadge status={product.currentStock} />
                  </td>
                  <td className="px-4 py-3">
                    <HealthBadge status={product.healthStatus} />
                  </td>
                  <td className="px-4 py-3 font-mono text-muted">{formatRelativeTime(product.lastScrapedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
