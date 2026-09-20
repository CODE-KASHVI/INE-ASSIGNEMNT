import { describe, expect, it } from 'vitest';
import { assertAllowedStoreUrl, canonicalizeProductUrl } from '../src/utils/url';

describe('assertAllowedStoreUrl (SSRF guard)', () => {
  it('accepts the storefront host', () => {
    expect(assertAllowedStoreUrl('https://demo.inelabteamdev.com/').hostname).toBe('demo.inelabteamdev.com');
    expect(assertAllowedStoreUrl('https://demo.inelabteamdev.com/anything?id=3').pathname).toBe('/anything');
    expect(assertAllowedStoreUrl('https://DEMO.inelabteamdev.com/').hostname).toBe('demo.inelabteamdev.com');
  });

  const rejected = [
    'http://demo.inelabteamdev.com/', //                      plain http
    'https://evil.com/', //                                   other host
    'https://inelabteamdev.com/', //                          parent domain
    'https://sub.demo.inelabteamdev.com/', //                 subdomain
    'https://demo.inelabteamdev.com.evil.com/', //            suffix trick
    'https://demo.inelabteamdev.com@evil.com/', //            userinfo trick (real host is evil.com)
    'https://user:pw@demo.inelabteamdev.com/', //             credentials
    'https://demo.inelabteamdev.com:8443/', //                custom port
    'https://demo.inelabteamdev.com./', //                    trailing-dot hostname
    'https://evil.com/?u=https://demo.inelabteamdev.com/', // allowed host only in the query
    'https://127.0.0.1/', //                                  loopback
    'https://169.254.169.254/latest/meta-data/', //           cloud metadata
    'javascript:alert(1)',
    'file:///etc/passwd',
    '//demo.inelabteamdev.com/', //                           protocol-relative (not absolute)
    'demo.inelabteamdev.com/product/1', //                    no scheme
    '',
    'not a url',
  ];
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => assertAllowedStoreUrl(input)).toThrow();
    });
  }
});

describe('canonicalizeProductUrl (duplicate protection)', () => {
  it('collapses equivalent URLs to one canonical form', () => {
    const variants = [
      'https://demo.inelabteamdev.com/product/1',
      'https://demo.inelabteamdev.com/product/1/',
      'https://DEMO.inelabteamdev.com/product/1#reviews',
      'https://demo.inelabteamdev.com/product/1?utm_source=newsletter&fbclid=abc',
      'https://demo.inelabteamdev.com//product//1//',
    ];
    const canonical = new Set(variants.map((v) => canonicalizeProductUrl(v)));
    expect([...canonical]).toEqual(['https://demo.inelabteamdev.com/product/1']);
  });

  it('keeps meaningful query params, sorted, so ?id=2 and ?id=3 stay distinct', () => {
    expect(canonicalizeProductUrl('https://demo.inelabteamdev.com/item?b=2&a=1&utm_medium=x')).toBe('https://demo.inelabteamdev.com/item?a=1&b=2');
    const a = canonicalizeProductUrl('https://demo.inelabteamdev.com/item?id=2');
    const b = canonicalizeProductUrl('https://demo.inelabteamdev.com/item?id=3');
    expect(a === b).toBe(false);
  });

  it('preserves path case (paths are case-sensitive)', () => {
    expect(canonicalizeProductUrl('https://demo.inelabteamdev.com/Product/Abc')).toBe('https://demo.inelabteamdev.com/Product/Abc');
  });

  it('refuses non-storefront URLs', () => {
    expect(() => canonicalizeProductUrl('https://evil.com/product/1')).toThrow();
  });
});
