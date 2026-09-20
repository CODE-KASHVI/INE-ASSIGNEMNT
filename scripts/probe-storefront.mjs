#!/usr/bin/env node
/**
 * PHASE 1 — Storefront probe.
 *
 * Purpose: gather EVIDENCE about https://demo.inelabteamdev.com/ so the scraping
 * architecture (HTTP+Cheerio vs Playwright vs hybrid) and the selectors are chosen
 * from observation, not assumption.
 *
 * It only ever talks to demo.inelabteamdev.com, makes a few dozen requests in total,
 * and writes everything to ./probe-output/ (raw HTML, rendered HTML, network log, report).
 *
 * Usage (Node >= 18):
 *   npm i -D playwright && npx playwright install chromium     # once, optional but recommended
 *   node scripts/probe-storefront.mjs                          # full probe
 *   node scripts/probe-storefront.mjs --search=wireless        # different search term
 *   node scripts/probe-storefront.mjs --product-url=https://demo.inelabteamdev.com/...   # force a product page
 *   node scripts/probe-storefront.mjs --no-browser             # HTTP-only (still useful)
 *
 * Then send back probe-output/report.md + report.json (and the *.html fixtures if small).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TARGET = 'https://demo.inelabteamdev.com/';
export const HOST = 'demo.inelabteamdev.com';
const USER_AGENT = 'INE-Assignment-Probe/1.0 (read-only investigation)';

// Deliberately generic: matches "₹1,299", "$19.99", "Rs. 500", "INR 1299" ...
const PRICE_RE_SRC = String.raw`(?:₹|\$|€|£|\brs\.?|\binr\b|\busd\b)\s?\d[\d,]*(?:\.\d{1,2})?`;
const STOCK_RE_SRC = String.raw`in stock|out of stock|sold out|only \d+ left|\bavailable\b|unavailable|loading`;

// ───────────────────────────── helpers ─────────────────────────────

function parseArgs(argv) {
  const out = { search: 'phone', productUrl: null, noBrowser: false, outDir: 'probe-output', help: false, full: false, runs: 4 };
  for (const a of argv) {
    if (a === '--no-browser') out.noBrowser = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--full') out.full = true;
    else if (a.startsWith('--runs=')) out.runs = Math.max(1, Number(a.slice('--runs='.length)) || 4);
    else if (a.startsWith('--search=')) out.search = a.slice('--search='.length);
    else if (a.startsWith('--product-url=')) out.productUrl = a.slice('--product-url='.length);
    else if (a.startsWith('--out=')) out.outDir = a.slice('--out='.length);
  }
  return out;
}

function assertHost(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== HOST) {
    throw new Error(`Refusing to probe non-storefront URL: ${url}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADER_KEYS = ['server', 'content-type', 'cache-control', 'x-powered-by', 'cf-ray', 'via', 'etag', 'last-modified', 'retry-after'];

export async function httpGet(url, { timeoutMs = 20000 } = {}) {
  assertHost(url);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const finalHost = new URL(res.url).hostname;
    const headers = {};
    for (const k of HEADER_KEYS) if (res.headers.get(k)) headers[k] = res.headers.get(k);
    if (finalHost !== HOST) {
      return { ok: false, url, ms: Date.now() - started, status: res.status, error: `redirected off-host to ${res.url}`, body: '', headers };
    }
    const body = await res.text();
    return { ok: true, url, finalUrl: res.url, status: res.status, ms: Date.now() - started, headers, bytes: body.length, body };
  } catch (error) {
    return { ok: false, url, ms: Date.now() - started, error: `${error.name}: ${error.message}`, body: '' };
  }
}

const withoutBody = ({ body, ...rest }) => rest;

/** Static (no-JS) analysis of an HTML string. Pure function → unit-testable offline. */
export function analyzeHtml(html) {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const text = stripped.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

  const attrHints = new Set();
  for (const m of html.matchAll(/\b(class|id|data-[\w-]+|itemprop|name|aria-label)=["']([^"']{1,120})["']/gi)) {
    const [, attr, value] = m;
    if (/price|stock|avail|sku|cost|amount/i.test(value) || /price|stock|avail/i.test(attr)) {
      attrHints.add(`${attr}="${value}"`);
    }
    if (attrHints.size >= 60) break;
  }

  const priceMatches = text.match(new RegExp(PRICE_RE_SRC, 'gi')) ?? [];
  const stockMatches = text.match(new RegExp(STOCK_RE_SRC, 'gi')) ?? [];
  const hrefs = [...html.matchAll(/<a\b[^>]*?href=["']([^"'#][^"']*)["']/gi)].map((m) => m[1]);

  return {
    htmlBytes: html.length,
    title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim().slice(0, 200),
    visibleTextLength: text.length,
    visibleTextSample: text.slice(0, 400),
    emptyAppRoot: /<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html),
    frameworkMarkers: ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__APOLLO_STATE__', 'window.__', 'application/json'].filter((m) => html.includes(m)),
    jsonLdBlocks: (html.match(/application\/ld\+json/gi) ?? []).length,
    scriptSrcs: [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 25),
    metaTags: [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).filter((m) => /og:|product:|price|description/i.test(m)).slice(0, 15),
    forms: [...html.matchAll(/<form\b[^>]*>/gi)].map((m) => m[0].slice(0, 200)).slice(0, 10),
    inputs: [...html.matchAll(/<(?:input|textarea|select)\b[^>]*>/gi)].map((m) => m[0].slice(0, 200)).slice(0, 20),
    priceLikeMatches: priceMatches.slice(0, 15),
    priceLikeCount: priceMatches.length,
    stockLikeMatches: stockMatches.slice(0, 15),
    selectorHintAttributes: [...attrHints],
    hrefCount: hrefs.length,
    linkPatterns: groupLinkPatterns(hrefs),
  };
}

/** Groups same-host links by path shape (digits → :n) to reveal product URL structure. */
export function groupLinkPatterns(hrefs, base = TARGET) {
  const groups = new Map();
  for (const href of hrefs) {
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.hostname !== HOST) continue;
    const key = u.pathname.replace(/\d+/g, ':n') + (u.search ? `?${[...u.searchParams.keys()].sort().join('&')}` : '');
    if (key === '/') continue;
    const g = groups.get(key) ?? { pattern: key, count: 0, examples: [] };
    g.count += 1;
    if (g.examples.length < 3 && !g.examples.includes(u.href)) g.examples.push(u.href);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 15);
}

