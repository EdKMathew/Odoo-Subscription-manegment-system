// Load test data: ~10,000 subscriptions with invoices and payments, to prove
// list pages and reports stay under 2 seconds. Run after the demo seed:
//   npm run db:seed:bulk
import { PrismaClient, Prisma } from '@prisma/client';
import { monthlyValue } from '../src/services/subscriptions';

const prisma = new PrismaClient();
const COUNT = Number(process.env.BULK_COUNT ?? 10000);
const states = ['Kerala', 'Karnataka', 'Tamil Nadu', 'Maharashtra', 'Delhi'];
const statuses = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'PAUSED', 'CLOSED', 'DRAFT', 'QUOTATION', 'CONFIRMED'] as const;

const day = 86_400_000;
const today = new Date();
today.setHours(0, 0, 0, 0);
const rand = (n: number) => Math.floor(Math.random() * n);

async function main() {
  const plans = await prisma.plan.findMany();
  const products = await prisma.product.findMany();
  if (!plans.length || !products.length) throw new Error('Run the demo seed first (npm run db:seed)');

  const existing = await prisma.customer.count({ where: { email: { endsWith: '@bulk.test' } } });
  if (existing) {
    console.log('Bulk data already present, skipping.');
    return;
  }

  console.time('bulk seed');
  const customerCount = Math.ceil(COUNT / 3);
  await prisma.customer.createMany({
    data: Array.from({ length: customerCount }, (_, i) => ({
      name: `Customer ${String(i + 1).padStart(5, '0')}`,
      email: `customer${i + 1}@bulk.test`,
      state: states[i % states.length],
    })),
  });
  const customers = await prisma.customer.findMany({ where: { email: { endsWith: '@bulk.test' } }, select: { id: true } });

  const counter = await prisma.counter.findUnique({ where: { key: 'SUB' } });
  let subNo = counter?.value ?? 0;
  const invCounter = await prisma.counter.findUnique({ where: { key: 'INV' } });
  let invNo = invCounter?.value ?? 0;

  const BATCH = 1000;
  for (let start = 0; start < COUNT; start += BATCH) {
    const size = Math.min(BATCH, COUNT - start);
    const subs: Prisma.SubscriptionCreateManyInput[] = [];
    for (let i = 0; i < size; i++) {
      const status = statuses[rand(statuses.length)];
      const startDate = new Date(today.getTime() - rand(400) * day);
      const live = status === 'ACTIVE' || status === 'PAUSED';
      subs.push({
        number: `SUB-${String(++subNo).padStart(6, '0')}`,
        customerId: customers[rand(customers.length)].id,
        planId: plans[rand(plans.length)].id,
        status,
        startDate: status === 'DRAFT' || status === 'QUOTATION' ? null : startDate,
        expiryDate: rand(3) === 0 ? new Date(today.getTime() + rand(90) * day) : null,
        // Most bulk subscriptions are billed up to date so the billing run stays small.
        nextBillingDate: live ? new Date(today.getTime() + (1 + rand(30)) * day) : null,
        paymentTermDays: 15,
        closedAt: status === 'CLOSED' ? new Date(today.getTime() - rand(60) * day) : null,
      });
    }
    await prisma.subscription.createMany({ data: subs });
    const created = await prisma.subscription.findMany({
      where: { number: { in: subs.map((s) => s.number) } },
      select: { id: true, customerId: true, status: true, startDate: true },
    });

    const lines: Prisma.SubscriptionLineCreateManyInput[] = created.map((s) => {
      const p = products[rand(products.length)];
      return { subscriptionId: s.id, productId: p.id, description: p.name, quantity: 1 + rand(10), unitPrice: p.salesPrice };
    });
    await prisma.subscriptionLine.createMany({ data: lines });

    // MRR history so the movement report has something to show: activations,
    // closures, pauses and some seat expansions and contractions.
    const planOf = new Map(subs.map((s) => [s.number, plans.find((p) => p.id === s.planId)!]));
    const numberOf = new Map((await prisma.subscription.findMany({ where: { id: { in: created.map((c) => c.id) } }, select: { id: true, number: true } })).map((s) => [s.id, s.number]));
    const events: Prisma.SubscriptionEventCreateManyInput[] = [];
    created.forEach((s, i) => {
      if (!s.startDate || !['ACTIVE', 'PAUSED', 'CLOSED'].includes(s.status)) return;
      const plan = planOf.get(numberOf.get(s.id)!)!;
      const mrr = monthlyValue(plan, [lines[i]]);
      const at = (daysAgo: number) => new Date(Math.max(s.startDate!.getTime(), today.getTime() - daysAgo * day));
      events.push({ subscriptionId: s.id, type: 'STATUS', toStatus: 'ACTIVE', message: 'Subscription activated', actorName: 'System', mrrKind: 'NEW', mrrDelta: mrr, createdAt: s.startDate! });
      if (s.status === 'CLOSED') {
        events.push({ subscriptionId: s.id, type: 'STATUS', fromStatus: 'ACTIVE', toStatus: 'CLOSED', message: 'Subscription closed', actorName: 'System', mrrKind: 'CHURN', mrrDelta: -mrr, createdAt: at(rand(60)) });
      } else if (s.status === 'PAUSED') {
        events.push({ subscriptionId: s.id, type: 'STATUS', fromStatus: 'ACTIVE', toStatus: 'PAUSED', message: 'Subscription paused', actorName: 'System', mrrKind: 'PAUSE', mrrDelta: -mrr, createdAt: at(rand(60)) });
      } else if (rand(10) === 0) {
        events.push({ subscriptionId: s.id, type: 'CHANGE', message: 'Seats added', actorName: 'System', mrrKind: 'EXPANSION', mrrDelta: Math.round(mrr * 0.2), createdAt: at(rand(90)) });
      } else if (rand(20) === 0) {
        events.push({ subscriptionId: s.id, type: 'CHANGE', message: 'Seats removed', actorName: 'System', mrrKind: 'CONTRACTION', mrrDelta: -Math.round(mrr * 0.15), createdAt: at(rand(90)) });
      }
    });
    await prisma.subscriptionEvent.createMany({ data: events });

    // One past invoice per billed subscription: some paid, some open, some overdue.
    const invoices: Prisma.InvoiceCreateManyInput[] = [];
    for (const s of created) {
      if (!s.startDate || s.status === 'CONFIRMED') continue;
      const issue = new Date(today.getTime() - rand(150) * day);
      const total = (5 + rand(200)) * 10000;
      const kind = rand(10);
      const paid = kind < 6 ? total : kind < 8 ? Math.round(total / 2) : 0;
      invoices.push({
        number: `INV-${String(++invNo).padStart(6, '0')}`,
        subscriptionId: s.id,
        customerId: s.customerId,
        status: paid >= total ? 'PAID' : 'CONFIRMED',
        periodStart: issue,
        periodEnd: new Date(issue.getTime() + 29 * day),
        issueDate: issue,
        dueDate: new Date(issue.getTime() + 15 * day),
        subtotal: Math.round(total / 1.18),
        taxTotal: total - Math.round(total / 1.18),
        total,
        amountPaid: paid,
        confirmedAt: issue,
        // Some paid invoices were only paid after overdue reminders (recovered).
        reminderStage: paid >= total && rand(4) === 0 ? 3 + rand(2) : 0,
      });
    }
    await prisma.invoice.createMany({ data: invoices });
    const invRows = await prisma.invoice.findMany({
      where: { number: { in: invoices.map((i) => i.number) }, amountPaid: { gt: 0 } },
      select: { id: true, amountPaid: true, issueDate: true },
    });
    await prisma.payment.createMany({
      data: invRows.map((i) => ({
        invoiceId: i.id,
        amount: i.amountPaid,
        method: (['UPI', 'BANK_TRANSFER', 'CARD'] as const)[rand(3)],
        paidAt: new Date(Math.min(i.issueDate.getTime() + rand(20) * day, today.getTime())),
      })),
    });
    process.stdout.write(`\r${start + size} / ${COUNT}`);
  }

  await prisma.counter.upsert({ where: { key: 'SUB' }, update: { value: subNo }, create: { key: 'SUB', value: subNo } });
  await prisma.counter.upsert({ where: { key: 'INV' }, update: { value: invNo }, create: { key: 'INV', value: invNo } });
  console.log();
  console.timeEnd('bulk seed');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
