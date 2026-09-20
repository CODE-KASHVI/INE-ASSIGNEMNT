import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { cronAuth } from '../middleware/cronAuth';
import { runScheduledScrape } from '../controllers/scrape.controller';

export const scrapeRouter = Router();

// cronAuth runs before the controller, so an unauthenticated hit never reaches the database.
scrapeRouter.post('/run', cronAuth, asyncHandler(runScheduledScrape));
