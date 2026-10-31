# Brightloop Billing

A subscription management system for Brightloop Software: products and plans, quotations,
subscriptions, recurring invoices, payments and revenue reporting in one place.

> **Status: Stage 2 of 7 - accounts and roles, catalog and pricing.** Subscriptions, billing, payments and
> the dashboard land in later stages; this README is updated as each one ships.

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
npm run seed      # creates the demo admin/staff accounts (safe to re-run)
npm run dev       # API on :4000, web app on http://localhost:5173
```

Demo accounts (local only, flagged as demo data in the database, password `Demo#Pass2026`):

| Role  | Email                       |
| ----- | --------------------------- |
| Admin | `admin@brightloop.example`  |
| Staff | `staff@brightloop.example`  |

Create a customer by signing up in the app. To try password reset, use "Forgot password?" and open the
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
