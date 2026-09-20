/**
 * Response shapes shared by controllers, plus the mappers from Supabase rows (snake_case) to
 * them (camelCase). Keeping the mapping in one place is what stops the API contract from
 * drifting out of sync with docs/api-design.md as columns get added.
 */
import type { CatalogItem } from '../scraper/catalog';

export type HealthStatus = 'PENDING' | 'HEALTHY' | 'RETRYING' | 'FAILED' | 'STRUCTURE_CHANGED';
export type StockStatus = 'IN_STOCK' | 'OUT_OF_STOCK';
export type TerminalStatus = 'SUCCESS' | 'FAILED' | 'VALIDATION_FAILED' | 'TIMEOUT' | 'STRUCTURE_CHANGED';

/** The row shape returned by Supabase for `tracked_products`. */
export interface TrackedProductRow {
  id: string;
  canonical_url: string;
  store_product_id: number;
  name: string;
  category: string | null;
  image_url: string | null;
  currency: string | null;
  current_price: number | null;
  previous_price: number | null;
  price_changed_at: string | null;
  current_stock: StockStatus | null;
  last_scraped_at: string | null;
  last_attempt_at: string | null;
  last_attempt_status: TerminalStatus | null;
  health_status: HealthStatus;
  consecutive_failures: number;
  scrape_interval_hours: number;
  scrape_lock_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductDto {
  id: string;
  storeProductId: number;
  name: string;
  category: string | null;
  url: string;
  imageUrl: string | null;
  currentPrice: number | null;
  previousPrice: number | null;
  priceChange: number | null;
  priceChangePercent: number | null;
  currency: string | null;
  currentStock: StockStatus | null;
  healthStatus: HealthStatus;
  consecutiveFailures: number;
  lastScrapedAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptStatus: TerminalStatus | null;
}

/** Derives price-change fields from current/previous rather than storing them — see api-design.md. */
export function toProductDto(row: TrackedProductRow): ProductDto {
  const priceChange =
    row.current_price != null && row.previous_price != null ? Number((row.current_price - row.previous_price).toFixed(2)) : null;
  const priceChangePercent =
    priceChange != null && row.previous_price ? Number(((priceChange / row.previous_price) * 100).toFixed(2)) : null;

  return {
    id: row.id,
    storeProductId: row.store_product_id,
    name: row.name,
    category: row.category,
    url: row.canonical_url,
    imageUrl: row.image_url,
    currentPrice: row.current_price,
    previousPrice: row.previous_price,
    priceChange,
    priceChangePercent,
    currency: row.currency,
    currentStock: row.current_stock,
    healthStatus: row.health_status,
    consecutiveFailures: row.consecutive_failures,
    lastScrapedAt: row.last_scraped_at,
    lastAttemptAt: row.last_attempt_at,
    lastAttemptStatus: row.last_attempt_status,
  };
}

export interface SearchHitDto {
  storeProductId: number;
  name: string;
  brand: string;
  category: string;
  sku: string;
  url: string;
  alreadyTracked: boolean;
}

export function toSearchHitDto(item: CatalogItem & { url: string }, alreadyTracked: boolean): SearchHitDto {
  return {
    storeProductId: item.id,
    name: item.name,
    brand: item.brand,
    category: item.category,
    sku: item.sku,
    url: item.url,
    alreadyTracked,
  };
}

export interface PriceHistoryRow {
  scraped_at: string;
  price: number;
  currency: string | null;
  stock_status: StockStatus;
}

export interface HistoryPointDto {
  scrapedAt: string;
  price: number;
  currency: string | null;
  stockStatus: StockStatus;
}

export function toHistoryPointDto(row: PriceHistoryRow): HistoryPointDto {
  return { scrapedAt: row.scraped_at, price: row.price, currency: row.currency, stockStatus: row.stock_status };
}

export interface ScrapeLogRow {
  created_at: string;
  run_id: string | null;
  attempt_number: number;
  status: string;
  will_retry: boolean;
  message: string | null;
  error_type: string | null;
  error_message: string | null;
  duration_ms: number | null;
  extracted_price: number | null;
  extracted_stock: string | null;
  extraction_method: string | null;
}

export interface LogEntryDto {
  createdAt: string;
  runId: string | null;
  attempt: number;
  status: string;
  willRetry: boolean;
  message?: string;
  errorType?: string;
  errorMessage?: string;
  durationMs?: number;
  extractedPrice?: number;
  extractedStock?: string;
  extractionMethod?: string;
}

/** Omits inapplicable fields (rather than emitting `null`) so a SUCCESS row and a TIMEOUT row don't look alike. */
export function toLogEntryDto(row: ScrapeLogRow): LogEntryDto {
  const entry: LogEntryDto = {
    createdAt: row.created_at,
    runId: row.run_id,
    attempt: row.attempt_number,
    status: row.status,
    willRetry: row.will_retry,
  };
  if (row.message != null) entry.message = row.message;
  if (row.error_type != null) entry.errorType = row.error_type;
  if (row.error_message != null) entry.errorMessage = row.error_message;
  if (row.duration_ms != null) entry.durationMs = row.duration_ms;
  if (row.extracted_price != null) entry.extractedPrice = row.extracted_price;
  if (row.extracted_stock != null) entry.extractedStock = row.extracted_stock;
  if (row.extraction_method != null) entry.extractionMethod = row.extraction_method;
  return entry;
}
