import axios, { AxiosError } from 'axios';
import type {
  ApiErrorBody,
  HistoryResponse,
  ListProductsResponse,
  LogsResponse,
  ManualScrapeResponse,
  ProductDto,
  SearchResponse,
  TrackProductResponse,
} from './types';

const baseURL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

const http = axios.create({ baseURL, timeout: 20_000 });

/**
 * Every API failure surfaces as this — code + a message safe to show a user, unwrapped from the
 * backend's `{ error: { code, message } }` envelope (or a generic one for network/timeout
 * failures, which never reach the backend's envelope at all).
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(message: string, code: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function toApiError(error: unknown): ApiError {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<ApiErrorBody>;
    const body = axiosError.response?.data;
    if (body?.error) {
      return new ApiError(body.error.message, body.error.code, axiosError.response?.status ?? null);
    }
    if (axiosError.code === 'ECONNABORTED') {
      return new ApiError('The request timed out. The backend may be waking up from sleep — try again.', 'TIMEOUT', null);
    }
    return new ApiError('Could not reach the API. It may be offline or waking up from sleep.', 'NETWORK_ERROR', null);
  }
  return new ApiError('Something unexpected went wrong.', 'UNKNOWN', null);
}

export const api = {
  async search(query: string, limit = 20): Promise<SearchResponse> {
    try {
      const { data } = await http.get<SearchResponse>('/products/search', { params: { q: query, limit } });
      return data;
    } catch (error) {
      throw toApiError(error);
    }
  },

  async listProducts(): Promise<ListProductsResponse> {
    try {
      const { data } = await http.get<ListProductsResponse>('/products');
      return data;
    } catch (error) {
      throw toApiError(error);
    }
  },

  async trackProduct(input: { storeProductId: number }): Promise<TrackProductResponse> {
    try {
      const { data } = await http.post<TrackProductResponse>('/products', input);
      return data;
    } catch (error) {
      throw toApiError(error);
    }
  },

  async getProduct(id: string): Promise<ProductDto> {
    try {
      const { data } = await http.get<ProductDto>(`/products/${id}`);
      return data;
    } catch (error) {
      throw toApiError(error);
    }
  },

  async untrackProduct(id: string): Promise<void> {
    try {
      await http.delete(`/products/${id}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async getHistory(id: string, limit = 200): Promise<HistoryResponse> {
    try {
      const { data } = await http.get<HistoryResponse>(`/products/${id}/history`, { params: { limit } });
      return data;
    } catch (error) {
      throw toApiError(error);
    }
  },

  async getLogs(id: string, limit = 100): Promise<LogsResponse> {
    try {
      const { data } = await http.get<LogsResponse>(`/products/${id}/logs`, { params: { limit } });
      return data;
    } catch (error) {
      throw toApiError(error);
    }
  },

  async scrapeNow(id: string): Promise<ManualScrapeResponse> {
    try {
      const { data } = await http.post<ManualScrapeResponse>(`/products/${id}/scrape`);
      return data;
    } catch (error) {
      throw toApiError(error);
    }
  },
};
