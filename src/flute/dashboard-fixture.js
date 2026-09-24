import { monthWindow } from '../components/dashboard-data.js';

// Scene-local synthetic data only. The actual dashboard and its data derivation
// remain unchanged; no session, network request or private workspace is captured.
const today = new Date();
const months = monthWindow(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`);
const sales = [680000, 890000, 810000, 1120000, 1060000, 1380000];
const purchases = [440000, 560000, 510000, 760000, 690000, 850000];
const approved = months.flatMap((month, index) => ['sale', 'purchase'].map((type, side) => {
  const subtotalCents = (side ? purchases : sales)[index];
  const taxCents = Math.round(subtotalCents * 0.12);
  return {
    id: index * 2 + side + 1, type, status: 'approved',
    number: `${side ? 'PUR' : 'INV'}-2026-${1041 + index}`,
    invoiceDate: `${month}-18`, subtotalCents, taxCents, totalCents: subtotalCents + taxCents,
    partyName: side ? 'Northstar Supplies · synthetic' : 'Harbor Clinic · synthetic',
    branchId: 1, gstinId: 1,
  };
}));
const pending = [
  { ...approved.at(-2), id: 31, number: 'INV-2026-1047', status: 'submitted', partyName: 'Meridian Clinic · synthetic' },
  { ...approved.at(-1), id: 32, number: 'PUR-2026-1048', status: 'draft', partyName: 'Northstar Supplies · synthetic' },
];
const invoices = [...pending, ...approved.toReversed()];
const periods = months.map((period, index) => ({ period, status: index === 5 ? 'open' : 'reviewed', salesTaxCents: Math.round(sales[index] * .12), eligibleItcCents: Math.round(purchases[index] * .09) }));
const payloads = {
  '/api/dashboard': {
    salesCents: sales.reduce((sum, value) => sum + value, 0),
    purchasesCents: purchases.reduce((sum, value) => sum + value, 0),
    outputGstCents: periods.reduce((sum, row) => sum + row.salesTaxCents, 0),
    purchaseTaxCents: purchases.reduce((sum, value) => sum + Math.round(value * .12), 0),
    stats: { items: 24, parties: 12, approvedInvoices: approved.length, lowStockItems: 3 },
    recentActivity: invoices.slice(0, 4),
  },
  '/api/invoices': { invoices },
  '/api/gst/periods': { periods },
  '/api/finance/open': { invoices: [{ branchId: 1, gstinId: 1, outstandingCents: 173600 }] },
};

export const sceneContext = {
  companyId: 1, gstinId: 1, branchId: 1, userId: 'scene-synthetic',
  apiFetch: async (input, { signal } = {}) => {
    if (signal?.aborted) throw new DOMException('Scene request cancelled', 'AbortError');
    const data = payloads[new URL(input, 'http://localhost').pathname];
    return { ok: Boolean(data), status: data ? 200 : 404, json: async () => structuredClone(data) };
  },
};
