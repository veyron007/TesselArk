export function monthWindow(endMonth, count = 6) {
  const [year, month] = endMonth.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - count + index, 1));
    return date.toISOString().slice(0, 7);
  });
}

export function invoiceTrend(invoices, months) {
  return months.map(month => {
    const approved = invoices.filter(row => row.status === 'approved' && row.invoiceDate?.slice(0, 7) === month);
    return {
      month,
      salesCents: approved.filter(row => row.type === 'sale').reduce((sum, row) => sum + row.subtotalCents, 0),
      purchasesCents: approved.filter(row => row.type === 'purchase').reduce((sum, row) => sum + row.subtotalCents, 0),
    };
  });
}

export function gstTrend(periods, months) {
  return months.map(month => {
    const rows = periods.filter(row => row.period === month);
    return {
      month,
      outputCents: rows.length ? rows.reduce((sum, row) => sum + row.salesTaxCents, 0) : null,
      eligibleItcCents: rows.length ? rows.reduce((sum, row) => sum + row.eligibleItcCents, 0) : null,
      hasPeriod: rows.length > 0,
    };
  });
}

export function scopedOutstanding(invoices, context) {
  return invoices
    .filter(row => (!context.branchId || String(row.branchId) === String(context.branchId))
      && (!context.gstinId || String(row.gstinId) === String(context.gstinId)))
    .reduce((sum, row) => sum + row.outstandingCents, 0);
}
