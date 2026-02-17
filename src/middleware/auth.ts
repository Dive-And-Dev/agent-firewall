import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export function createAuthMiddleware(bridgeToken: string) {
  const expectedBuf = Buffer.from(bridgeToken, 'utf-8');

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header) {
      res.status(401).json({ error: 'Authorization header is required' });
      return;
    }

    if (!header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Invalid authorization scheme; use Bearer' });
      return;
    }

    const token = header.slice(7);
    if (!token) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const tokenBuf = Buffer.from(token, 'utf-8');

    // timingSafeEqual requires same-length buffers
    const valid =
      tokenBuf.length === expectedBuf.length &&
      timingSafeEqual(tokenBuf, expectedBuf);

    if (!valid) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}
