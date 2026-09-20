export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-12 text-sm text-muted" role="status">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-slate" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded border border-dashed border-line py-14 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded border border-failed/30 bg-failed-soft px-4 py-4">
      <p className="text-sm font-medium text-failed">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 rounded border border-failed/40 px-3 py-1 text-sm font-medium text-failed hover:bg-failed/10"
        >
          Try again
        </button>
      )}
    </div>
  );
}
