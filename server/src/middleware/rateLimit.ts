import type { RequestHandler } from 'express';
import { HttpError } from '../lib/http.js';

/**
 * Small in-memory fixed-window limiter, enough to slow credential guessing on a single node.
 * A multi-node deployment would need a shared store.
 */
export function rateLimit(enabled: boolean, name: string, opts: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    if (!enabled) return next();
    const now = Date.now();
    const key = `${name}:${req.ip}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    if (entry.count > opts.max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return next(new HttpError(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.'));
    }
    next();
  };
}
