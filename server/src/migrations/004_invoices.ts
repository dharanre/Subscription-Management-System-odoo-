export const id = '004_invoices';

export const sql = `
-- Which billing period a subscription will be billed for next (0 = the period starting on its start date),
-- and when it was paused, so billing can resume at the right place without skipping or doubling a period.
ALTER TABLE subscriptions ADD COLUMN next_period INTEGER NOT NULL DEFAULT 0 CHECK (next_period >= 0);
ALTER TABLE subscriptions ADD COLUMN paused_at TEXT;

CREATE TABLE invoices (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  number                TEXT NOT NULL UNIQUE,
  subscription_id       INTEGER NOT NULL REFERENCES subscriptions(id),
  customer_id           INTEGER NOT NULL REFERENCES customers(id),
  -- The billing period this invoice covers. The UNIQUE constraint below is what makes
  -- "never bill the same period twice" true no matter what the code above it does.
  period_index          INTEGER NOT NULL CHECK (period_index >= 0),
  period_start          TEXT NOT NULL,
  period_end            TEXT NOT NULL,
  issue_date            TEXT NOT NULL,
  due_date              TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'paid', 'cancelled')),

  -- Customer and subscription details as they were when the invoice was made.
  customer_name         TEXT NOT NULL,
  customer_company      TEXT,
  customer_email        TEXT NOT NULL,
  customer_address      TEXT,
  subscription_number   TEXT NOT NULL,
  plan_name             TEXT NOT NULL,
  payment_terms_name    TEXT,
  discount_id           INTEGER REFERENCES discounts(id),
  discount_name         TEXT,

  subtotal_minor        INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor        INTEGER NOT NULL CHECK (discount_minor >= 0),
  tax_minor             INTEGER NOT NULL CHECK (tax_minor >= 0),
  total_minor           INTEGER NOT NULL CHECK (total_minor >= 0),
  paid_minor            INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),

  sent_at               TEXT,
  sent_count            INTEGER NOT NULL DEFAULT 0,
  confirmed_at          TEXT,
  paid_at               TEXT,
  cancelled_at          TEXT,
  cancel_reason         TEXT,
  created_by            INTEGER REFERENCES users(id),
  is_demo               INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (subscription_id, period_index),
  CHECK (total_minor = subtotal_minor - discount_minor + tax_minor),
  CHECK (paid_minor <= total_minor),
  CHECK (due_date >= issue_date),
  CHECK (period_end >= period_start),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);
CREATE INDEX idx_invoices_status_due ON invoices(status, due_date);
CREATE INDEX idx_invoices_customer ON invoices(customer_id, status);
CREATE INDEX idx_invoices_issue ON invoices(issue_date);

CREATE TABLE invoice_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('plan', 'product')),
  description      TEXT NOT NULL,
  product_id       INTEGER REFERENCES products(id),
  quantity         INTEGER NOT NULL CHECK (quantity >= 1),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  tax_name         TEXT,
  tax_rate_bp      INTEGER NOT NULL DEFAULT 0,
  subtotal_minor   INTEGER NOT NULL,
  discount_minor   INTEGER NOT NULL,
  tax_minor        INTEGER NOT NULL,
  total_minor      INTEGER NOT NULL,
  CHECK (total_minor = subtotal_minor - discount_minor + tax_minor)
);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id, position);

CREATE TABLE invoice_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    INTEGER REFERENCES users(id),
  note        TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_invoice_events_invoice ON invoice_events(invoice_id, id);

-- One row per billing run, so the team can see what ran, when, and with what result.
CREATE TABLE billing_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of           TEXT NOT NULL,
  auto_confirm    INTEGER NOT NULL DEFAULT 0 CHECK (auto_confirm IN (0, 1)),
  triggered_by    INTEGER REFERENCES users(id),
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at     TEXT,
  due_count       INTEGER NOT NULL DEFAULT 0,
  created_count   INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0
);

-- A subscription period that could not be billed. It stays open, and visible, until a later attempt succeeds.
CREATE TABLE billing_failures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  period_index    INTEGER NOT NULL,
  message         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  first_failed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_failed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_run_id     INTEGER REFERENCES billing_runs(id),
  resolved_at     TEXT,
  UNIQUE (subscription_id, period_index)
);
CREATE INDEX idx_billing_failures_open ON billing_failures(resolved_at);
`;