/** Picks the most plausible product-detail link from grouped link patterns. */
export function pickProductLink(groups) {
  const productish = groups.find((g) => g.count >= 2 && /product|item|detail|\/p\/|sku|[?&]id/i.test(g.pattern));
  const biggest = groups.find((g) => g.count >= 3);
  return (productish ?? biggest)?.examples[0] ?? null;
}

function detectDifferences(samples) {
  const seen = new Set(samples.map((s) => JSON.stringify(s)));
  return seen.size > 1;
}

async function save(dir, name, content) {
  const file = path.join(dir, name);
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}

/**
 * A Vite/React SPA ships its API paths (or even its data) inside the JS bundle.
 * Pure function over the bundle text → cheap to test offline.
 */
export function extractBundleEvidence(js) {
  const uniq = (arr, n) => [...new Set(arr)].slice(0, n);
  const quoted = (re) => uniq([...js.matchAll(re)].map((m) => m[1]), 40);
  const around = (needle, n = 6, width = 140) => {
    const out = [];
    let i = js.indexOf(needle);
    while (i !== -1 && out.length < n) {
      out.push(js.slice(Math.max(0, i - width), i + width).replace(/\s+/g, ' '));
      i = js.indexOf(needle, i + needle.length);
    }
    return out;
  };
  const count = (re) => (js.match(re) ?? []).length;
  return {
    apiPaths: quoted(/["'`](\/(?:api|graphql|v\d)[^"'`\s\\]{0,120})["'`]/gi),
    jsonPaths: quoted(/["'`](\/[\w\-\/]*\.json)["'`]/gi),
    absoluteUrls: quoted(/(https?:\/\/[^"'`\s\\)]{4,150})/gi).filter((u) => !/w3\.org|reactjs\.org|react\.dev|mozilla\.org|github\.com|reactrouter/i.test(u)),
    routeStrings: quoted(/["'`](\/(?:p|product|products|item|items|catalog|search|sku)[\w\-\/:]{0,60})["'`]/gi),
    viteEnv: quoted(/(VITE_[A-Z0-9_]+)/g),
    counts: {
      fetchCalls: count(/\bfetch\(/g),
      axios: count(/axios/gi),
      xmlHttpRequest: count(/XMLHttpRequest/g),
      sku: count(/\bsku\b/gi),
      price: count(/\bprice\b/gi),
      stock: count(/\bstock\b/gi),
      mathRandom: count(/Math\.random/g),
      setInterval: count(/setInterval\(/g),
      localStorage: count(/localStorage/g),
    },
    fetchSnippets: around('fetch(', 6),
    skuSnippets: around('sku', 4, 200),
    priceSnippets: around('price', 4, 200),
    stockSnippets: around('stock', 3, 200),
    randomSnippets: around('Math.random', 3, 160),
  };
}

async function scanBundles(html, outDir) {
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 3);
  const results = [];
  for (const [i, src] of srcs.entries()) {
    const url = new URL(src, TARGET).href;
    const res = await httpGet(url, { timeoutMs: 30000 });
    if (!res.ok) {
      results.push({ url, error: res.error ?? `status ${res.status}` });
      continue;
    }
    await save(outDir, `bundle-${i}.js`, res.body);
    results.push({ url, bytes: res.body.length, ...extractBundleEvidence(res.body) });
  }
  return results;
}

// ───────────────────────────── browser probing ─────────────────────────────

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

function attachNetworkRecorder(page, sink, pending) {
  const t0 = Date.now();
  page.on('request', (req) => {
    sink.requests.push({
      tMs: Date.now() - t0,
      method: req.method(),
      type: req.resourceType(),
      url: req.url(),
      ...(req.method() !== 'GET' && req.postData() ? { postData: req.postData().slice(0, 500) } : {}),
    });
  });
  page.on('response', (res) => {
    const type = res.request().resourceType();
    const entry = { tMs: Date.now() - t0, status: res.status(), type, url: res.url(), contentType: res.headers()['content-type'] ?? '' };
    if (type === 'xhr' || type === 'fetch') entry.requestHeaderNames = Object.keys(res.request().headers()); // names only: never log tokens
    sink.responses.push(entry);
    if ((type === 'xhr' || type === 'fetch') && /json|text/i.test(entry.contentType)) {
      pending.push(
        res
          .text()
          .then((t) => {
            entry.bodyLength = t.length;
            entry.bodyPreview = t.slice(0, 1500);
          })
          .catch(() => {}),
      );
    } else if (type === 'xhr' || type === 'fetch') {
      pending.push(
        res
          .body()
          .then((b) => {
            entry.bodyLength = b.length;
            entry.bodyHexPrefix = b.subarray(0, 16).toString('hex');
          })
          .catch(() => {}),
      );
    }
  });
  page.on('requestfailed', (req) => sink.failed.push({ url: req.url(), error: req.failure()?.errorText ?? 'unknown' }));
  page.on('pageerror', (err) => sink.pageErrors.push(String(err).slice(0, 300)));
}

const newSink = () => ({ requests: [], responses: [], failed: [], pageErrors: [] });

/** Polls the DOM and records WHEN price-like / stock-like text appears (loading behaviour). */
async function samplePage(page, { totalMs = 15000, intervalMs = 250, stableMs = 5000 } = {}) {
  const started = Date.now();
  const samples = [];
  let last = '';
  let lastChange = Date.now();
  while (Date.now() - started < totalMs) {
    const snap = await page
      .evaluate(
        ([priceSrc, stockSrc]) => {
          const text = document.body ? document.body.innerText : '';
          return {
            textLen: text.length,
            prices: (text.match(new RegExp(priceSrc, 'gi')) ?? []).slice(0, 8),
            stock: (text.match(new RegExp(stockSrc, 'gi')) ?? []).slice(0, 8),
          };
        },
        [PRICE_RE_SRC, STOCK_RE_SRC],
      )
      .catch((e) => ({ error: String(e).slice(0, 120) }));
    const key = JSON.stringify(snap);
    if (key !== last) {
      samples.push({ tMs: Date.now() - started, ...snap });
      last = key;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > stableMs && samples.some((x) => (x.textLen ?? 0) > 50)) {
      break; // stable AND content has actually rendered (an empty shell is not "stable", it is "not loaded yet")
    }
    await sleep(intervalMs);
  }
  return samples;
}

/** Elements whose attributes mention price/stock — direct selector candidates. */
async function collectCandidates(page) {
  return page
    .evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        if (out.length >= 40) break;
        const attrs = [...el.attributes].map((a) => `${a.name}="${a.value}"`).join(' ');
        if (!/price|stock|avail|sku|cost/i.test(attrs)) continue;
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 80) continue;
        out.push({ tag: el.tagName.toLowerCase(), attrs: attrs.slice(0, 200), text });
      }
      return out;
    })
    .catch(() => []);
}

async function collectLinks(page) {
  return page
    .$$eval('a[href]', (as) => as.slice(0, 300).map((a) => ({ href: a.href, text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) })))
    .catch(() => []);
}

async function browserVisit(context, url, { label, pollMs = 15000, outDir }) {
  assertHost(url);
  const page = await context.newPage();
  const sink = newSink();
  const pending = [];
  attachNetworkRecorder(page, sink, pending);

  const timing = {};
  const t0 = Date.now();
  page.on('domcontentloaded', () => (timing.domContentLoadedMs = Date.now() - t0));
  page.on('load', () => (timing.loadMs = Date.now() - t0));

  let navigationError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    navigationError = `${e.name}: ${e.message}`;
  }
  timing.gotoResolvedMs = Date.now() - t0;

  // Does the site ever reach "networkidle"? (Decides whether we may rely on it — we probably shouldn't.)
  const idleStart = Date.now();
  const idleProbe = page
    .waitForLoadState('networkidle', { timeout: 20000 })
    .then(() => ({ reached: true, afterMs: Date.now() - idleStart }))
    .catch(() => ({ reached: false, afterMs: Date.now() - idleStart }));

  const timeline = await samplePage(page, { totalMs: pollMs });
  const networkIdle = await idleProbe;
  await Promise.allSettled(pending);

  const rendered = await page.content().catch(() => '');
  await save(outDir, `${label}.rendered.html`, rendered);
  const candidates = await collectCandidates(page);
  const links = await collectLinks(page);
  const firstPriceSample = timeline.find((s) => s.prices?.length);
  const firstStockSample = timeline.find((s) => s.stock?.length);
  const finalUrl = page.url();
  await page.close();

  return {
    label,
    url,
    finalUrl,
    navigationError,
    timing,
    networkIdle,
    firstPriceAtMs: firstPriceSample?.tMs ?? null,
    firstStockAtMs: firstStockSample?.tMs ?? null,
    priceAppearedAfterDomContentLoaded: firstPriceSample && timing.domContentLoadedMs != null ? firstPriceSample.tMs > 300 : null,
    timeline: timeline.slice(0, 30),
    renderedAnalysis: analyzeHtml(rendered),
    selectorCandidates: candidates,
    links: links.slice(0, 60),
    network: {
      requestCount: sink.requests.length,
      hosts: [...new Set(sink.requests.map((r) => new URL(r.url).hostname))],
      apiLike: sink.responses.filter((r) => r.type === 'xhr' || r.type === 'fetch'),
      documents: sink.responses.filter((r) => r.type === 'document'),
      failed: sink.failed.slice(0, 20),
      pageErrors: sink.pageErrors.slice(0, 10),
    },
    _links: links,
  };
}

const VIEW_DETAILS = /view details/i;

/**
 * Listing structure: how cards are marked up, whether the list grows on scroll (infinite scroll),
 * what pagination controls exist, and which URL a card click leads to (works when cards are not <a> links).
 */
async function probeListing(context) {
  const page = await context.newPage();
  const sink = newSink();
  const pending = [];
  attachNetworkRecorder(page, sink, pending);
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const cards = page.getByText(VIEW_DETAILS);
    const appeared = await cards.first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    if (!appeared) {
      return { cardsRendered: false, note: 'No "view details" text appeared within 30s (slow render, different wording, or blocked).' };
    }

    const initialCount = await cards.count();
    const first = await cards.first().evaluate((el) => {
      // climb to the card container: the highest ancestor that still holds exactly one "view details"
      let c = el;
      while (c.parentElement && (c.parentElement.textContent.match(/view details/gi) ?? []).length === 1) c = c.parentElement;
      const link = el.closest('a[href]');
      return { cardHtml: c.outerHTML.slice(0, 2500), linkHref: link ? link.href : null, tag: el.tagName.toLowerCase() };
    });
    const totalClaim = await page.evaluate(() => (document.body.innerText.match(/(\d[\d,]*)\s+products?/i) ?? [])[0] ?? null);

    // Infinite scroll? Scroll to the bottom a few times and watch the card count.
    const counts = [initialCount];
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2000);
      counts.push(await cards.count());
    }

    const controls = await page
      .$$eval('a, button', (els) =>
        els
          .filter((e) => /^(next|previous|prev|more|›|»|\d{1,4})$|load more|show more|next page|page \d/i.test((e.textContent || '').trim().slice(0, 30)))
          .slice(0, 20)
          .map((e) => ({ tag: e.tagName.toLowerCase(), text: (e.textContent || '').trim().slice(0, 30), href: e.getAttribute('href'), disabled: e.disabled === true })),
      )
      .catch(() => []);

    await page.evaluate(() => window.scrollTo(0, 0));
    const urlBefore = page.url();
    await cards.first().click({ timeout: 5000 }).catch(() => {});
    await sleep(3000);
    const urlAfterClick = page.url();
    await Promise.allSettled(pending);

    let discoveredProductUrl = null;
    if (urlAfterClick !== urlBefore) {
      try {
        assertHost(urlAfterClick);
        discoveredProductUrl = urlAfterClick;
      } catch {
        /* off-host: ignore */
      }
    }
    return {
      cardsRendered: true,
      totalClaim,
      initialCount,
      countsAfterEachScroll: counts,
      infiniteScroll: counts.at(-1) > initialCount,
      firstCard: first,
      paginationControls: controls,
      urlBefore,
      urlAfterClick,
      discoveredProductUrl,
      apiLike: sink.responses.filter((r) => r.type === 'xhr' || r.type === 'fetch'),
      failed: sink.failed.slice(0, 10),
    };
  } finally {
    await page.close();
  }
}

