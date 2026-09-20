/**
 * URL allow-listing (SSRF protection) and canonicalisation (duplicate-tracking protection).
 * Every URL that reaches a fetcher or the database goes through here.
 */

export const ALLOWED_STORE_HOSTNAME = 'demo.inelabteamdev.com';

export class UrlNotAllowedError extends Error {
  readonly code = 'URL_NOT_ALLOWED';
  constructor(message: string) {
    super(message);
    this.name = 'UrlNotAllowedError';
  }
}

/** Tracking parameters that never change which product a URL points at. */
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;

/**
 * Parses and validates a URL. Rejects anything that is not exactly
 * https://demo.inelabteamdev.com[/...] — no other host, no subdomains, no userinfo, no custom port.
 * (Trailing-dot hostnames and `host@evil.com` tricks are rejected by the strict hostname comparison.)
 */
export function assertAllowedStoreUrl(input: string, allowedHostname: string = ALLOWED_STORE_HOSTNAME): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlNotAllowedError('Not a valid absolute URL');
  }
  if (url.protocol !== 'https:') throw new UrlNotAllowedError('Only https URLs are allowed');
  if (url.username || url.password) throw new UrlNotAllowedError('Credentials in URLs are not allowed');
  if (url.port) throw new UrlNotAllowedError('Custom ports are not allowed');
  if (url.hostname !== allowedHostname) throw new UrlNotAllowedError(`Host is not allowed: ${url.hostname}`);
  return url;
}

/**
 * Stable identity for a product page: lower-case host, no fragment, no tracking params,
 * remaining params sorted, no duplicate/trailing slashes. Stored in tracked_products.canonical_url (UNIQUE).
 */
export function canonicalizeProductUrl(input: string, allowedHostname: string = ALLOWED_STORE_HOSTNAME): string {
  const url = assertAllowedStoreUrl(input, allowedHostname);

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  url.hash = '';
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);

  let pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
  url.pathname = pathname;

  return url.toString();
}
