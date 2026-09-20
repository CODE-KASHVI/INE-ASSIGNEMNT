import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive ? 'bg-ink text-paper' : 'text-slate hover:bg-line/50'
  }`;

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line px-4 py-6">
        <div className="mb-8 px-1">
          <p className="font-mono text-xs uppercase tracking-wide text-muted">INE</p>
          <p className="text-lg font-semibold leading-tight text-ink">Price Tracker</p>
        </div>
        <nav className="flex flex-col gap-1">
          <NavLink to="/" end className={navLinkClass}>
            Dashboard
          </NavLink>
          <NavLink to="/add" className={navLinkClass}>
            Add product
          </NavLink>
        </nav>
        <div className="mt-auto px-1 pt-6 text-xs text-muted">
          Scraped from{' '}
          <a href="https://demo.inelabteamdev.com/" target="_blank" rel="noreferrer" className="underline hover:text-ink">
            demo.inelabteamdev.com
          </a>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
