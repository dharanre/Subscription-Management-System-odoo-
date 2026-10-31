# Brightloop Billing

A subscription management system for Brightloop Software: products and plans, quotations,
subscriptions, recurring invoices, payments and revenue reporting in one place.

> **Status: Stage 7 of 7 - complete.** Accounts, catalog and pricing, quotations, the subscription lifecycle, recurring
> billing, payments, the customer portal home and the live finance dashboard, now with lint, end-to-end browser tests
> and continuous integration.

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
- **Payments and receivables:**
  - Staff record a payment against an invoice with its **method** (bank transfer, UPI, card, cheque, cash, other),
    **amount**, **date received**, a reference and a note. The invoice updates at once: part payments keep it open,
    and it becomes **Paid** when the payments cover it.
  - Paying more than is owing is refused, as is a payment dated in the future or before the invoice was issued, or
    against a draft, cancelled or already-paid invoice. An invoice's paid amount always equals its recorded
    payments, and a database constraint stops it ever exceeding the total.
  - A retried request (a double click, a dropped connection) is answered with the payment it already made instead of
    recording it twice. A mistaken payment is **voided** with a reason, never deleted: it stays on record and the
    invoice owes the money again.
  - **Receivables** shows what is owed, aged by how late it is (not yet due, 1-30, 31-60, 61-90, 90+ days), the
    overdue invoices longest first, and a one-click *Remind* (re-sends the invoice worded as an overdue reminder) or
    *Record payment* for each. The **Payments** list filters by method, date, customer or reference and totals what
    the filter adds up to.

- **Finance dashboard (admin and staff):** the home screen for the team, worked out from the database on every
  request, never cached or hard-coded.
  - A **period picker** (last 30 days, this or last month, 90 or 180 days, year to date, or any custom range of up
    to three years) drives every figure on the page. Impossible ranges are explained, not silently ignored.
  - Tiles: active subscriptions, **recurring revenue** (MRR, with ARR beneath it), collected in the period, still
    owed, and overdue. *Recurring revenue* is every active subscription's list price per period before tax and
    discount, converted to a month (weekly x 52/12, yearly / 12, daily x 365/12). Paused and closed ones are not
    counted. The tile says so.
  - **Needs attention** chips link straight to the work: subscriptions due for billing, billing failures, draft
    invoices, subscriptions expiring soon, expired quotations.
  - A chart of invoiced against collected (per day for ranges up to 45 days, per month beyond), a subscription
    status mix, and tabbed lists of subscriptions, invoices and payments that filter and page on the server.
  - It **refreshes itself** every 15 seconds and when the tab regains focus, and shows when it was last updated.
    Record a payment or run billing in another window and the tiles move without a reload.
- **Customer portal home:** a customer sees where they stand: what they owe, what is overdue, the next invoice due
  (or "all paid up"), their subscriptions, recent invoices and recent payments. Everything is scoped on the server
  from the signed-in account, so there is no customer id to tamper with. It also refreshes on its own.

### Billing rules worth knowing

- Billed **in advance**, one invoice per period, on or after the period's start date. Nothing is pro-rated: a final
  short period is billed in full.
- Paused subscriptions are not billed. Periods that start *while paused* are skipped on resume, and the
  subscription's history says how many. Pausing or closing is refused while invoices are due ("run billing first"),
  so revenue cannot be dropped by accident. Plans that close themselves wait until their last invoices are issued.
- Cancelling an invoice keeps its period accounted for, so billing does not quietly invoice it again.
- Sending an invoice only emails it. **No payment is ever charged**: no payment provider is connected, and payments
  are recorded by staff. A payment entry means money has already arrived; it never moves any.

### How prices are calculated

All money is stored as integer minor units (paise/cents) and rates as basis points, so totals are exact. The API
accepts and returns plain decimals with at most 2 decimal places and rejects anything finer instead of rounding it.

1. Line subtotal = quantity x unit price, where unit price = product price + the chosen variant's extra.
2. One discount (the one saving the most among those that qualify) is taken off the lines it covers, shared in
   proportion to their subtotals so no minor unit is lost.
3. Tax is charged on each line's discounted amount and rounded half up *per line*.
4. Totals are plain sums of the lines, so an invoice always equals the sum of its lines.

## Performance

The target is every page under 2 seconds with thousands of subscriptions. It was measured, not assumed:

```bash
npm run seed:load -w server -- --subscriptions=5000   # writes server/data/load.db (git-ignored)
npm run bench -w server -- --runs=7 --budget=2000     # add --db=<file> to use another database
```

