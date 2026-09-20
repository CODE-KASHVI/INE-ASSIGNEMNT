import type { Request, Response } from 'express';
import { scrapeRunner } from '../services/scrapeRunner';

export async function runScheduledScrape(_req: Request, res: Response): Promise<void> {
  const result = await scrapeRunner.runCron();

  if (result.skipped) {
    res.status(200).json({ skipped: true, reason: result.reason });
    return;
  }

  res.status(200).json({
    runId: result.runId,
    productsTotal: result.productsTotal,
    productsSuccess: result.productsSuccess,
    productsFailed: result.productsFailed,
    productsSkipped: result.productsSkipped,
  });
}
