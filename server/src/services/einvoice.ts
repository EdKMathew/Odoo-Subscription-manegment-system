import type { Prisma } from '@prisma/client';
import { config } from '../config';

// GST state codes used in the e-invoice schema.
const STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04', uttarakhand: '05', haryana: '06',
  delhi: '07', rajasthan: '08', 'uttar pradesh': '09', bihar: '10', sikkim: '11', 'arunachal pradesh': '12', nagaland: '13',
  manipur: '14', mizoram: '15', tripura: '16', meghalaya: '17', assam: '18', 'west bengal': '19', jharkhand: '20', odisha: '21',
  chhattisgarh: '22', 'madhya pradesh': '23', gujarat: '24', 'dadra and nagar haveli and daman and diu': '26', maharashtra: '27',
  karnataka: '29', goa: '30', lakshadweep: '31', kerala: '32', 'tamil nadu': '33', puducherry: '34',
  'andaman and nicobar islands': '35', telangana: '36', 'andhra pradesh': '37', ladakh: '38',
};

const stateCode = (state: string | null | undefined, gstin?: string | null) =>
  (gstin && gstin.slice(0, 2)) || STATE_CODES[(state ?? '').trim().toLowerCase()] || '96';

const r = (paise: number) => Math.round(paise) / 100;
const dmy = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

type InvoiceForEinvoice = Prisma.InvoiceGetPayload<{ include: { customer: true; lines: true } }>;

// Builds the invoice in the shape of the GST e-invoice (IRN) JSON schema v1.1,
// so it can be uploaded to the Invoice Registration Portal when required.
export function toEinvoiceJson(inv: InvoiceForEinvoice) {
  const inter = inv.taxSplit === 'INTER';
  const sellerState = stateCode(config.companyState, process.env.COMPANY_GSTIN);
  const items = inv.lines.map((l, i) => {
    const gross = l.unitPrice * l.quantity;
    const assessable = gross - l.discountAmount;
    const half = Math.round(l.taxAmount / 2);
    return {
      SlNo: String(i + 1),
      PrdDesc: l.description,
      IsServc: 'Y',
      HsnCd: process.env.DEFAULT_SAC ?? '998314',
      Qty: l.quantity,
      Unit: 'NOS',
      UnitPrice: r(l.unitPrice),
      TotAmt: r(gross),
      Discount: r(l.discountAmount),
      AssAmt: r(assessable),
      GstRt: l.taxRateBp / 100,
      IgstAmt: inter ? r(l.taxAmount) : 0,
      CgstAmt: inter ? 0 : r(half),
      SgstAmt: inter ? 0 : r(l.taxAmount - half),
      TotItemVal: r(l.amount),
    };
  });
  const sum = (k: 'AssAmt' | 'IgstAmt' | 'CgstAmt' | 'SgstAmt' | 'Discount') => Math.round(items.reduce((s, x) => s + x[k], 0) * 100) / 100;

  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N' },
    DocDtls: { Typ: 'INV', No: inv.number, Dt: dmy(inv.issueDate) },
    SellerDtls: {
      Gstin: process.env.COMPANY_GSTIN ?? 'NOT-SET',
      LglNm: config.companyName,
      Stcd: sellerState,
    },
    BuyerDtls: {
      Gstin: inv.customer.gstin ?? 'URP',
      LglNm: inv.customer.name,
      Pos: stateCode(inv.customer.state, inv.customer.gstin),
      Stcd: stateCode(inv.customer.state, inv.customer.gstin),
      Em: inv.customer.email,
    },
    ItemList: items,
    ValDtls: {
      AssVal: sum('AssAmt'),
      CgstVal: sum('CgstAmt'),
      SgstVal: sum('SgstAmt'),
      IgstVal: sum('IgstAmt'),
      Discount: 0,
      TotInvVal: r(inv.total),
    },
  };
}