`seed:load` refuses to run when `NODE_ENV=production`, and without `--db` it never touches the development database.

- **Data:** a realistic database built through the same service code the API uses: 5,000 subscriptions across all
  six plans and every lifecycle state, 2,000 customers, 11,312 invoices, 9,293 payments (some partial, some overdue)
  and 30,260 history events. One customer holds 200 subscriptions, to check the portal at its heaviest. Generation
  is seeded, so the same size gives the same data.
- **API, `bench`:** starts the real application against that file and times 38 calls behind the screens (dashboard,
  every list with filters, search, paging, detail pages, receivables, billing, the customer portal), as staff and as
  the busiest customer, 7 runs each. It exits with an error if any call's slowest run is over the budget. Slowest
  call: the dashboard over six months, **100-145 ms** across runs; the median of every other call is 10-31 ms. About
  15 ms of each figure is the benchmark's own per-request cost, so treat the small numbers as a floor.
- **Browser, real Edge, headless:** 18 pages from the start of navigation until the page's real content (its table or
  chart) is on screen, 5 loads each, in several complete passes. Page medians were **370-530 ms**; the slowest single
  load in any complete pass was **671 ms**. Staff dashboard: about 530 ms.
- **What this does not show:** the browser and the server ran on the same laptop, so there was no network latency; the
  database was warm and on a local disk; one user at a time. A remote user adds their own round-trip time, and a
  database many times this size would need new measurements.
- **How it stays fast:** every list is paged and filtered in SQL, never in memory; the dashboard totals are
  aggregate queries computed in SQL; migration `006_dashboard` adds the indexes the dashboard and customer lists lean on; and the
  database runs with `synchronous = NORMAL` under WAL, which keeps commits durable against an application crash but
  can lose the last moments of writes if the operating system itself crashes. That is the usual WAL trade-off.
  `npm run bench` exits with an error if any call exceeds the budget, so a regression is visible.

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
| `npm run seed:load -w server -- --subscriptions=5000` | Generate a large demo dataset in `server/data/load.db`, never the development database (see *Performance*) |
| `npm run bench -w server` | Time every API call the screens make against `load.db` (`--db=<file>` to choose another) |
| `npm test`          | Server test suite (Vitest + Supertest, in-memory DB) |
| `npm run e2e`       | Build the app, then drive it in a real browser (see *Checks*) |
| `npm run lint`      | ESLint over server, client and end-to-end tests      |
| `npm run typecheck` | Type-check server, client and end-to-end tests       |
| `npm run build`     | Production build of the web app                      |
| `npm start`         | Build the web app, then serve everything from :4000  |

### Checks

`npm run lint`, `npm run typecheck`, `npm test` and `npm run e2e` all run on every push and pull request
(GitHub Actions, `.github/workflows/ci.yml`).

The end-to-end tests (`e2e/`, Playwright) use the production build in a real browser against the real API. Each run
creates and seeds a brand-new database in `e2e/.data/` and serves it on port 4317 (`E2E_PORT` to change it), so
nothing of yours is touched and a copy of the app you are running is never disturbed. They cover signing up, in and
out; what each role can and cannot reach, including the server refusing a customer who bypasses the screens;
one customer's whole journey (signs up, is sold a subscription, is billed, sees what they owe, is paid, and both the
customer's overview and finance's dashboard follow); the dashboard's period, chart, links and live refresh; and every
screen on a laptop and a phone, failing on any script error, refused API call or sideways scrolling; and that the
side menu stays inside its panel on a short window.

The first time, install a browser for Playwright with `npx playwright install chromium`, or use the Chrome you
already have: `E2E_CHANNEL=chrome npm run e2e`.

## Configuration

Copy `server/.env.example` to `server/.env` to override defaults. There are no third-party keys or secrets.
The SQLite file lives in `server/data/` (git-ignored).

Amounts are shown in `CURRENCY` (default `INR`, formatted with `LOCALE`, default `en-IN`). This only changes
how numbers are displayed; stored amounts are plain numbers and are never converted.

## Known issues

- **Dependency advisories.** `npm audit --omit=dev`, which covers what is deployed, reports none. `npm audit` on the
  whole tree still lists advisories in development tools (Vitest, ESLint) that only ever run on this repository's own
  code, never in the deployed app; clearing them means major upgrades of those tools.
- **No payment provider.** Payments are recorded by staff; nothing is ever charged (see *Billing rules*).

## Project layout

```
server/   Express 5 API, SQLite migrations, tests
client/   React + Vite web app
e2e/      Playwright browser tests (config in playwright.config.ts)
```
