import type { StockStatus } from '../api/types';

export function StockBadge({ status }: { status: StockStatus | null }) {
  if (status === 'IN_STOCK') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-healthy">
        <span className="h-1.5 w-1.5 rounded-full bg-healthy" aria-hidden="true" />
        In stock
      </span>
    );
  }
  if (status === 'OUT_OF_STOCK') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-failed">
        <span className="h-1.5 w-1.5 rounded-full bg-failed" aria-hidden="true" />
        Out of stock
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-pending" aria-hidden="true" />
      Unknown
    </span>
  );
}
