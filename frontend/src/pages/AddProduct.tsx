import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { SearchHitDto } from '../api/types';
import { useDebounce } from '../hooks/useDebounce';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; results: SearchHitDto[] };

export function AddProduct() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim(), 350);
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const [trackingId, setTrackingId] = useState<number | null>(null);

  useEffect(() => {
    if (debouncedQuery.length === 0) {
      setState({ kind: 'idle' });
      return;
    }

    let cancelled = false;
    setState({ kind: 'loading' });

    api
      .search(debouncedQuery)
      .then(({ results }) => {
        if (!cancelled) setState({ kind: 'ready', results });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof ApiError ? error.message : 'Search failed.';
        setState({ kind: 'error', message });
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  async function handleTrack(hit: SearchHitDto) {
    setTrackingId(hit.storeProductId);
    try {
      const tracked = await api.trackProduct({ storeProductId: hit.storeProductId });
      navigate(`/products/${tracked.id}`);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not track that product.';
      setState({ kind: 'error', message });
    } finally {
      setTrackingId(null);
    }
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-ink">Add a product</h1>
      <p className="mb-6 text-sm text-muted">Search the storefront by name. Only products on demo.inelabteamdev.com can be tracked.</p>

      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search products…"
        autoFocus
        className="mb-6 w-full max-w-md rounded border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-slate"
      />

      {state.kind === 'idle' && query.trim().length === 0 && (
        <EmptyState title="Search for something" description="Try a category or product name, like “phone” or “wireless”." />
      )}
      {state.kind === 'loading' && <LoadingState label="Searching" />}
      {state.kind === 'error' && <ErrorState message={state.message} />}
      {state.kind === 'ready' && state.results.length === 0 && (
        <EmptyState title="No products found" description={`Nothing matched “${debouncedQuery}”. Try a different search term.`} />
      )}
      {state.kind === 'ready' && state.results.length > 0 && (
        <ul className="divide-y divide-line rounded border border-line">
          {state.results.map((hit) => (
            <li key={hit.storeProductId} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-ink">{hit.name}</p>
                <p className="text-sm text-muted">
                  {hit.brand} · {hit.category}
                </p>
              </div>
              <button
                onClick={() => handleTrack(hit)}
                disabled={hit.alreadyTracked || trackingId === hit.storeProductId}
                className="shrink-0 rounded border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-line/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {hit.alreadyTracked ? 'Already tracked' : trackingId === hit.storeProductId ? 'Tracking…' : 'Track product'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
