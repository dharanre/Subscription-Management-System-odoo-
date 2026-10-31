import * as m001 from './001_auth.js';
import * as m002 from './002_catalog.js';
import * as m003 from './003_subscriptions.js';
import * as m004 from './004_invoices.js';
import * as m005 from './005_payments.js';
import * as m006 from './006_dashboard.js';

export interface Migration {
  id: string;
  sql: string;
}

/** Applied in order, each exactly once. Never edit a migration that has shipped; add a new one. */
export const migrations: Migration[] = [m001, m002, m003, m004, m005, m006];
