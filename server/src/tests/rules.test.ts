// Unit tests for the core business rules. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

import { passwordSchema } from '../lib/password';
import { TRANSITIONS, assertTransition, monthlyValue } from '../services/subscriptions';
import { applyOpenCredits } from '../services/credits';
import { priceSubscription, type SubscriptionForPricing } from '../services/pricing';
import { addPeriod } from '../lib/dates';

test('password must be more than 8 characters with upper, lower and special', () => {
  assert.equal(passwordSchema.safeParse('Abcdef1!').success, false, 'exactly 8 characters is rejected');
  assert.equal(passwordSchema.safeParse('Abcdefg1!').success, true);
  assert.equal(passwordSchema.safeParse('abcdefgh1!').success, false, 'no uppercase');
  assert.equal(passwordSchema.safeParse('ABCDEFGH1!').success, false, 'no lowercase');
  assert.equal(passwordSchema.safeParse('Abcdefgh12').success, false, 'no special character');
});

test('only allowed status transitions pass', () => {
  const plan = { pausable: true, closable: true };
  assert.doesNotThrow(() => assertTransition('DRAFT', 'QUOTATION', plan, null));
  assert.doesNotThrow(() => assertTransition('ACTIVE', 'PAUSED', plan, null));
  assert.throws(() => assertTransition('DRAFT', 'ACTIVE', plan, null), /Cannot move/);
  assert.throws(() => assertTransition('CLOSED', 'ACTIVE', plan, null), /Cannot move/);
  assert.throws(() => assertTransition('ACTIVE', 'PAUSED', { pausable: false, closable: true }, null), /does not allow pausing/);
  assert.deepEqual(TRANSITIONS.CLOSED, []);
});

test('customers cannot close a non-closable plan, staff can', () => {
  const plan = { pausable: false, closable: false };
  const customer = { id: 1, email: 'c@x.com', name: 'C', role: 'CUSTOMER' as const, customerId: 1 };
  const staff = { id: 2, email: 's@x.com', name: 'S', role: 'STAFF' as const, customerId: null };
  assert.throws(() => assertTransition('ACTIVE', 'CLOSED', plan, customer));
  assert.doesNotThrow(() => assertTransition('ACTIVE', 'CLOSED', plan, staff));
});

const tax18 = { id: 1, name: 'GST 18%', rateBp: 1800, isDefault: true, active: true, createdAt: new Date() };

function sub(state: string, lines: { qty: number; price: number; extra?: number }[], planPrice = 0) {
  return {
    customer: { state },
    plan: { name: 'Monthly', price: planPrice },
    lines: lines.map((l, i) => ({
      productId: i + 1,
      quantity: l.qty,
      unitPrice: l.price,
      description: `Product ${i + 1}`,
      product: { taxRule: null },
      variant: l.extra
        ? { name: 'Brand: Odoo', values: [{ attributeValue: { priceExtra: l.extra, value: 'Odoo', attribute: { name: 'Brand' } } }] }
        : null,
    })),
  } as unknown as SubscriptionForPricing;
}

test('variant price extra, tax and explanation', () => {
  const r = priceSubscription(sub('Kerala', [{ qty: 2, price: 50000, extra: 56000 }]), { defaultTax: tax18, discounts: [] });
  assert.equal(r.subtotal, 212000); // 2 × (500 + 560)
  assert.equal(r.taxTotal, 38160); // 18%
  assert.equal(r.total, 250160);
  assert.equal(r.taxSplit, 'INTRA');
  assert.match(r.lines[0].explanation, /Brand Odoo \+₹560\.00/);
  assert.match(r.lines[0].explanation, /CGST 9% \+ SGST 9%/);
});

test('inter-state customer gets IGST', () => {
  const r = priceSubscription(sub('Karnataka', [{ qty: 1, price: 10000 }]), { defaultTax: tax18, discounts: [] });
  assert.equal(r.taxSplit, 'INTER');
  assert.match(r.lines[0].explanation, /IGST 18%/);
});

