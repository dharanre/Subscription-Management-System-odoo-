export const id = '003_subscriptions';

export const sql = `
CREATE TABLE payment_terms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  days_due   INTEGER NOT NULL CHECK (days_due BETWEEN 0 AND 365),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo    INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_payment_terms_single_default ON payment_terms(is_default) WHERE is_default = 1;

-- Gap-free-per-name counters for document numbers. Always incremented inside the transaction that uses it.
CREATE TABLE sequences (
  name       TEXT PRIMARY KEY,
  last_value INTEGER NOT NULL
);

CREATE TABLE quotation_templates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  plan_id          INTEGER NOT NULL REFERENCES plans(id),
  validity_days    INTEGER NOT NULL CHECK (validity_days BETWEEN 1 AND 365),
  payment_terms_id INTEGER REFERENCES payment_terms(id),
  notes            TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo          INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE quotation_template_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES quotation_templates(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  variant_id  INTEGER REFERENCES product_variants(id),
  quantity    INTEGER NOT NULL CHECK (quantity >= 1)
);
CREATE INDEX idx_template_lines_template ON quotation_template_lines(template_id, position);

-- One record is both the quotation and, once confirmed, the subscription, so it keeps one number.
CREATE TABLE subscriptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  number            TEXT NOT NULL UNIQUE,
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  plan_id           INTEGER NOT NULL REFERENCES plans(id),
  template_id       INTEGER REFERENCES quotation_templates(id),
  payment_terms_id  INTEGER REFERENCES payment_terms(id),
  status            TEXT NOT NULL CHECK (status IN ('draft', 'quotation', 'confirmed', 'active', 'paused', 'closed')),
  start_date        TEXT NOT NULL,
  expiry_date       TEXT NOT NULL,
  quote_valid_until TEXT,
  -- Set on activation; recurring billing (Stage 4) advances it after each invoice.
  next_billing_date TEXT,
  closed_at         TEXT,
  close_reason      TEXT CHECK (close_reason IN ('cancelled', 'closed_early', 'expired')),
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id),
  is_demo           INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (expiry_date > start_date),
  CHECK (status <> 'closed' OR close_reason IS NOT NULL)
);
CREATE INDEX idx_subscriptions_status ON subscriptions(status, next_billing_date);
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id, status);
CREATE INDEX idx_subscriptions_expiry ON subscriptions(status, expiry_date);
CREATE INDEX idx_subscriptions_plan ON subscriptions(plan_id);

-- Prices are a snapshot taken when the line is saved, so later catalog changes never alter an existing quote.
CREATE TABLE subscription_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('plan', 'product')),
  description     TEXT NOT NULL,
  product_id      INTEGER REFERENCES products(id),
  variant_id      INTEGER REFERENCES product_variants(id),
  quantity        INTEGER NOT NULL CHECK (quantity >= 1),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  tax_id          INTEGER REFERENCES taxes(id),
  tax_rate_bp     INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000)
);
CREATE INDEX idx_subscription_lines_sub ON subscription_lines(subscription_id, position);

-- Append-only history, so anyone can see how a subscription got to where it stands.
CREATE TABLE subscription_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  actor_id        INTEGER REFERENCES users(id),
  note            TEXT,
  at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_subscription_events_sub ON subscription_events(subscription_id, id);
`;
