/**
 * Layout rotation and catalogue search. Both talk to the storefront's JSON API, so `fetch` is
 * injected rather than mocked globally — these tests never touch the network.
 */
import { describe, expect, it, vi } from 'vitest';
import { LayoutCache, parseLayout } from '../src/scraper/layout';
import { buildLayoutSelectors, classSelector } from '../src/scraper/selectors';
import { CatalogClient, normalizeForSearch, scoreItem } from '../src/scraper/catalog';
import type { CatalogItem } from '../src/scraper/catalog';

/** The document the probe captured, byte for byte. */
const LAYOUT_BODY = {
  revision: 627000,
  variant: 4,
  validUntil: 1789882933952,
  classes: { priceWrap: 'pw-z6', priceValue: 'pv-z6', mrp: 'mr-z6', sale: 'sl-z6', badge: 'bd-z6', rating: 'rt-z6', seller: 'sr-z6', delivery: 'dl-z6', stock: 'st-z6' },
  order: ['rating', 'seller', 'delivery', 'stock'],
  priceTag: 'span',
  priceCarrier: 'text',
  ratingAria: true,
  sellerTitle: false,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('parseLayout', () => {
  it('accepts the document the storefront actually serves', () => {
    const layout = parseLayout(LAYOUT_BODY);
    expect(layout.classes.priceValue).toBe('pv-z6');
    expect(layout.priceTag).toBe('span');
  });

  it('treats a missing class key as a contract change, not a transient blip', () => {
    const { priceValue: _dropped, ...rest } = LAYOUT_BODY.classes;
    expect(() => parseLayout({ ...LAYOUT_BODY, classes: rest })).toThrowError(/missing class keys/);
  });

  it('rejects a response that is not a layout document at all', () => {
    expect(() => parseLayout('<!doctype html>')).toThrowError(/did not return an object/);
    expect(() => parseLayout({ revision: 1 })).toThrowError(/no "classes" map/);
  });
});

describe('buildLayoutSelectors', () => {
  it('builds price selectors from the live layout rather than a constant', () => {
    const selectors = buildLayoutSelectors(parseLayout(LAYOUT_BODY));
    expect(selectors.priceValue).toBe('.price-block.pw-z6 .price-main span.pv-z6');
    expect(selectors.stock).toBe('.price-block.pw-z6 .st-z6');
  });

  it('follows a rotation without any code change', () => {
    const rotated = parseLayout({ ...LAYOUT_BODY, revision: 627001, classes: { ...LAYOUT_BODY.classes, priceWrap: 'pw-a1', priceValue: 'pv-a1' } });
    expect(buildLayoutSelectors(rotated).priceValue).toBe('.price-block.pw-a1 .price-main span.pv-a1');
  });

  it('refuses to splice a hostile class name into a selector', () => {
    expect(() => classSelector('pv-z6, script')).toThrowError(/Refusing/);
    expect(() => classSelector('')).toThrowError(/Refusing/);
  });
});

describe('LayoutCache', () => {
  it('fetches once and reuses the document for the rest of the run', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(LAYOUT_BODY));
    const cache = new LayoutCache({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_700_000_000_000 });
    await cache.get();
    await cache.get();
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the document is close to expiring', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...LAYOUT_BODY, validUntil: 1_000 }));
    const cache = new LayoutCache({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0, safetyMarginMs: 60_000 });
    await cache.get();
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('can be invalidated when extraction suggests the classes went stale', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(LAYOUT_BODY));
    const cache = new LayoutCache({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_700_000_000_000 });
    await cache.get();
    cache.invalidate();
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('catalogue search (client-side, because the server ignores q= and search=)', () => {
  const items: CatalogItem[] = [
    { id: 1, slug: 'helix-phone-x', name: 'Helix Phone X', brand: 'Helix', category: 'Phones', sku: 'HEL-10001', description: 'A phone.' },
    { id: 2, slug: 'summit-soundbar-s', name: 'Summit Soundbar S', brand: 'Summit', category: 'Audio', sku: 'SUM-10644', description: 'A soundbar.' },
    { id: 3, slug: 'basecamp-phone-case', name: 'Basecamp Phone Case', brand: 'Basecamp', category: 'Accessories', sku: 'BAS-10003', description: 'Fits most phones.' },
  ];

  const clientOver = (pages: CatalogItem[][]): CatalogClient => {
    const fetchImpl = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return jsonResponse({ items: pages[page - 1] ?? [], total: pages.flat().length, pages: pages.length });
    });
    return new CatalogClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  };

  it('matches partial names, case-insensitively', async () => {
    const hits = await clientOver([items]).search('phone');
    expect(hits.map((h) => h.id)).toEqual([1, 3]);
  });

  it('ranks a name-initial match above a description-only match', async () => {
    const hits = await clientOver([items]).search('phone');
    expect(hits[0]?.name).toBe('Helix Phone X');
  });

  it('requires every term to match — "summit phone" matches neither', async () => {
    expect(await clientOver([items]).search('summit phone')).toEqual([]);
  });

  it('matches on brand and SKU too', async () => {
    expect((await clientOver([items]).search('SUM-10644')).map((h) => h.id)).toEqual([2]);
    expect((await clientOver([items]).search('basecamp')).map((h) => h.id)).toEqual([3]);
  });

  it('returns a canonical product URL for every hit', async () => {
    const hits = await clientOver([items]).search('helix');
    expect(hits[0]?.url).toBe('https://demo.inelabteamdev.com/product/1');
  });

  it('walks every page and de-duplicates ids across them', async () => {
    const hits = await clientOver([[items[0] as CatalogItem], [items[0] as CatalogItem, items[2] as CatalogItem]]).search('phone');
    expect(hits.map((h) => h.id)).toEqual([1, 3]);
  });

  it('returns nothing for an empty query instead of the whole catalogue', async () => {
    expect(await clientOver([items]).search('   ')).toEqual([]);
  });
});

describe('search scoring helpers', () => {
  it('normalises punctuation and case', () => {
    expect(normalizeForSearch('  Helix  Ultrawide-X! ')).toBe('helix ultrawide x');
  });

  it('returns null when a term matches nothing', () => {
    const item: CatalogItem = { id: 1, slug: 's', name: 'Helix Phone X', brand: 'Helix', category: 'Phones', sku: 'H-1', description: '' };
    expect(scoreItem(item, ['helix'])).not.toBeNull();
    expect(scoreItem(item, ['helix', 'tractor'])).toBeNull();
  });
});