async function probeSearch(context, term) {
  const page = await context.newPage();
  const sink = newSink();
  const pending = [];
  attachNetworkRecorder(page, sink, pending);
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  const input = page
    .locator('input[type="search"], input[name="q"], input[name*="search" i], input[placeholder*="search" i], input[aria-label*="search" i], [role="searchbox"]')
    .first();
  if (!(await input.count())) {
    await page.close();
    return { found: false, note: 'No obvious search input on the home page. Inspect the page manually.' };
  }

  const inputHtml = await input.evaluate((el) => el.outerHTML.slice(0, 300));
  const linksBefore = (await collectLinks(page)).length;
  const urlBefore = page.url();
  const mark = sink.requests.length;

  await input.fill(term);
  await sleep(2500);
  const afterTyping = {
    newRequests: sink.requests.slice(mark).filter((r) => r.type !== 'image' && r.type !== 'font'),
    url: page.url(),
    links: (await collectLinks(page)).length,
  };

  const mark2 = sink.requests.length;
  await page.keyboard.press('Enter');
  await sleep(3500);
  await Promise.allSettled(pending);
  const urlAfter = page.url();
  const afterEnter = {
    newRequests: sink.requests.slice(mark2).filter((r) => r.type !== 'image' && r.type !== 'font'),
    url: urlAfter,
    links: (await collectLinks(page)).length,
    apiResponses: sink.responses.filter((r) => (r.type === 'xhr' || r.type === 'fetch') && r.bodyPreview),
  };

  let serverRendered = null;
  if (urlAfter !== urlBefore) {
    const raw = await httpGet(urlAfter);
    if (raw.ok) serverRendered = { url: urlAfter, status: raw.status, analysis: analyzeHtml(raw.body) };
  }
  await page.close();
  return { found: true, term, inputHtml, urlBefore, linksBefore, afterTyping, afterEnter, rawHttpOfSearchUrl: serverRendered };
}

