import * as m001 from './001_auth.js';

export interface Migration {
  id: string;
  sql: string;
}

/** Applied in order, each exactly once. Never edit a migration that has shipped; add a new one. */
export const migrations: Migration[] = [m001];
