import type { Request, Response } from 'express';
import { z } from 'zod';
import { productService } from '../services/productService';
import { historyRepository } from '../repositories/historyRepository';
import { scrapeLogRepository } from '../repositories/scrapeLogRepository';
import { scrapeRunner } from '../services/scrapeRunner';
import { toHistoryPointDto, toLogEntryDto } from '../types/dto';
import type { HealthStatus } from '../types/dto';

const HEALTH_STATUSES: HealthStatus[] = ['PENDING', 'HEALTHY', 'RETRYING', 'FAILED', 'STRUCTURE_CHANGED'];

const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function searchProducts(req: Request, res: Response): Promise<void> {
  const { q, limit } = SearchQuerySchema.parse(req.query);
  const results = await productService.search(q, limit);
  res.status(200).json({ query: q, results });
}

const ListQuerySchema = z.object({
  health: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))
    .pipe(z.array(z.enum(HEALTH_STATUSES as [HealthStatus, ...HealthStatus[]]))),
  sort: z.enum(['last_attempt_at_desc', 'name_asc', 'price_change_desc']).default('last_attempt_at_desc'),
});

export async function listProducts(req: Request, res: Response): Promise<void> {
  const { health, sort } = ListQuerySchema.parse(req.query);
  const products = await productService.list(health.length > 0 ? health : null, sort);
  res.status(200).json({ products });
}

const TrackProductSchema = z
  .object({
    storeProductId: z.coerce.number().int().positive().optional(),
    url: z.string().url().optional(),
  })
  .refine((body) => body.storeProductId != null || body.url != null, { message: 'Provide either "storeProductId" or "url"' });

export async function trackProduct(req: Request, res: Response): Promise<void> {
  const input = TrackProductSchema.parse(req.body);
  const { dto, initialScrapeQueued } = await productService.track(input);
  res.status(201).json({ ...dto, initialScrapeQueued });
}

const IdParamSchema = z.object({ id: z.string().uuid() });

export async function getProduct(req: Request, res: Response): Promise<void> {
  const { id } = IdParamSchema.parse(req.params);
  const dto = await productService.getById(id);
  res.status(200).json(dto);
}

export async function deleteProduct(req: Request, res: Response): Promise<void> {
  const { id } = IdParamSchema.parse(req.params);
  await productService.remove(id);
  res.status(204).send();
}

const CursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  before: z.string().datetime().optional(),
});

export async function getProductHistory(req: Request, res: Response): Promise<void> {
  const { id } = IdParamSchema.parse(req.params);
  const { limit, before } = CursorQuerySchema.parse(req.query);
  await productService.getById(id); // 404s if the product does not exist, before we bother querying history
  const page = await historyRepository.listForProduct(id, limit, before ?? null);
  res.status(200).json({ productId: id, points: page.rows.map(toHistoryPointDto), nextBefore: page.nextBefore });
}

export async function getProductLogs(req: Request, res: Response): Promise<void> {
  const { id } = IdParamSchema.parse(req.params);
  const { limit, before } = CursorQuerySchema.parse(req.query);
  await productService.getById(id);
  const page = await scrapeLogRepository.listForProduct(id, limit, before ?? null);
  res.status(200).json({ productId: id, entries: page.rows.map(toLogEntryDto), nextBefore: page.nextBefore });
}

export async function scrapeProductNow(req: Request, res: Response): Promise<void> {
  const { id } = IdParamSchema.parse(req.params);
  const outcome = await scrapeRunner.runManualForProduct(id);

  if (outcome.ok) {
    res.status(200).json({
      outcome: 'SUCCESS',
      attempts: outcome.attempts,
      price: outcome.value.price,
      currency: outcome.value.currency,
      stockStatus: outcome.value.stockStatus,
    });
  } else {
    res.status(200).json({
      outcome: 'FAILED',
      attempts: outcome.attempts,
      errorType: outcome.error.type,
      message: outcome.error.message,
    });
  }
}
