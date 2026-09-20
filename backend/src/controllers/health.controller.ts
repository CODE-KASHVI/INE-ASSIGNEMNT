import type { Request, Response } from 'express';

const startedAt = Date.now();

export function getHealth(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
}
