# Brightloop Billing

A subscription management system for Brightloop Software: products and plans, quotations,
subscriptions, recurring invoices, payments and revenue reporting in one place.

> **Status: Stage 1 of 7 - accounts, roles and the app shell.** Catalog, subscriptions, billing,
> payments and the dashboard land in later stages; this README is updated as each one ships.

## What works today

- Sign up (customers only), sign in, sign out, with unique emails and server-enforced password rules
  (more than 8 characters, upper case, lower case, special character).
- Password reset by emailed link: single-use, expiring, stored hashed, never returned by the API. In local
  development the "email" lands in a built-in dev mailbox (`/dev/mailbox`), so no mail provider is needed.
- Three roles enforced on the server: **admin**, **staff**, **customer**. Only admins can add or
  deactivate staff.
- Responsive app shell, team management screen, demo seed.
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

## Project layout

```
server/   Express 5 API, SQLite migrations, tests
client/   React + Vite web app
```