// ───────────────────────────── JSON API probing (plain HTTP) ─────────────────────────────

async function getJson(url) {
  const r = await httpGet(url, { timeoutMs: 20000 });
  let json = null;
  try {
    json = JSON.parse(r.body);
  } catch {
    /* not JSON */
  }
  return { url, status: r.status ?? null, ok: r.ok, ms: r.ms, contentType: r.headers?.['content-type'] ?? null, json, preview: json ? null : r.body.slice(0, 300), error: r.error ?? null };
}

const catalogSummary = (r) => ({
  url: r.url,
  status: r.status,
  ms: r.ms,
  error: r.error,
  total: r.json?.total ?? null,
  pages: r.json?.pages ?? null,
  pageSize: r.json?.pageSize ?? null,
  itemCount: r.json?.items?.length ?? null,
  itemKeys: r.json?.items?.[0] ? Object.keys(r.json.items[0]) : null,
  preview: r.preview,
});

/** The bundle told us the frontend calls /api/catalog, /api/product/:id and /api/layout. Measure them. */
export async function probeApis() {
  const q = (params) => {
    const u = new URL('/api/catalog', TARGET);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.href;
  };
  const page1 = await getJson(q({ page: 1, pageSize: 20 }));
  const out = { catalogOk: Boolean(page1.json?.items?.length), catalog: { page1: catalogSummary(page1) }, sampleIds: [] };
  if (!out.catalogOk) return out;
  out.sampleIds = page1.json.items.slice(0, 7).map((it) => ({ id: it.id, sku: it.sku, name: it.name, slug: it.slug }));

  const variants = {
    pageSize100: { page: 1, pageSize: 100 },
    pageSize1000: { page: 1, pageSize: 1000 },
    lastPage: { page: page1.json.pages ?? 50, pageSize: 20 },
    queryQ: { page: 1, pageSize: 20, q: 'phone' }, // is there server-side search? (bundle only shows page/pageSize)
    querySearch: { page: 1, pageSize: 20, search: 'phone' },
  };
  for (const [key, params] of Object.entries(variants)) {
    out.catalog[key] = catalogSummary(await getJson(q(params)));
    await sleep(300);
  }

  const cap = (r) => ({ url: r.url, status: r.status, contentType: r.contentType, body: r.json ? JSON.stringify(r.json).slice(0, 4000) : r.preview });
  out.product = cap(await getJson(new URL(`/api/product/${out.sampleIds[0].id}`, TARGET).href));
  out.layout = cap(await getJson(new URL('/api/layout', TARGET).href));
  return out;
}

