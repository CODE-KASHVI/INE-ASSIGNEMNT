import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { searchLimiter, manualScrapeLimiter } from '../middleware/rateLimit';
import {
  deleteProduct,
  getProduct,
  getProductHistory,
  getProductLogs,
  listProducts,
  scrapeProductNow,
  searchProducts,
  trackProduct,
} from '../controllers/product.controller';

export const productsRouter = Router();

productsRouter.get('/search', searchLimiter, asyncHandler(searchProducts));
productsRouter.get('/', asyncHandler(listProducts));
productsRouter.post('/', asyncHandler(trackProduct));
productsRouter.get('/:id', asyncHandler(getProduct));
productsRouter.delete('/:id', asyncHandler(deleteProduct));
productsRouter.get('/:id/history', asyncHandler(getProductHistory));
productsRouter.get('/:id/logs', asyncHandler(getProductLogs));
productsRouter.post('/:id/scrape', manualScrapeLimiter, asyncHandler(scrapeProductNow));
