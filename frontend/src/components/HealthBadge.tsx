import type { HealthStatus } from '../api/types';

const CONFIG: Record<HealthStatus, { label: string; dot: string; text: string; bg: string; pulse?: boolean }> = {
  HEALTHY: { label: 'Healthy', dot: 'bg-healthy', text: 'text-healthy', bg: 'bg-healthy-soft' },
  RETRYING: { label: 'Retrying', dot: 'bg-retrying', text: 'text-retrying', bg: 'bg-retrying-soft', pulse: true },
  FAILED: { label: 'Failed', dot: 'bg-failed', text: 'text-failed', bg: 'bg-failed-soft' },
  STRUCTURE_CHANGED: { label: 'Page structure changed', dot: 'bg-failed', text: 'text-failed', bg: 'bg-failed-soft' },
  PENDING: { label: 'Pending first scrape', dot: 'bg-pending', text: 'text-slate', bg: 'bg-pending-soft' },
};

export function HealthBadge({ status }: { status: HealthStatus }) {
  const config = CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-sm font-medium ${config.bg} ${config.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot} ${config.pulse ? 'animate-pulse-dot' : ''}`} aria-hidden="true" />
      {config.label}
    </span>
  );
}
