import type { Discount, DiscountProduct, Prisma, TaxRule } from '@prisma/client';
import { applyRate, formatINR, formatRate } from '../lib/money';
import { config } from '../config';

type Tx = Prisma.TransactionClient;

export interface PricedLine {
  productId: number | null;
  description: string;
  explanation: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxRateBp: number;
  taxAmount: number;
  amount: number;
}

export interface PricedInvoice {
  lines: PricedLine[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  taxSplit: 'INTRA' | 'INTER';
  appliedDiscountIds: number[];
  missingTax: boolean;
}

export type DiscountWithProducts = Discount & { products: DiscountProduct[] };

export const subscriptionPricingInclude = {
  customer: true,
  plan: true,
  lines: {
    include: {
      product: { include: { taxRule: true } },
      variant: { include: { values: { include: { attributeValue: { include: { attribute: true } } } } } },
    },
  },
} satisfies Prisma.SubscriptionInclude;

export type SubscriptionForPricing = Prisma.SubscriptionGetPayload<{ include: typeof subscriptionPricingInclude }>;

export async function loadPricingContext(tx: Tx, on: Date) {
  const [defaultTax, discounts] = await Promise.all([
    tx.taxRule.findFirst({ where: { isDefault: true, active: true } }),
    activeDiscounts(tx, on),
  ]);
  return { defaultTax, discounts };
}

export function activeDiscounts(tx: Tx, on: Date) {
  return tx.discount.findMany({
    where: {
      active: true,
      AND: [
        { OR: [{ startDate: null }, { startDate: { lte: on } }] },
        { OR: [{ endDate: null }, { endDate: { gte: on } }] },
      ],
    },
    include: { products: true },
    orderBy: { id: 'asc' },
  });
}

const discountAvailable = (d: Discount) => d.usageLimit == null || d.usedCount < d.usageLimit;

function describeDiscount(d: Discount) {
  return d.type === 'PERCENT' ? `${d.name} −${formatRate(d.value)}` : `${d.name} −${formatINR(d.value)}`;
}

// Computes invoice lines for one billing period of a subscription.
// Order: base price + variant extras → discounts → tax. Each line carries a
// plain-English explanation of how the amount was reached.
export function priceSubscription(
  sub: SubscriptionForPricing,
  ctx: { defaultTax: TaxRule | null; discounts: DiscountWithProducts[] },
): PricedInvoice {
  const applied = new Set<number>();
  let missingTax = false;

  // The plan price is a recurring base fee billed alongside the product lines.
  const planLine =
    sub.plan.price > 0
      ? [{ productId: 0, quantity: 1, unitPrice: sub.plan.price, description: `Plan: ${sub.plan.name}`, variant: null, product: { taxRule: null } }]
      : [];
  const allLines = [...planLine, ...sub.lines];

  const draft = allLines.map((line) => {
    const extras = line.variant?.values.map((v) => v.attributeValue) ?? [];
    const extraTotal = extras.reduce((s, v) => s + v.priceExtra, 0);
    const unitPrice = line.unitPrice + extraTotal;
    const gross = unitPrice * line.quantity;
    const parts = [`${line.quantity} × ${formatINR(line.unitPrice)}`];
    for (const v of extras) {
      if (v.priceExtra) parts.push(`${v.attribute.name} ${v.value} +${formatINR(v.priceExtra)}`);
    }
    return { line, unitPrice, gross, parts, discountAmount: 0 };
  });

  const subtotal = draft.reduce((s, d) => s + d.gross, 0);
  const totalQty = sub.lines.reduce((s, l) => s + l.quantity, 0);
  const hasProduct = (id: number) => id > 0;

  for (const d of ctx.discounts) {
    if (!discountAvailable(d)) continue;
    if (subtotal < d.minPurchase || totalQty < d.minQuantity) continue;

    if (d.scope === 'PRODUCTS') {
      const productIds = new Set(d.products.map((p) => p.productId));
      for (const item of draft) {
        if (!hasProduct(item.line.productId) || !productIds.has(item.line.productId)) continue;
        const remaining = item.gross - item.discountAmount;
        const amount = Math.min(remaining, d.type === 'PERCENT' ? applyRate(remaining, d.value) : d.value * item.line.quantity);
        if (amount <= 0) continue;
        item.discountAmount += amount;
        item.parts.push(describeDiscount(d));
        applied.add(d.id);
      }
    } else {
      // Whole-subscription discount, spread across lines in proportion to their value.
      const base = draft.reduce((s, i) => s + i.gross - i.discountAmount, 0);
      if (base <= 0) continue;
      const totalOff = Math.min(base, d.type === 'PERCENT' ? applyRate(base, d.value) : d.value);
      let allocated = 0;
      draft.forEach((item, idx) => {
        const remaining = item.gross - item.discountAmount;
        const share = idx === draft.length - 1 ? totalOff - allocated : Math.floor((totalOff * remaining) / base);
        allocated += share;
        if (share > 0) {
          item.discountAmount += share;
          item.parts.push(describeDiscount(d));
        }
      });
      applied.add(d.id);
    }
  }

  const interState =
    !!sub.customer.state && sub.customer.state.trim().toLowerCase() !== config.companyState.trim().toLowerCase();

  const lines: PricedLine[] = draft.map((item) => {
    const ruleOnProduct = item.line.product.taxRule as TaxRule | null;
    const tax = ruleOnProduct?.active ? ruleOnProduct : ctx.defaultTax;
    if (!tax) missingTax = true;
    const taxable = item.gross - item.discountAmount;
    const taxRateBp = tax?.rateBp ?? 0;
    const taxAmount = applyRate(taxable, taxRateBp);
    if (tax) {
      item.parts.push(
        interState
          ? `IGST ${formatRate(taxRateBp)}`
          : `CGST ${formatRate(taxRateBp / 2)} + SGST ${formatRate(taxRateBp / 2)}`,
      );
    }
    return {
      productId: hasProduct(item.line.productId) ? item.line.productId : null,
      description: item.line.variant ? `${item.line.description} (${item.line.variant.name})` : item.line.description,
      explanation: item.parts.join(' · '),
      quantity: item.line.quantity,
      unitPrice: item.unitPrice,
      discountAmount: item.discountAmount,
      taxRateBp,
      taxAmount,
      amount: taxable + taxAmount,
    };
  });

  const discountTotal = lines.reduce((s, l) => s + l.discountAmount, 0);
  const taxTotal = lines.reduce((s, l) => s + l.taxAmount, 0);
  return {
    lines,
    subtotal,
    discountTotal,
    taxTotal,
    total: subtotal - discountTotal + taxTotal,
    taxSplit: interState ? 'INTER' : 'INTRA',
    appliedDiscountIds: [...applied],
    missingTax,
  };
}
