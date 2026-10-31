import PDFDocument from 'pdfkit';
import type { Prisma } from '@prisma/client';
import { config } from '../config';

export const invoicePdfInclude = {
  creditNotes: { orderBy: { createdAt: 'asc' } },
  customer: true,
  lines: { orderBy: { id: 'asc' } },
  payments: { orderBy: { paidAt: 'asc' } },
  subscription: { select: { number: true, plan: { select: { name: true } } } },
} satisfies Prisma.InvoiceInclude;

type InvoiceForPdf = Prisma.InvoiceGetPayload<{ include: typeof invoicePdfInclude }>;

// The built-in PDF fonts have no rupee glyph, so amounts use "Rs.".
const rs = (paise: number) =>
  'Rs. ' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export function renderInvoicePdf(inv: InvoiceForPdf): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const muted = '#666666';

  doc.fontSize(20).fillColor('#111111').text(config.companyName, { continued: false });
  doc.fontSize(9).fillColor(muted).text(`State: ${config.companyState}`);
  doc.moveUp(2).fontSize(16).fillColor('#111111').text(inv.status === 'DRAFT' ? 'DRAFT INVOICE' : 'TAX INVOICE', { align: 'right' });
  doc.fontSize(10).fillColor(muted).text(inv.number, { align: 'right' });
  doc.moveDown(1.5);

  const top = doc.y;
  doc.fontSize(9).fillColor(muted).text('BILL TO', 48, top);
  doc.fontSize(11).fillColor('#111111').text(inv.customer.name);
  doc.fontSize(9).fillColor(muted).text(inv.customer.email);
  if (inv.customer.gstin) doc.text(`GSTIN: ${inv.customer.gstin}`);
  if (inv.customer.state) doc.text(`State: ${inv.customer.state}`);

  const meta: [string, string][] = [
    ['Issue date', date(inv.issueDate)],
    ['Due date', date(inv.dueDate)],
    ['Period', `${date(inv.periodStart)} - ${date(inv.periodEnd)}`],
  ];
  if (inv.subscription) meta.push(['Subscription', `${inv.subscription.number} (${inv.subscription.plan.name})`]);
  meta.forEach(([k, v], i) => {
    doc.fontSize(9).fillColor(muted).text(k, 300, top + i * 14, { width: 90 });
    doc.fillColor('#111111').text(v, 390, top + i * 14, { width: 160, align: 'right' });
  });

  doc.y = Math.max(doc.y, top + meta.length * 14) + 24;

  const cols = { desc: 48, qty: 300, unit: 340, tax: 420, amount: 470 };
  const header = doc.y;
  doc.fontSize(9).fillColor(muted);
  doc.text('Description', cols.desc, header);
  doc.text('Qty', cols.qty, header, { width: 30, align: 'right' });
  doc.text('Unit', cols.unit, header, { width: 70, align: 'right' });
  doc.text('Tax', cols.tax, header, { width: 40, align: 'right' });
  doc.text('Amount', cols.amount, header, { width: 77, align: 'right' });
  doc.moveTo(48, header + 14).lineTo(547, header + 14).strokeColor('#dddddd').stroke();
  doc.y = header + 20;

  for (const line of inv.lines) {
    const y = doc.y;
    doc.fontSize(10).fillColor('#111111').text(line.description, cols.desc, y, { width: 245 });
    const descBottom = doc.y;
    doc.fontSize(8).fillColor(muted).text(line.explanation.replace(/₹/g, 'Rs. ').replace(/−/g, '-').replace(/×/g, 'x'), cols.desc, descBottom, { width: 245 });
    const bottom = doc.y;
    doc.fontSize(10).fillColor('#111111');
    doc.text(String(line.quantity), cols.qty, y, { width: 30, align: 'right' });
    doc.text(rs(line.unitPrice), cols.unit, y, { width: 70, align: 'right' });
    doc.text(`${line.taxRateBp / 100}%`, cols.tax, y, { width: 40, align: 'right' });
    doc.text(rs(line.amount), cols.amount, y, { width: 77, align: 'right' });
    doc.y = bottom + 8;
  }

  doc.moveTo(300, doc.y).lineTo(547, doc.y).strokeColor('#dddddd').stroke();
  doc.moveDown(0.5);

  const half = Math.round(inv.taxTotal / 2);
  const totals: [string, string][] = [['Subtotal', rs(inv.subtotal)]];
  if (inv.discountTotal) totals.push(['Discount', '- ' + rs(inv.discountTotal)]);
  if (inv.taxSplit === 'INTER') totals.push(['IGST', rs(inv.taxTotal)]);
  else totals.push(['CGST', rs(half)], ['SGST', rs(inv.taxTotal - half)]);
  totals.push(['Total', rs(inv.total)], ['Paid', rs(inv.amountPaid)], ['Balance due', rs(inv.total - inv.amountPaid)]);
  for (const [k, v] of totals) {
    const y = doc.y;
    const strong = k === 'Total' || k === 'Balance due';
    doc.fontSize(strong ? 11 : 10).fillColor(strong ? '#111111' : muted).text(k, 300, y, { width: 120 });
    doc.fillColor('#111111').text(v, 420, y, { width: 127, align: 'right' });
    doc.moveDown(0.3);
  }

  if (inv.payments.length) {
    doc.moveDown(1).fontSize(9).fillColor(muted).text('PAYMENTS', 48);
    for (const p of inv.payments) {
      doc.fontSize(9).fillColor('#111111').text(`${date(p.paidAt)}  ${p.method.replace('_', ' ')}  ${rs(p.amount)}${p.reference ? `  Ref ${p.reference}` : ''}`, 48);
    }
  }

  doc.moveDown(2).fontSize(8).fillColor(muted).text('This is a computer generated invoice.', 48, undefined, { align: 'center', width: 499 });
  doc.end();
  return doc;
}