// ───────────────────────────── gated price probing (browser) ─────────────────────────────

/** Makes invisible / odd whitespace characters VISIBLE in the report (JSON would print them as nothing). */
const escapeInvisible = (s) =>
  typeof s === 'string'
    ? s.replace(/[\u00a0\u00ad\u034f\u061c\u180e\u2000-\u200f\u2028-\u202f\u2060-\u2064\u2066-\u2069\ufeff]/g, (ch) => `<U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`)
    : s;
const stripInvisibleNode = (s) => s.replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '');

function codepointsOf(text) {
  return [...new Set([...(text ?? '')].filter((ch) => ch.codePointAt(0) > 126 || ch.codePointAt(0) < 32).map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`))];
}

/** Node-by-node description of an element: visibility, CSS order, geometry. Reveals decoys / visual reordering. */
async function describeBlock(locator) {
  const nodes = await locator
    .evaluate((root) => {
      const out = [];
      const walk = (el, depth) => {
        if (out.length >= 120 || depth > 7) return;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
        out.push({
          depth,
          tag: el.tagName.toLowerCase(),
          cls: el.getAttribute('class'),
          own: own.slice(0, 60),
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          order: cs.order,
          position: cs.position,
          fontSize: cs.fontSize,
          color: cs.color,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          ariaHidden: el.getAttribute('aria-hidden'),
          data: [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`).join(' ').slice(0, 80),
        });
        for (const c of el.children) walk(c, depth + 1);
      };
      walk(root, 0);
      return out;
    })
    .catch(() => null);
  return nodes?.map((n) => ({ ...n, own: escapeInvisible(n.own) })) ?? null;
}