const baseDiscount = {
  id: 1,
  name: 'Bulk 10%',
  type: 'PERCENT' as const,
  value: 1000,
  scope: 'SUBSCRIPTION' as const,
  minPurchase: 0,
  minQuantity: 10,
  startDate: null,
  endDate: null,
  usageLimit: null,
  usedCount: 0,
  active: true,
  createdAt: new Date(),
  products: [],
};

test('discount applies only when minimum quantity is met', () => {
  const below = priceSubscription(sub('Kerala', [{ qty: 9, price: 10000 }]), { defaultTax: tax18, discounts: [baseDiscount] });
  assert.equal(below.discountTotal, 0);
  const met = priceSubscription(sub('Kerala', [{ qty: 10, price: 10000 }]), { defaultTax: tax18, discounts: [baseDiscount] });
  assert.equal(met.discountTotal, 10000);
  assert.equal(met.total, Math.round((100000 - 10000) * 1.18));
});

test('used-up discount stops applying', () => {
  const usedUp = { ...baseDiscount, usageLimit: 5, usedCount: 5 };
  const r = priceSubscription(sub('Kerala', [{ qty: 10, price: 10000 }]), { defaultTax: tax18, discounts: [usedUp] });
  assert.equal(r.discountTotal, 0);
});

test('fixed discount never makes a line negative', () => {
  const big = { ...baseDiscount, type: 'FIXED' as const, value: 999999, minQuantity: 0 };
  const r = priceSubscription(sub('Kerala', [{ qty: 1, price: 10000 }]), { defaultTax: tax18, discounts: [big] });
  assert.equal(r.total, 0);
});

test('missing tax rule is reported', () => {
  const r = priceSubscription(sub('Kerala', [{ qty: 1, price: 10000 }]), { defaultTax: null, discounts: [] });
  assert.equal(r.missingTax, true);
});

test('monthly value normalises every billing period', () => {
  const lines = [{ quantity: 2, unitPrice: 50000 }];
  assert.equal(monthlyValue({ price: 0, billingPeriod: 'MONTHLY' }, lines), 100000);
  assert.equal(monthlyValue({ price: 0, billingPeriod: 'YEARLY' }, [{ quantity: 1, unitPrice: 1200000 }]), 100000);
  assert.equal(monthlyValue({ price: 0, billingPeriod: 'DAILY' }, [{ quantity: 1, unitPrice: 1000 }]), 30000);
});

test('open credit notes reduce an invoice, oldest first, never below zero', async () => {
  const notes = [
    { id: 1, number: 'CN-000001', reason: 'Outage', total: 11800, taxAmount: 1800, remaining: 11800 },
    { id: 2, number: 'CN-000002', reason: 'Upgrade', total: 50000, taxAmount: 0, remaining: 50000 },
  ];
  const tx = { creditNote: { findMany: async () => notes } } as never;
  const invoice = { lines: [], subtotal: 30000, discountTotal: 0, taxTotal: 5400, total: 35400, taxSplit: 'INTRA' as const, appliedDiscountIds: [], missingTax: false };
  const { priced, used } = await applyOpenCredits(tx, 1, invoice);
  assert.equal(priced.total, 0);
  assert.deepEqual(
    used.map((u) => [u.id, u.amount, u.remaining]),
    [
      [1, 11800, 0],
      [2, 23600, 26400],
    ],
  );
  assert.equal(priced.taxTotal, 5400 - 1800, 'tax on the credit note is reversed');
});

test('billing periods advance correctly', () => {
  const d = new Date(2026, 0, 31);
  assert.equal(addPeriod(d, 'DAILY').getDate(), 1);
  assert.equal(addPeriod(d, 'WEEKLY').getDate(), 7);
  assert.equal(addPeriod(new Date(2026, 0, 15), 'MONTHLY').getMonth(), 1);
  assert.equal(addPeriod(d, 'YEARLY').getFullYear(), 2027);
  const feb = addPeriod(d, 'MONTHLY');
  assert.equal(feb.getMonth(), 1, '31 Jan + 1 month stays in February');
  assert.equal(feb.getDate(), 28);
  assert.equal(addPeriod(new Date(2028, 1, 29), 'YEARLY').getDate(), 28, 'leap day rolls to 28 Feb');
});
