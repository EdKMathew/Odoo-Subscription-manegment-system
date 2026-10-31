# Odoo-Subscription-manegment-system

A subscription management system for recurring billing: plans, quotations, subscriptions, invoices, payments and reports, with a customer portal.

> Work in progress.

## Tech stack

- **Backend:** Node.js, TypeScript, Express
- **Database:** PostgreSQL with Prisma ORM
- **Frontend:** React, Vite, Tailwind CSS

## Getting started

### Prerequisites
- Node.js 20+
- PostgreSQL 15+

### Backend setup
```bash
cd server
npm install
cp .env.example .env   # then fill in your database password and a JWT secret
npx prisma migrate dev
npm run dev
```

The API runs on `http://localhost:4000`.

## Team

- Anirudh
- Edwin
- Advaith
- Rahul
