/**
 * Mirrors backend/src/types/dto.ts field-for-field. If the backend contract changes, this file
 * is the one place to update on the frontend — nothing else should hand-roll these shapes.
 */

export type HealthStatus = 'PENDING' | 'HEALTHY' | 'RETRYING' | 'FAILED' | 'STRUCTURE_CHANGED';
export type StockStatus = 'IN_STOCK' | 'OUT_OF_STOCK';
export type TerminalStatus = 'SUCCESS' | 'FAILED' | 'VALIDATION_FAILED' | 'TIMEOUT' | 'STRUCTURE_CHANGED';

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

export interface SearchHitDto {
  storeProductId: number;
  name: string;
  brand: string;
  category: string;
  sku: string;
  url: string;
  alreadyTracked: boolean;
}

export interface HistoryPointDto {
  scrapedAt: string;
  price: number;
  currency: string | null;
  stockStatus: StockStatus;
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

export interface SearchResponse {
  query: string;
  results: SearchHitDto[];
}

export interface ListProductsResponse {
  products: ProductDto[];
}

export interface TrackProductResponse extends ProductDto {
  initialScrapeQueued: boolean;
}

export interface HistoryResponse {
  productId: string;
  points: HistoryPointDto[];
  nextBefore: string | null;
}

export interface LogsResponse {
  productId: string;
  entries: LogEntryDto[];
  nextBefore: string | null;
}

export type ManualScrapeResponse =
  | {
      outcome: 'SUCCESS';
      attempts: number;
      price: number;
      currency: string | null;
      stockStatus: StockStatus;
    }
  | {
      outcome: 'FAILED';
      attempts: number;
      errorType: string;
      message: string;
    };

/** Every non-2xx response from the API shares this envelope — see backend middleware/errorHandler.ts. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
