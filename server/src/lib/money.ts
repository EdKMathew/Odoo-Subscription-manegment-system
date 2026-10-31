// Money is kept in integer paise everywhere to avoid floating point errors.

export const toPaise = (rupees: number) => Math.round(rupees * 100);
export const toRupees = (paise: number) => paise / 100;

export function formatINR(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Applies a basis-point rate (1800 = 18%) and rounds to the nearest paisa.
export const applyRate = (amount: number, rateBp: number) => Math.round((amount * rateBp) / 10000);

export const formatRate = (rateBp: number) => `${rateBp / 100}%`;
