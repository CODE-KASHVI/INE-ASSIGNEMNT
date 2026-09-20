import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { requestId } from './middleware/requestId';
import { errorHandler } from './middleware/errorHandler';
import { healthRouter } from './routes/health.routes';
import { productsRouter } from './routes/products.routes';
import { scrapeRouter } from './routes/scrape.routes';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  // Exact-match the configured frontend origin — no wildcard. The frontend is the only client
  // this API expects; cron-job.org and any curl/manual testing don't send an Origin header at
  // all, so they are unaffected by this restriction.
  app.use(cors({ origin: env.FRONTEND_URL }));
  app.use(express.json({ limit: '100kb' }));
  app.use(requestId);

  app.use('/api/health', healthRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/scrape', scrapeRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such route' } });
  });

  // Error middleware must be registered last, after every route.
  app.use(errorHandler);

  return app;
}
