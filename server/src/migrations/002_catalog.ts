export const id = '002_catalog';

// Money is stored as INTEGER minor units (e.g. paise/cents). Percentages are INTEGER basis points
// (18% = 1800). Dates are 'YYYY-MM-DD' strings. This keeps every total exact.
export const sql = `
CREATE TABLE taxes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  rate_bp    INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo    INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- At most one tax is the default applied to products that name no tax of their own.
CREATE UNIQUE INDEX idx_taxes_single_default ON taxes(is_default) WHERE is_default = 1;

CREATE TABLE products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL COLLATE NOCASE UNIQUE,
  type              TEXT NOT NULL CHECK (type IN ('software', 'add_on', 'service', 'goods')),
  sales_price_minor INTEGER NOT NULL CHECK (sales_price_minor >= 0),
  cost_price_minor  INTEGER NOT NULL CHECK (cost_price_minor >= 0),
  tax_id            INTEGER REFERENCES taxes(id),
  notes             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo           INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_products_type ON products(type, is_active);

-- One row is one selectable option, e.g. attribute 'Brand', value 'Odoo', +560 on the product price.
CREATE TABLE product_variants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attribute         TEXT NOT NULL COLLATE NOCASE,
  value             TEXT NOT NULL COLLATE NOCASE,
  extra_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (extra_price_minor >= 0),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (product_id, attribute, value)
);

CREATE TABLE plans (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description       TEXT,
  price_minor       INTEGER NOT NULL CHECK (price_minor >= 0),
  billing_period    TEXT NOT NULL CHECK (billing_period IN ('daily', 'weekly', 'monthly', 'yearly')),
  min_quantity      INTEGER NOT NULL DEFAULT 1 CHECK (min_quantity >= 1),
  available_from    TEXT NOT NULL,
  available_to      TEXT,
  auto_close        INTEGER NOT NULL DEFAULT 0 CHECK (auto_close IN (0, 1)),
  allow_early_close INTEGER NOT NULL DEFAULT 0 CHECK (allow_early_close IN (0, 1)),
  allow_pause       INTEGER NOT NULL DEFAULT 0 CHECK (allow_pause IN (0, 1)),
  allow_renewal     INTEGER NOT NULL DEFAULT 0 CHECK (allow_renewal IN (0, 1)),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo           INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (available_to IS NULL OR available_to >= available_from)
);

CREATE TABLE discounts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind               TEXT NOT NULL CHECK (kind IN ('fixed', 'percent')),
  -- minor units when kind = 'fixed', basis points when kind = 'percent'
  value              INTEGER NOT NULL CHECK (value > 0),
  scope              TEXT NOT NULL CHECK (scope IN ('products', 'subscription')),
  min_purchase_minor INTEGER NOT NULL DEFAULT 0 CHECK (min_purchase_minor >= 0),
  min_quantity       INTEGER NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  start_date         TEXT NOT NULL,
  end_date           TEXT,
  usage_limit        INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  usage_count        INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo            INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (kind = 'fixed' OR value <= 10000)
);

CREATE TABLE discount_products (
  discount_id INTEGER NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (discount_id, product_id)
);
CREATE INDEX idx_discount_products_product ON discount_products(product_id);
`;
