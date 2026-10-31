export const id = '005_payments';

export const sql = `
-- A payment records money the company has actually received and entered by hand. Nothing here talks to a
-- payment provider, so nothing is ever charged by this system.
CREATE TABLE payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method       TEXT NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'cheque', 'card', 'upi', 'other')),
  paid_on      TEXT NOT NULL,
  reference    TEXT,
  note         TEXT,
  -- Lets a client safely retry a request (a double click, a dropped connection) without recording it twice.
  request_id   TEXT UNIQUE,
  status       TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'voided')),
  recorded_by  INTEGER REFERENCES users(id),
  voided_at    TEXT,
  voided_by    INTEGER REFERENCES users(id),
  void_reason  TEXT,
  is_demo      INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (status <> 'voided' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX idx_payments_invoice ON payments(invoice_id, status);
CREATE INDEX idx_payments_paid_on ON payments(status, paid_on);
CREATE INDEX idx_payments_customer ON payments(customer_id, paid_on);
`;
