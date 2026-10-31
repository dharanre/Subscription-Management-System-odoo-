import fs from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express } from 'express';
import helmet from 'helmet';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { HttpError, notFound } from './lib/http.js';
import { DevMailbox, type Mailer } from './lib/mailer.js';
import { loadSession, requireAuth, sameOriginWrites } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { devRouter } from './routes/dev.js';
import { discountsRouter } from './routes/discounts.js';
import { plansRouter } from './routes/plans.js';
import { pricingRouter } from './routes/pricing.js';
import { productsRouter } from './routes/products.js';
import { taxesRouter } from './routes/taxes.js';
import { usersRouter } from './routes/users.js';

export interface AppDeps {
  config: Config;
  db: DB;
  mailer: Mailer;
}

export function createApp({ config, db, mailer }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(sameOriginWrites(config));
  api.use(loadSession(db));

  api.get('/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });
  api.use('/auth', authRouter(db, config, mailer));
  api.get('/meta', requireAuth, (_req, res) => {
    res.json({ currency: config.currency, locale: config.locale });
  });
  api.use('/users', requireAuth, usersRouter(db, config));
  api.use('/products', requireAuth, productsRouter(db));
  api.use('/plans', requireAuth, plansRouter(db));
  api.use('/taxes', requireAuth, taxesRouter(db));
  api.use('/discounts', requireAuth, discountsRouter(db));
  api.use('/pricing', requireAuth, pricingRouter(db));
  if (config.devMailbox && mailer instanceof DevMailbox) api.use('/dev', devRouter(mailer));

  api.use((_req, _res, next) => next(notFound('Endpoint')));
  app.use('/api', api);

  // In production the API process also serves the built web app.
  if (fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use(express.static(config.clientDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, fields: err.fields } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON.' } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'too_large', message: 'The request body is too large.' } });
      return;
    }
    console.error('[server] unhandled error', err);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' } });
  };
  app.use(onError);

  return app;
}
