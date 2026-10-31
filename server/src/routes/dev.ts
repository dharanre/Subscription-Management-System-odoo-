import { Router } from 'express';
import { notFound } from '../lib/http.js';
import type { DevMailbox } from '../lib/mailer.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Local-only mailbox so the password reset flow can be demonstrated without a mail provider.
 * It is only mounted when DEV_MAILBOX is on and it refuses any non-loopback client.
 */
export function devRouter(mailbox: DevMailbox): Router {
  const router = Router();
  router.use((req, _res, next) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return next(notFound('Page'));
    next();
  });
  router.get('/mailbox', async (_req, res) => {
    res.json({ items: await mailbox.list() });
  });
  router.delete('/mailbox', async (_req, res) => {
    await mailbox.clear();
    res.status(204).end();
  });
  return router;
}