async function snapshotPage(page) {
  return page
    .evaluate((priceSrc) => {
      const block = document.querySelector('.price-block');
      const inner = block ? block.innerText : null;
      const lines = document.body.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
      return {
        blockFound: Boolean(block),
        blockClass: block ? block.getAttribute('class') : null,
        innerText: inner,
        textContent: block ? block.textContent : null,
        priceLike: inner ? new RegExp(priceSrc, 'i').test(inner.replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')) : false,
        stockLines: lines.filter((l) => /stock|left|available|sold out|unavailable|hurry|selling/i.test(l)).slice(0, 6),
        statusLines: lines.filter((l) => /hover|hold on|checking|loading|hidden|try again|error|wrong|expired|retry/i.test(l)).slice(0, 6),
      };
    }, PRICE_RE_SRC)
    .catch((e) => ({ error: String(e).slice(0, 120), priceLike: false }));
}

/** Human-like pointer movement over an element: approach from outside, wander inside, dwell. */
async function humanHover(page, target, { dwellMs = 2500 } = {}) {
  await target.scrollIntoViewIfNeeded().catch(() => {});
  const box = await target.boundingBox();
  if (!box) return { hovered: false, reason: 'no bounding box' };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const startedAt = Date.now();
  let moves = 0;
  const move = async (x, y, steps) => {
    await page.mouse.move(x, y, { steps });
    moves += steps;
  };
  await page.mouse.move(Math.max(1, box.x - rnd(60, 160)), Math.max(1, box.y - rnd(30, 90)));
  for (let i = 0; i < 6; i += 1) {
    await move(box.x + rnd(0.1, 0.9) * box.width, box.y + rnd(0.1, 0.9) * box.height, Math.round(rnd(6, 14)));
    await sleep(rnd(40, 140));
  }
  const until = Date.now() + dwellMs;
  while (Date.now() < until) {
    await move(box.x + rnd(0.2, 0.8) * box.width, box.y + rnd(0.2, 0.8) * box.height, 3);
    await sleep(rnd(80, 200));
  }
  return { hovered: true, box: { w: Math.round(box.width), h: Math.round(box.height) }, moveEvents: moves, totalMs: Date.now() - startedAt };
}

async function probeProductGate(browser, url, { label, hover, outDir, budgetMs = 30000, withTree = false, shots = false }) {
  assertHost(url);
  const context = await browser.newContext({ userAgent: USER_AGENT }); // fresh session per run: is the token per-session?
  const page = await context.newPage();
  const sink = newSink();
  const pending = [];
  const consoleMsgs = [];
  attachNetworkRecorder(page, sink, pending);
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()) && consoleMsgs.length < 10) consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 200)}`);
  });

  const t0 = Date.now();
  let navigationError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    navigationError = `${e.name}: ${e.message}`;
  }
  const block = page.locator('.price-block').first();
  const blockAppeared = await block.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const timeToBlockMs = blockAppeared ? Date.now() - t0 : null;

  const timeline = [];
  let last = '';
  const record = async () => {
    const s = await snapshotPage(page);
    const key = JSON.stringify([s.blockClass, s.innerText, s.stockLines, s.statusLines]);
    if (key !== last) {
      last = key;
      timeline.push({
        tMs: Date.now() - t0,
        blockClass: s.blockClass,
        innerText: escapeInvisible(s.innerText),
        textContent: escapeInvisible(s.textContent),
        priceLike: s.priceLike,
        stockLines: (s.stockLines ?? []).map(escapeInvisible),
        statusLines: (s.statusLines ?? []).map(escapeInvisible),
      });
    }
    return s;
  };

  const treeIdle = withTree && blockAppeared ? await describeBlock(block) : null;
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      await record();
      await sleep(200);
    }
  })();

  let hoverInfo = null;
  if (hover && blockAppeared) hoverInfo = await humanHover(page, block);
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !timeline.some((x) => x.priceLike)) await sleep(250);
  await sleep(2500); // settle: catch late mutations (value rotation, decoys, refreshes)
  stop = true;
  await sampler;

  const final = await snapshotPage(page);
  const treeFinal = withTree && blockAppeared ? await describeBlock(block) : null;
  if (shots && blockAppeared) {
    await block.screenshot({ path: path.join(outDir, `${label}-price.png`) }).catch(() => {});
    await page.screenshot({ path: path.join(outDir, `${label}-page.png`) }).catch(() => {});
  }
  await Promise.allSettled(pending);
  const firstPrice = timeline.find((x) => x.priceLike);
  const result = {
    label,
    url,
    hover,
    navigationError,
    blockAppeared,
    timeToBlockMs,
    timeToPriceMs: firstPrice?.tMs ?? null,
    hoverInfo,
    finalBlockClass: final.blockClass ?? null,
    finalInnerText: escapeInvisible(final.innerText),
    finalTextContent: escapeInvisible(final.textContent),
    finalStockLines: (final.stockLines ?? []).map(escapeInvisible),
    finalStatusLines: (final.statusLines ?? []).map(escapeInvisible),
    codepoints: codepointsOf(final.textContent),
    timeline: timeline.slice(0, 40),
    treeIdle,
    treeFinal,
    apiCalls: sink.responses.filter((r) => r.type === 'xhr' || r.type === 'fetch'),
    failedRequests: sink.failed.slice(0, 10),
    consoleMessages: consoleMsgs,
    pageErrors: sink.pageErrors.slice(0, 5),
  };
  await context.close();
  return result;
}

// ───────────────────────────── report ─────────────────────────────

const fmtMs = (v) => (v == null ? 'never' : `${v}ms`);

function buildHints(report) {
  const hints = [];
  const home = report.home?.analysis;
  if (home) {
    hints.push(
      home.emptyAppRoot || home.visibleTextLength < 200
        ? '⚠ Home page raw HTML has (almost) no visible text → content is probably client-rendered.'
        : '✓ Home page raw HTML contains visible text.',
    );
    hints.push(home.priceLikeCount ? `✓ Raw home HTML contains ${home.priceLikeCount} price-like strings.` : '⚠ No price-like strings in raw home HTML.');
  }
  const a = report.apis;
  if (a?.catalogOk) {
    const c = a.catalog;
    hints.push(`Catalog API OK: total=${c.page1.total}, pages=${c.page1.pages}, item keys=[${(c.page1.itemKeys ?? []).join(', ')}] (NO price/stock in catalog items unless listed).`);
    hints.push(`  pageSize=100 → ${c.pageSize100.itemCount ?? 'n/a'} items (HTTP ${c.pageSize100.status}); pageSize=1000 → ${c.pageSize1000.itemCount ?? 'n/a'} items (HTTP ${c.pageSize1000.status}).`);
    hints.push(`  Server-side search? q=phone → total ${c.queryQ.total}; search=phone → total ${c.querySearch.total} (total 1000 means the param is ignored).`);
  } else if (a) {
    hints.push(`⚠ Catalog API probe failed: ${a.error ?? a.catalog?.page1?.status ?? 'no items'}`);
  }
  const gate = report.product?.gate ?? [];
  if (gate.length) {
    const ctl = gate.find((g) => g.label === 'control-nohover');
    if (ctl) hints.push(ctl.timeToPriceMs == null ? '✓ Control run (NO hover): a price NEVER appeared → the price is gated behind pointer interaction.' : `⚠ Control run (no hover) showed a price after ${ctl.timeToPriceMs}ms → NOT gated by hover.`);
    const hov = gate.filter((g) => g.hover);
    const ok = hov.filter((g) => g.timeToPriceMs != null);
    hints.push(`Hover runs that produced a price-like text: ${ok.length}/${hov.length}. Time-to-price (ms): ${hov.map((g) => g.timeToPriceMs ?? 'none').join(', ')}`);
    hints.push(`Final price-block texts: ${hov.slice(0, 5).map((g) => JSON.stringify(g.finalInnerText)).join(' | ')}`);
    const cps = [...new Set(gate.flatMap((g) => g.codepoints ?? []))];
    if (cps.length) hints.push(`Non-ASCII / control code points inside the price block: ${cps.join(' ')}`);
    const stocks = [...new Set(gate.flatMap((g) => g.finalStockLines ?? []))];
    if (stocks.length) hints.push(`Stock wordings seen: ${stocks.map((x) => JSON.stringify(x)).join(' | ')}`);
    const fails = gate.filter((g) => (g.apiCalls ?? []).some((c) => c.status >= 400) || g.finalStatusLines?.some((l) => /wrong|error|expired|try again|retry/i.test(l)));
    if (fails.length) hints.push(`⚠ ${fails.length}/${gate.length} runs hit an API error or error message → the site injects failures; retries are REQUIRED.`);
  }
  if (report.soft404) {
    hints.push(report.soft404.sameBodyAsHome ? `⚠ Unknown paths return the SPA shell with HTTP ${report.soft404.status} (soft-404) → HTTP status cannot tell us a product page is missing; validate CONTENT.` : `Unknown paths return HTTP ${report.soft404.status}.`);
  }
  for (const b of Array.isArray(report.bundles) ? report.bundles : []) {
    if (b.error) { hints.push(`Bundle ${b.url}: ${b.error}`); continue; }
    hints.push(`Bundle ${b.url.split('/').pop()} (${b.bytes} bytes): fetch() x${b.counts.fetchCalls}, axios x${b.counts.axios}, "sku" x${b.counts.sku}, Math.random x${b.counts.mathRandom}.`);
    if (b.apiPaths.length) hints.push(`  API-like paths in bundle: ${b.apiPaths.slice(0, 8).join(' , ')}`);
    if (b.absoluteUrls.length) hints.push(`  Absolute URLs in bundle: ${b.absoluteUrls.slice(0, 6).join(' , ')}`);
    if (b.counts.sku > 50) hints.push('  ⚠ Many "sku" mentions → the product catalog may be EMBEDDED in the bundle (no API).');
  }
  const l = report.listing;
  if (l?.cardsRendered) {
    hints.push(`Listing: ${l.initialCount} cards rendered initially${l.totalClaim ? ` (page claims "${l.totalClaim}")` : ''}; counts after scrolling: ${l.countsAfterEachScroll.join(' → ')}.`);
    hints.push(l.infiniteScroll ? '⚠ Listing grows on scroll → infinite scroll; a catalog crawl must scroll or call the API behind it.' : 'Listing did not grow on scroll (pagination, or all cards are already in the DOM).');
    hints.push(l.firstCard.linkHref ? `Cards are real links (e.g. ${l.firstCard.linkHref}).` : '⚠ First card has NO <a href> → navigation is JS-driven; product URLs must come from clicks or an API.');
    if (l.paginationControls.length) hints.push(`Pagination-like controls: ${l.paginationControls.map((c) => c.text).join(' | ')}`);
    hints.push(`Clicking a card went to: ${l.urlAfterClick}`);
    if (l.apiLike?.length) hints.push(`Listing made ${l.apiLike.length} XHR/fetch calls → look in report.json → listing.apiLike for a products API.`);
  } else if (l) {
    hints.push(`⚠ Listing probe: ${l.note ?? l.error ?? 'no cards found'}`);
  }
  const rawProduct = report.product?.raw?.[0]?.analysis;
  if (rawProduct) {
    hints.push(
      rawProduct.priceLikeCount
        ? '✓ Price-like text IS present in the raw HTTP HTML of the product page → HTTP + Cheerio may be sufficient.'
        : '⚠ NO price-like text in raw product HTML → price is probably injected by JS (or uses a currency format this probe does not match).',
    );
    if (report.product.raw.length > 1) {
      const prices = report.product.raw.map((r) => r.analysis.priceLikeMatches.join('|'));
      hints.push(detectDifferences(prices) ? '⚠ Raw price text DIFFERED between consecutive fetches → prices change dynamically.' : '✓ Raw price text was stable across consecutive fetches.');
    }
  }
  const b = report.product?.browser?.[0];
  if (b) {
    hints.push(`Browser: DOMContentLoaded @ ${fmtMs(b.timing.domContentLoadedMs)}, load @ ${fmtMs(b.timing.loadMs)}, first price-like text @ ${fmtMs(b.firstPriceAtMs)}, first stock-like text @ ${fmtMs(b.firstStockAtMs)}.`);
    hints.push(b.networkIdle.reached ? `networkidle reached after ${b.networkIdle.afterMs}ms.` : '⚠ networkidle NOT reached within 20s → do not rely on it.');
    if (b.network.apiLike.length) hints.push(`Found ${b.network.apiLike.length} XHR/fetch responses on the product page → inspect report.json for a JSON API that could replace DOM scraping.`);
    if (b.network.hosts.some((h) => h !== HOST)) hints.push(`Third-party hosts contacted: ${b.network.hosts.filter((h) => h !== HOST).join(', ')}`);
  }
  const browsers = report.product?.browser ?? [];
  if (browsers.length > 1) {
    const seen = browsers.map((x) => JSON.stringify(x.timeline.at(-1)?.prices ?? []));
    hints.push(detectDifferences(seen) ? '⚠ Rendered price differed across reloads → prices change dynamically.' : '✓ Rendered price stable across reloads.');
    const times = browsers.map((x) => x.firstPriceAtMs);
    hints.push(`Time-to-first-price across reloads: ${times.map(fmtMs).join(', ')}`);
  }
  return hints;
}

function renderMarkdown(report) {
  const j = (v) => '```json\n' + JSON.stringify(v, null, 2) + '\n```';
  const lines = [
    '# Storefront probe report',
    `Generated: ${report.generatedAt}`,
    '',
    '## Automatic hints (heuristic — verify against the raw files)',
    ...report.hints.map((h) => `- ${h}`),
    '',
    '## Home page (raw HTTP)',
    j({ http: report.home?.http, analysis: report.home?.analysis }),
    '## JS bundle scan (API endpoints / embedded data) + soft-404 check',
    j({ soft404: report.soft404, bundles: report.bundles }),
    '## robots.txt / sitemap.xml',
    j({ robots: report.robots, sitemap: report.sitemap }),
    '## JSON API probe (catalog / product / layout)',
    j(report.apis),
    '## Product price-gate probes (hover vs no hover, per-run timelines)',
    j(report.product?.gate),
    '## Listing structure (browser)',
    j(report.listing),
    '## Search behaviour (browser)',
    j(report.search),
    '## Product page — raw HTTP fetches',
    j(report.product?.raw),
    '## Product page — browser visits',
    j((report.product?.browser ?? []).map(({ _links, ...rest }) => rest)),
    '',
  ];
  return lines.join('\n');
}

function printHelp() {
  console.log(`INE storefront probe
  --search=<term>        search term to try in the storefront search box (default: phone)
  --product-url=<url>    probe this product page instead of auto-detecting one
  --no-browser           HTTP-only probe (skips Playwright)
  --runs=<n>             hover runs on the primary product (default 4)
  --full                 also run the slow home/listing/search browser steps
  --out=<dir>            output directory (default: probe-output)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  await mkdir(args.outDir, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), target: TARGET, args, notes: [] };

  console.log('[1/5] HTTP GET home page …');
  const home = await httpGet(TARGET);
  await save(args.outDir, 'home.raw.html', home.body);
  report.home = { http: withoutBody(home), analysis: analyzeHtml(home.body) };
  console.log(`      status=${home.status ?? 'n/a'} bytes=${home.bytes ?? 0} ${home.error ?? ''}`);

  console.log('[1b] Scanning JS bundles for API endpoints / embedded data …');
  report.bundles = await scanBundles(home.body, args.outDir).catch((e) => ({ error: String(e) }));
  const missing = await httpGet(new URL(`/__probe_missing_${Date.now()}`, TARGET).href);
  report.soft404 = { status: missing.status, sameBodyAsHome: missing.ok && missing.body === home.body };

  console.log('[2/6] robots.txt / sitemap.xml …');
  const robots = await httpGet(new URL('/robots.txt', TARGET).href);
  const sitemap = await httpGet(new URL('/sitemap.xml', TARGET).href);
  report.robots = { status: robots.status, preview: robots.body.slice(0, 600) };
  report.sitemap = { status: sitemap.status, preview: sitemap.body.slice(0, 600) };

  console.log('[3/6] JSON API the frontend uses (catalog / product / layout) …');
  report.apis = await probeApis().catch((e) => ({ catalogOk: false, error: String(e) }));
  console.log(`      catalogOk=${report.apis.catalogOk} ${report.apis.error ?? ''}`);
  const fast = !args.full && report.apis.catalogOk;

  let productUrl = args.productUrl;
  if (!productUrl && report.apis.sampleIds?.[0]) productUrl = new URL(`/product/${report.apis.sampleIds[0].id}`, TARGET).href;
  if (!productUrl) productUrl = pickProductLink(report.home.analysis.linkPatterns);

  const pw = args.noBrowser ? null : await loadPlaywright();
  if (!args.noBrowser && !pw) {
    report.notes.push('Playwright not installed → browser steps skipped. Run: npm i -D playwright && npx playwright install chromium');
    console.log('      (playwright not installed — skipping browser steps)');
  }

  report.product = { url: productUrl, raw: [], browser: [], gate: [] };
  let browser;
  try {
    if (pw) browser = await pw.chromium.launch({ headless: true });

    if (browser && fast && productUrl) {
      const others = (report.apis.sampleIds ?? []).slice(1).map((x) => new URL(`/product/${x.id}`, TARGET).href);
      console.log('[4/6] Price gate: control run WITHOUT hover …');
      report.product.gate.push(await probeProductGate(browser, productUrl, { label: 'control-nohover', hover: false, outDir: args.outDir, budgetMs: 8000, withTree: true }));
      for (let i = 0; i < args.runs; i += 1) {
        console.log(`[5/6] Price gate: hover run ${i + 1}/${args.runs} on ${productUrl}`);
        report.product.gate.push(await probeProductGate(browser, productUrl, { label: `hover-${i + 1}`, hover: true, outDir: args.outDir, withTree: i === 0, shots: i === 0 }));
      }
      for (const [i, u] of others.entries()) {
        console.log(`[6/6] Other products ${i + 1}/${others.length}: ${u}`);
        report.product.gate.push(await probeProductGate(browser, u, { label: `other-${i + 1}`, hover: true, outDir: args.outDir, withTree: i === 0, shots: i === 0 }));
      }
    } else if (browser) {
      // --full (or catalog API unavailable): the original exploratory flow.
      const context = await browser.newContext({ userAgent: USER_AGENT });
      console.log('[4/6] Browser: home page render …');
      const homeVisit = await browserVisit(context, TARGET, { label: 'home', outDir: args.outDir, pollMs: 25000 });
      report.homeBrowser = { ...homeVisit, _links: undefined };
      if (!productUrl) {
        const patterns = groupLinkPatterns(homeVisit._links.map((l) => l.href));
        report.homeBrowser.linkPatterns = patterns;
        productUrl = pickProductLink(patterns);
        report.product.url = productUrl;
      }
      console.log('[4b] Browser: listing structure …');
      report.listing = await probeListing(context).catch((e) => ({ error: String(e) }));
      console.log(`[5/6] Browser: search "${args.search}" …`);
      report.search = await probeSearch(context, args.search).catch((e) => ({ found: false, error: String(e) }));
      if (productUrl) {
        for (let i = 0; i < 3; i += 1) {
          const raw = await httpGet(productUrl);
          if (i === 0) await save(args.outDir, 'product.raw.html', raw.body);
          report.product.raw.push({ http: withoutBody(raw), analysis: analyzeHtml(raw.body) });
          await sleep(1000);
        }
        for (let i = 0; i < 3; i += 1) {
          report.product.browser.push(await browserVisit(context, productUrl, { label: `product-${i + 1}`, outDir: args.outDir, pollMs: 15000 }));
        }
      }
    } else {
      report.search = { skipped: true, reason: 'browser unavailable' };
    }
  } finally {
    await browser?.close();
  }

  report.hints = buildHints(report);
  await save(args.outDir, 'report.json', { ...report, product: { ...report.product, browser: report.product.browser.map(({ _links, ...r }) => r) } });
  await save(args.outDir, 'report.md', renderMarkdown(report));

  console.log('\n──────── HINTS ────────');
  for (const h of report.hints) console.log(`• ${h}`);
  console.log(`\nWrote ${path.resolve(args.outDir)}/ (report.md, report.json, *.html)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('Probe failed:', err);
    process.exitCode = 1;
  });
}
