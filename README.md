# Odoo-Subscription-manegment-system

**SubFlow** is a subscription management system for recurring billing. It covers the full cycle from quotation to subscription, scheduled invoicing, payments and reporting, with a self-service customer portal.



## Features

### Core
- **Accounts and roles:** signup, login, password reset by single-use expiring link. Three roles (Admin, Staff, Customer), all enforced on the server.
- **Catalog:** products with sales and cost price, variants built from attributes with price extras (e.g. Brand: Odoo +₹560), plans with billing period, minimum quantity, availability dates and rules (pausable, closable, renewable, auto-close).
- **Quotations and subscriptions:** quotation templates, auto-numbered subscriptions, and a strict status flow: Draft → Quotation → Confirmed → Active → Closed, with Paused where the plan allows it.
- **Taxes and discounts:** admin-defined tax rules applied to every line automatically; fixed or percentage discounts with minimums, date ranges, usage limits and product or subscription scope.
- **Billing run:** a nightly job creates invoices for due subscriptions with lines, tax and discounts filled in, then moves the next billing date forward and handles expiry.
- **Invoices and payments:** Draft → Confirmed → Paid / Cancelled, PDF download, partial payments, due dates from payment terms, and Paid / Outstanding / Overdue status.
- **Customer portal:** a customer's own subscriptions, invoices, payments and downloads.
- **Reports:** active subscriptions, revenue collected, amount outstanding and overdue invoices, with date filters.

### Extras
- **Dry-run billing preview:** see "N invoices, ₹X, M flagged" before anything is created. Flags zero-amount invoices, missing tax, amount jumps over 30% and discounts about to expire.
- **No double billing:** a unique constraint on (subscription, period start) makes it impossible at the database level.
- **Explainable invoices:** every line reads like "10 × ₹500.00 · Brand Odoo +₹560.00 · Bulk 10% −10% · CGST 9% + SGST 9%", with a "Why this amount?" toggle.
- **GST-aware tax:** CGST + SGST within the state, IGST across states, based on the customer's state and GSTIN.
- **E-invoice ready:** B2B invoices export as JSON in the GST e-invoice (IRN) schema shape, ready to upload to the Invoice Registration Portal. The portal itself is not integrated.
- **Next bill card and pre-debit notice:** the portal shows the next billing date and estimated amount; an advance notice is emailed with merchant, amount, date, reference and reason.
- **Pause or downgrade before cancel:** customers who click Cancel are offered a pause (keeping their pricing) or a smaller plan, with the reason captured. The real cancel stays one click away.
- **Dunning ladder:** reminders 3 days before due, on the due date, then at +3 and +7 days overdue. After a grace period (14 days overdue) the subscription is **suspended, not closed**, and it resumes automatically the moment the overdue invoice is paid.
- **Collections dashboard:** revenue at risk from unpaid invoices, recovery rate (overdue invoices paid after reminders) and suspended accounts.
- **Plan upgrades and downgrades:** upgrades start immediately, with the unused part of the current period returned as a credit note; downgrades are scheduled for the next billing date. The money is previewed before confirming. Customers can downgrade themselves from the portal.
- **Credit notes:** confirmed invoices are never edited. Corrections and upgrade credits become credit notes that are deducted from the next invoice automatically, with GST reversed correctly.
- **Bank statement matching:** upload a CSV and match credits to open invoices by invoice number, amount and customer name, with a confidence score for staff to approve.
- **Renewal radar:** subscriptions expiring in the next 7, 30 or 60 days. Renewal drafts are created automatically every night for anything expiring within 30 days.
- **MRR and AR aging:** monthly recurring revenue across billing periods, and overdue amounts in 0–30, 31–60, 61–90 and 90+ day buckets.
- **Discount impact preview:** "applies to 84 subscriptions, −₹32k per cycle" before a discount goes live.
- **Subscription timeline:** every status change, invoice and payment, with who did it and when.
- **Quick search (Ctrl+K)** across subscriptions, invoices and customers.
- **Live response time badge** to show query speed with 10,000+ subscriptions.
- **Mid-cycle changes with proration:** adding seats charges only the days left in the period, with the math shown before confirming; reductions apply from the next billing date.
- **At-risk customers:** rule-based flags for overdue invoices, ignored reminders, pauses and recent cancellations.
- **MRR movement:** every status, seat and plan change records its effect on monthly revenue, giving a breakdown of new, expansion, contraction, reactivation, pauses, and voluntary versus involuntary churn.

## Performance

Seeded with 10,000 subscriptions (and ~6,700 invoices), list pages, search and reports respond in 10–30 ms on a laptop. This comes from server-side pagination, indexes on `(status, next_billing_date)`, `customer_id`, `(status, due_date)`, and totals computed with SQL aggregates.

## Tech stack

- **Backend:** Node.js, TypeScript, Express, Zod
- **Database:** PostgreSQL with Prisma ORM
- **Frontend:** React, Vite, Tailwind CSS
- **Other:** node-cron (scheduler), PDFKit (invoices)

## Getting started

### Prerequisites
- Node.js 20+
- PostgreSQL 15+

### Backend
```bash
cd server
npm install
cp .env.example .env      # set your database password and a long random JWT_SECRET
npx prisma migrate dev    # creates the database and tables
npm run db:seed           # demo users, catalog and subscriptions
npm run db:seed:bulk      # optional: 10,000 subscriptions for load testing
npm run dev
```
The API runs on `http://localhost:4000`.

### Frontend
```bash
cd client
npm install
npm run dev
```
Open `http://localhost:5173`. The dev server proxies `/api` to the backend.

### Tests
```bash
cd server
npm test
```
Covers the password rule, allowed status transitions, plan rules, variant price extras, discounts, GST split, credit notes, MRR normalisation and billing period dates.

### Production
```bash
cd client && npm run build
cd ../server && NODE_ENV=production npm start
```
In production the API also serves the built frontend from the same origin on port 4000, and cookies are marked Secure.

### Demo logins (local seed data only)
| Role | Email | Password |
|---|---|---|
| Admin | admin@subflow.local | Admin@12345 |
| Staff | staff@subflow.local | Staff@12345 |
| Customer | acme@example.com | Customer@123 |

## Security

- Passwords hashed with bcrypt; must be more than 8 characters with upper case, lower case and a special character.
- Sessions in an httpOnly, SameSite=Strict cookie; sessions end when the password is reset.
- Password reset and invite links are random tokens stored only as SHA-256 hashes, expire, and work once.
- Every route checks the role on the server; customers can only read their own records.
- Input validated with Zod; all SQL through Prisma or parameterised queries.
- Rate limiting on login, signup and reset; Helmet security headers; JSON-only requests to block cross-site form posts.
- Emails go to an outbox table (no external mail service); password links in it are hidden from staff.

## Team

- Anirudh
- Edwin
- Advaith
- Rahul
