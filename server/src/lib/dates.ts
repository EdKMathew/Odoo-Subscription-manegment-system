import type { BillingPeriod } from '@prisma/client';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

export function addPeriod(d: Date, period: BillingPeriod, count = 1): Date {
  const x = new Date(d);
  switch (period) {
    case 'DAILY':
      x.setDate(x.getDate() + count);
      break;
    case 'WEEKLY':
      x.setDate(x.getDate() + 7 * count);
      break;
    case 'MONTHLY':
      x.setMonth(x.getMonth() + count);
      break;
    case 'YEARLY':
      x.setFullYear(x.getFullYear() + count);
      break;
  }
  return x;
}

// Factor to convert one billing period's amount to a monthly figure (for MRR).
export const monthlyFactor: Record<BillingPeriod, number> = {
  DAILY: 30,
  WEEKLY: 52 / 12,
  MONTHLY: 1,
  YEARLY: 1 / 12,
};

export const daysBetween = (a: Date, b: Date) => Math.floor((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
