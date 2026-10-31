export const id = '006_dashboard';

export const sql = `
-- The dashboard counts activations and closures in a date range; this keeps that fast as history grows.
CREATE INDEX idx_subscription_events_action ON subscription_events(action, at);
-- Showing a customer their own invoices and payments is done by customer, newest first.
CREATE INDEX idx_invoices_customer_issue ON invoices(customer_id, issue_date);
CREATE INDEX idx_payments_customer_paid ON payments(customer_id, status, paid_on);
`;
