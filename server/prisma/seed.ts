// Demo data: users for each role, catalog, plans, templates and a few subscriptions.
// Run with: npm run db:seed
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { priceSubscription, subscriptionPricingInclude } from '../src/services/pricing';

const prisma = new PrismaClient();
const rs = (r: number) => Math.round(r * 100);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
};

async function main() {
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (existing) {
    console.log('Seed data already present, skipping.');
    return;
  }

  const hash = (p: string) => bcrypt.hash(p, 12);

  await prisma.user.create({ data: { name: 'Admin', email: 'admin@subflow.local', role: 'ADMIN', passwordHash: await hash('Admin@12345') } });
  await prisma.user.create({ data: { name: 'Staff Member', email: 'staff@subflow.local', role: 'STAFF', passwordHash: await hash('Staff@12345') } });

  const gst18 = await prisma.taxRule.create({ data: { name: 'GST 18%', rateBp: 1800, isDefault: true } });
  const gst12 = await prisma.taxRule.create({ data: { name: 'GST 12%', rateBp: 1200 } });

  const crm = await prisma.product.create({
    data: { name: 'CRM Suite', type: 'SERVICE', salesPrice: rs(500), costPrice: rs(120), notes: 'Per seat', taxRuleId: gst18.id },
  });
  const accounting = await prisma.product.create({
    data: { name: 'Accounting', type: 'SERVICE', salesPrice: rs(800), costPrice: rs(200), taxRuleId: gst18.id },
  });
  const support = await prisma.product.create({ data: { name: 'Priority Support', type: 'SERVICE', salesPrice: rs(1500), costPrice: rs(600) } });
  const router = await prisma.product.create({
    data: { name: 'Wi-Fi Router', type: 'GOODS', salesPrice: rs(250), costPrice: rs(150), notes: 'Rental', taxRuleId: gst12.id },
  });

  const brand = await prisma.attribute.create({
    data: {
      name: 'Brand',
      values: { create: [{ value: 'Odoo', priceExtra: rs(560) }, { value: 'Generic', priceExtra: 0 }] },
    },
    include: { values: true },
  });
  const odoo = brand.values.find((v) => v.value === 'Odoo')!;
  const crmOdoo = await prisma.productVariant.create({
    data: { productId: crm.id, name: 'Brand: Odoo', values: { create: [{ attributeValueId: odoo.id }] } },
  });

  const monthly = await prisma.plan.create({
    data: { name: 'Business Monthly', price: rs(999), billingPeriod: 'MONTHLY', minQuantity: 1, pausable: true, closable: true, renewable: true },
  });
  const yearly = await prisma.plan.create({
    data: { name: 'Business Yearly', price: rs(9999), billingPeriod: 'YEARLY', minQuantity: 5, autoClose: true, renewable: true },
  });
  const weekly = await prisma.plan.create({
    data: { name: 'Starter Weekly', price: rs(149), billingPeriod: 'WEEKLY', pausable: true },
  });

  await prisma.quoteTemplate.create({
    data: {
      name: 'Standard CRM package',
      planId: monthly.id,
      validityDays: 15,
      durationDays: 365,
      lines: { create: [{ productId: crm.id, variantId: crmOdoo.id, quantity: 10 }, { productId: support.id, quantity: 1 }] },
    },
  });

  await prisma.discount.create({
    data: { name: 'Bulk 10%', type: 'PERCENT', value: 1000, scope: 'SUBSCRIPTION', minQuantity: 10 },
  });
  await prisma.discount.create({
    data: {
      name: 'Accounting launch offer',
      type: 'FIXED',
      value: rs(100),
      scope: 'PRODUCTS',
      endDate: new Date(Date.now() + 5 * 86_400_000),
      usageLimit: 100,
      products: { create: [{ productId: accounting.id }] },
    },
  });

  const customers = [
    { name: 'Acme Traders', email: 'acme@example.com', state: 'Kerala', gstin: '32ABCDE1234F1Z5' },
    { name: 'Blue River Foods', email: 'bluriver@example.com', state: 'Karnataka', gstin: '29ABCDE1234F1Z5' },
    { name: 'Nova Clinics', email: 'nova@example.com', state: 'Kerala' },
  ];
  const created = [];
  for (const c of customers) created.push(await prisma.customer.create({ data: c }));

  // Portal login for the first customer.
  await prisma.user.create({
    data: { name: 'Acme Traders', email: 'acme@example.com', role: 'CUSTOMER', customerId: created[0].id, passwordHash: await hash('Customer@123') },
  });

  let n = 0;
  const num = () => `SUB-${String(++n).padStart(6, '0')}`;
  const sub = (data: Parameters<typeof prisma.subscription.create>[0]['data']) => prisma.subscription.create({ data });

  await sub({
    number: num(),
    customerId: created[0].id,
    planId: monthly.id,
    status: 'ACTIVE',
    startDate: daysAgo(30),
    nextBillingDate: daysAgo(0),
    expiryDate: daysAgo(-335),
    acceptedAt: daysAgo(31),
    lines: {
      create: [
        { productId: crm.id, variantId: crmOdoo.id, description: crm.name, quantity: 10, unitPrice: crm.salesPrice },
        { productId: support.id, description: support.name, quantity: 1, unitPrice: support.salesPrice },
      ],
    },
    events: { create: [{ type: 'STATUS', fromStatus: 'CONFIRMED', toStatus: 'ACTIVE', message: 'Subscription activated', actorName: 'Admin (admin)' }] },
  });
  await sub({
    number: num(),
    customerId: created[1].id,
    planId: yearly.id,
    status: 'ACTIVE',
    startDate: daysAgo(340),
    nextBillingDate: daysAgo(-25),
    expiryDate: daysAgo(-25),
    lines: { create: [{ productId: accounting.id, description: accounting.name, quantity: 5, unitPrice: accounting.salesPrice }] },
  });
  await sub({
    number: num(),
    customerId: created[2].id,
    planId: weekly.id,
    status: 'ACTIVE',
    startDate: daysAgo(14),
    nextBillingDate: daysAgo(0),
    lines: { create: [{ productId: router.id, description: router.name, quantity: 2, unitPrice: router.salesPrice }] },
  });
  await sub({
    number: num(),
    customerId: created[0].id,
    planId: monthly.id,
    status: 'DRAFT',
    lines: { create: [{ productId: accounting.id, description: accounting.name, quantity: 3, unitPrice: accounting.salesPrice }] },
  });
  await prisma.counter.upsert({ where: { key: 'SUB' }, update: { value: n }, create: { key: 'SUB', value: n } });

  // Invoice history for the demo customer: two paid months and one overdue.
  const acmeSub = await prisma.subscription.findFirstOrThrow({ where: { customerId: created[0].id, status: 'ACTIVE' }, include: subscriptionPricingInclude });
  const priced = priceSubscription(acmeSub, { defaultTax: gst18, discounts: [] });
  const history = [
    { monthsAgo: 3, paid: true },
    { monthsAgo: 2, paid: true },
    { monthsAgo: 1, paid: false },
  ];
  let inv = 0;
  for (const h of history) {
    const start = daysAgo(30 * h.monthsAgo);
    const issued = new Date(start);
    const invoice = await prisma.invoice.create({
      data: {
        number: `INV-${String(++inv).padStart(6, '0')}`,
        subscriptionId: acmeSub.id,
        customerId: acmeSub.customerId,
        status: h.paid ? 'PAID' : 'CONFIRMED',
        periodStart: start,
        periodEnd: daysAgo(30 * h.monthsAgo - 29),
        issueDate: issued,
        dueDate: daysAgo(30 * h.monthsAgo - 15),
        subtotal: priced.subtotal,
        discountTotal: priced.discountTotal,
        taxTotal: priced.taxTotal,
        total: priced.total,
        amountPaid: h.paid ? priced.total : 0,
        confirmedAt: issued,
        lines: { create: priced.lines },
      },
    });
    if (h.paid) {
      await prisma.payment.create({
        data: { invoiceId: invoice.id, amount: priced.total, method: 'UPI', paidAt: daysAgo(30 * h.monthsAgo - 5), reference: `UPI${100200 + inv}` },
      });
    }
  }
  await prisma.counter.upsert({ where: { key: 'INV' }, update: { value: inv }, create: { key: 'INV', value: inv } });

  console.log('Seeded. Logins: admin@subflow.local / Admin@12345, staff@subflow.local / Staff@12345, acme@example.com / Customer@123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
