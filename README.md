# Brightloop Billing

A subscription management system for Brightloop Software: products and plans, quotations,
subscriptions, recurring invoices, payments and revenue reporting in one place.

> **Status: Stage 4 of 7 - accounts, catalog and pricing, quotations, the subscription lifecycle and recurring
> billing.** Payments and the finance dashboard land in later stages; this README is updated as each one ships.

## What works today

- Sign up (customers only), sign in, sign out, with unique emails and server-enforced password rules
  (more than 8 characters, upper case, lower case, special character).
- Password reset by emailed link: single-use, expiring, stored hashed, never returned by the API. In local
  development the "email" lands in a built-in dev mailbox (`/dev/mailbox`), so no mail provider is needed.
- Three roles enforced on the server: **admin**, **staff**, **customer**. Only admins can add or
  deactivate staff.
- Responsive app shell, team management screen, demo seed.
- **Catalog and pricing (admin writes, staff read):**
  - Products with type, sales price, cost price, notes and tax, plus variants that add to the price
    (for example *Brand: Odoo* adds 560).
  - Plans billed daily, weekly, monthly or yearly, with a minimum quantity, an availability window and the
    lifecycle options the admin allows per plan: close automatically, close early, pause, renew.
  - Tax rules: each product can name its tax, otherwise the single default tax applies.
  - Discount rules (admin only): fixed amount or percentage, minimum purchase and/or quantity, start and end
    dates, a usage limit, and scope of specific products or the whole subscription. Status
    (active, scheduled, expired, used up, switched off) is derived from dates and usage.
  - A **price calculator** that shows exactly how a total is made up, and why each discount does or does not
    qualify. It runs the same pricing engine that later prices quotations and invoices.
- **Quotations and subscriptions:**
  - Quotation templates (plan, product lines, payment terms, how many days a quotation stays valid). A sales
    rep starts from one, or builds the quotation line by line, and sees the price update live.
  - Every subscription gets its own number (`SUB-00001`), a customer, a plan, start and expiry dates, payment
    terms and priced lines (product, quantity, unit price, tax, amount). Prices are a snapshot taken when the
    line is saved, so a later catalog change never alters an existing quotation.
  - Lifecycle **Draft -> Quotation -> Confirmed -> Active -> Closed**, enforced by the API (anything out of
    order is refused with the reason). Where the plan allows it: pause and resume, close early, renew for
    another term. Plans marked *close automatically* close themselves once their expiry date passes.
  - A quotation expires after its validity period and can no longer be confirmed. Only drafts can be edited.
  - A full history of who did what and when is kept on every subscription.
  - Customers see only their own subscriptions in the portal and can confirm, pause, close early or renew them
    where the plan permits. Anything else about another customer's record answers "not found".
- **Recurring billing and invoices:**
  - *Billing day* creates an invoice for every active subscription whose next billing period has started: customer
    details, lines, tax, the best qualifying discount and totals are filled in from saved data, nobody types
    anything. Invoices start as drafts (or are confirmed on creation if you tick the box) and carry their own number.
  - **Nothing is billed twice**: each invoice is keyed by (subscription, billing period) with a database `UNIQUE`
    constraint, and is created in the same transaction that moves the subscription to its next period. Running
    billing again, or two runs at once, creates nothing extra.
  - **Nothing is skipped**: a subscription that is behind is caught up, one invoice per missed period, in order. One
    that cannot be billed is recorded as a failure, shown under *Needs attention* with the reason, and tried again by
    every later run or by *Retry*. A later period is never billed ahead of an earlier failed one.
  - **Discounts apply on their own**: the best qualifying discount appears on the next invoice, uses one of its
    allowed uses (atomically, so a limit is never exceeded), and stops when it expires or runs out. A failed attempt
    uses nothing up.
  - Invoice states **Draft -> Confirmed -> Paid** (plus Cancelled); staff can confirm, send (emails the customer),
    cancel and print any invoice. Overdue invoices (confirmed, past due, still owing) are flagged and filterable.
  - Customers see their own confirmed and paid invoices in the portal, never drafts or anyone else's.

### Billing rules worth knowing

- Billed **in advance**, one invoice per period, on or after the period's start date. Nothing is pro-rated: a final
  short period is billed in full.
- Paused subscriptions are not billed. Periods that start *while paused* are skipped on resume, and the
  subscription's history says how many. Pausing or closing is refused while invoices are due ("run billing first"),
  so revenue cannot be dropped by accident. Plans that close themselves wait until their last invoices are issued.
- Cancelling an invoice keeps its period accounted for, so billing does not quietly invoice it again.
- Sending an invoice only emails it. **No payment is ever charged**: no payment provider is connected, and payments
  are recorded by staff (next stage).

### How prices are calculated

All money is stored as integer minor units (paise/cents) and rates as basis points, so totals are exact. The API
accepts and returns plain decimals with at most 2 decimal places and rejects anything finer instead of rounding it.

1. Line subtotal = quantity x unit price, where unit price = product price + the chosen variant's extra.
2. One discount (the one saving the most among those that qualify) is taken off the lines it covers, shared in
   proportion to their subtotals so no minor unit is lost.
3. Tax is charged on each line's discounted amount and rounded half up *per line*.
4. Totals are plain sums of the lines, so an invoice always equals the sum of its lines.

## Requirements

- Node.js **22.13 or newer** (developed on 24). The database is SQLite through Node's built-in
  `node:sqlite`, so there is nothing native to compile and no database server to install.

## Run it locally

```bash
npm install
npm run seed      # creates the demo accounts, catalog, customers and subscriptions (safe to re-run)
npm run dev       # API on :4000, web app on http://localhost:5173
```

Demo accounts (local only, flagged as demo data in the database, password `Demo#Pass2026`):

| Role  | Email                       |
| ----- | --------------------------- |
| Admin | `admin@brightloop.example`  |
| Staff | `staff@brightloop.example`  |
| Customer (portal) | `customer@brightloop.example` |

The demo data includes subscriptions in every lifecycle state, including one that closed itself at plan end
and one whose quotation has expired. You can also create a customer by signing up in the app. To try password reset, use "Forgot password?" and open the
**Dev mailbox** (admin sidebar) or `http://localhost:5173/dev/mailbox`.

The seed command refuses to run when `NODE_ENV=production`.

## Commands

| Command             | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | API and web app with reload                          |
| `npm run seed`      | Create demo records (idempotent)                     |
| `npm test`          | Server test suite (Vitest + Supertest, in-memory DB) |
| `npm run typecheck` | Type-check server and client                         |
| `npm run build`     | Production build of the web app                      |
| `npm start`         | Build the web app, then serve everything from :4000  |

## Configuration

Copy `server/.env.example` to `server/.env` to override defaults. There are no third-party keys or secrets.
The SQLite file lives in `server/data/` (git-ignored).

Amounts are shown in `CURRENCY` (default `INR`, formatted with `LOCALE`, default `en-IN`). This only changes
how numbers are displayed; stored amounts are plain numbers and are never converted.

## Project layout

```
server/   Express 5 API, SQLite migrations, tests
client/   React + Vite web app
```
