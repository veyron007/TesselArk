import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './finance.css';

const money = cents => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format((cents || 0) / 100);
const today = () => new Date().toISOString().slice(0, 10);
const dateLabel = value => new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function Finance({ context = {}, refresh }) {
  const [type, setType] = useState('sale');
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState(null);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState({ amount: '', method: 'bank', reference: '', paymentDate: today() });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const loadVersion = useRef(0);
  const canRecord = ['accountant', 'admin'].includes(context.role);
  const api = useCallback(async (path, init = {}) => {
    const response = context.apiFetch ? await context.apiFetch(path, init) : await fetch(path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [context.apiFetch]);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setRows([]);
    setTotals(null);
    setError('');
    try {
      const result = await api(`/api/finance/open?type=${type}`);
      if (version === loadVersion.current) {
        setRows(result.invoices || []);
        setTotals(result.totals);
      }
    } catch (cause) { if (version === loadVersion.current) setError(cause.message); }
    finally { if (version === loadVersion.current) setLoading(false); }
  }, [api, type]);
  useEffect(() => { setSelected(null); setHistory([]); load(); }, [load, context.companyId]);
  useEffect(() => {
    if (!selected) return undefined;
    const onKeyDown = event => { if (event.key === 'Escape' && !busy) setSelected(null); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selected, busy]);
  const open = async invoice => {
    setError('');
    try {
      const result = await api(`/api/finance/payments?invoiceId=${invoice.id}`);
      setSelected(result.invoice);
      setHistory(result.payments || []);
      setForm({ amount: '', method: 'bank', reference: '', paymentDate: today() });
    } catch (cause) { setError(cause.message); }
  };
  const amountCents = useMemo(() => /^\d+(?:\.\d{1,2})?$/.test(form.amount.trim()) ? Math.round(Number(form.amount) * 100) : NaN, [form.amount]);
  const record = async event => {
    event.preventDefault();
    if (!selected || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > selected.outstandingCents) {
      setError('Enter an amount greater than zero and no more than the outstanding balance.');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api('/api/finance/payments', { method: 'POST', body: JSON.stringify({ invoiceId: selected.id, amountCents, method: form.method, reference: form.reference.trim(), paymentDate: form.paymentDate }) });
      setSelected(result.invoice);
      setHistory(previous => [result.payment, ...previous]);
      setForm({ amount: '', method: 'bank', reference: '', paymentDate: today() });
      setNotice(`Payment recorded against ${selected.number}.`);
      await load();
      refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const label = type === 'sale' ? 'Receivables' : 'Payables';
  return <section className="fin-page" aria-label="Receivables and payables">
    <div className="fin-heading"><div><p className="fin-eyebrow">FINANCE / COMPANY-WIDE</p><h1>Receivables & payables</h1><p>Track recorded payments and explicitly posted commercial return adjustments against approved invoices. Tax proposals stay separate.</p></div></div>
    <div className="fin-tabs" role="tablist" aria-label="Account type">
      {[['sale', 'Receivables'], ['purchase', 'Payables']].map(([key, name]) => <button key={key} type="button" role="tab" aria-selected={type === key} className={type === key ? 'active' : ''} onClick={() => setType(key)}>{name}</button>)}
    </div>
    {error && !selected && <div className="fin-alert error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {notice && !selected && <div className="fin-alert success" role="status">{notice}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
    <div className="fin-summary" aria-label={`${label} summary`}>
      <div><span>OUTSTANDING</span><strong>{money(totals?.outstandingCents)}</strong><small>{label} awaiting full payment</small></div>
      <div><span>RECORDED PAYMENTS</span><strong>{money(totals?.paidCents)}</strong><small>Allocated to approved invoices</small></div>
      {type === 'purchase' && <div><span>EMPLOYEE-PAID ALLOCATIONS</span><strong>{money(totals?.employeeAllocatedCents)}</strong><small>Moved from supplier to employee payable</small></div>}
      <div><span>RETURN ADJUSTMENTS</span><strong>{money(totals?.commercialAdjustmentCents)}</strong><small>Approved commercial subtotal credits</small></div>
      <div><span>REFUNDABLE / RECOVERABLE</span><strong>{money(totals?.refundableCents)}</strong><small>Paid above adjusted invoice amount</small></div>
      <div><span>INVOICED TOTAL</span><strong>{money(totals?.invoicedCents)}</strong><small>{rows.length} approved invoice{rows.length === 1 ? '' : 's'}</small></div>
    </div>
    <div className="fin-panel"><div className="fin-panel-head"><div><h2>{label}</h2><p>Company-wide · adjusted commercial balances · open an invoice for payment history</p></div><button type="button" className="fin-reload" onClick={load}>Refresh</button></div>
      {loading ? <div className="fin-empty" role="status">Loading balances…</div> : rows.length === 0 ? <div className="fin-empty">No approved {type === 'sale' ? 'sales' : 'purchase'} invoices yet. Approve an invoice in Operations to begin.</div> : <div className="fin-table-wrap"><table className="fin-table"><thead><tr><th>Invoice</th><th>Party</th><th>Context</th><th className="numeric">Total</th><th className="numeric">Paid</th>{type === 'purchase' && <th className="numeric">Employee paid</th>}<th className="numeric">Outstanding</th><th aria-label="Open invoice" /></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><strong>{row.number}</strong><small>{dateLabel(row.invoiceDate)}</small></td><td>{row.partyName}</td><td><small>{row.branchName}<br />{row.gstin}</small></td><td className="numeric">{money(row.totalCents)}</td><td className="numeric">{money(row.paidCents)}</td>{type === 'purchase' && <td className="numeric">{money(row.employeeAllocatedCents)}</td>}<td className="numeric"><strong>{money(row.outstandingCents)}</strong></td><td><button type="button" className="fin-link" onClick={() => open(row)}>View</button></td></tr>)}</tbody></table></div>}
    </div>
    {selected && <div className="fin-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setSelected(null); }}><div className="fin-drawer" role="dialog" aria-modal="true" aria-label={`Payments for ${selected.number}`}>
      <div className="fin-drawer-head"><div><p className="fin-eyebrow">{type === 'sale' ? 'CUSTOMER RECEIPT' : 'SUPPLIER PAYMENT'}</p><h2>{selected.number}</h2><p>{selected.partyName}</p></div><button type="button" className="fin-close" aria-label="Close" onClick={() => setSelected(null)}>×</button></div>
      {error && <div className="fin-alert error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {notice && <div className="fin-alert success" role="status">{notice}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
      <div className="fin-balance"><div><span>Invoice total</span><strong>{money(selected.totalCents)}</strong></div><div><span>Commercial return adjustment</span><strong>{money(selected.commercialAdjustmentCents)}</strong></div><div><span>Adjusted total</span><strong>{money(selected.adjustedTotalCents)}</strong></div><div><span>{type === 'purchase' ? 'Recorded supplier payments' : 'Recorded customer receipts'}</span><strong>{money(selected.paidCents)}</strong></div>{type === 'purchase' && selected.employeeAllocatedCents > 0 && <div><span>Employee-paid allocation</span><strong>{money(selected.employeeAllocatedCents)}</strong></div>}<div><span>Outstanding</span><strong>{money(selected.outstandingCents)}</strong></div>{selected.refundableCents > 0 && <div><span>Refundable / recoverable</span><strong>{money(selected.refundableCents)}</strong></div>}</div>
      {selected.outstandingCents > 0 && canRecord && <form className="fin-form" onSubmit={record}><h3>Record a payment</h3><p>{form.method === 'cash' ? 'Cash receipts require an open cashier session for this invoice branch and payment date.' : 'This records an allocation. Bank settlement is not verified.'}</p><div className="fin-form-grid"><label>Amount (₹)<input required autoFocus inputMode="decimal" placeholder="0.00" value={form.amount} onChange={event => setForm({ ...form, amount: event.target.value })} /></label><label>Method<select value={form.method} onChange={event => setForm({ ...form, method: event.target.value })}><option value="bank">Bank transfer</option><option value="upi">UPI</option>{type === 'sale' && <option value="cash">Cash</option>}<option value="cheque">Cheque</option><option value="other">Other</option></select></label><label>Reference<input required maxLength="100" value={form.reference} onChange={event => setForm({ ...form, reference: event.target.value })} placeholder="Bank ref or receipt ID" /></label><label>Payment date<input required type="date" value={form.paymentDate} onChange={event => setForm({ ...form, paymentDate: event.target.value })} /></label></div><button type="submit" className="btn btn-primary" disabled={busy || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > selected.outstandingCents}>{busy ? 'Recording…' : 'Record payment'}</button></form>}
      {!canRecord && <p className="fin-readonly">Switch to a demo accountant or admin role to record payments.</p>}
      <div className="fin-history"><h3>{type === 'purchase' ? 'Supplier payment history' : 'Customer receipt history'}</h3>{type === 'purchase' && selected.employeeAllocatedCents > 0 && <p>{money(selected.employeeAllocatedCents)} was allocated through Expenses to an employee payable. Reimbursements appear in Expenses, separate from supplier payments.</p>}{history.length === 0 ? <p>No {type === 'purchase' ? 'supplier payments' : 'customer receipts'} recorded yet.</p> : <ol>{history.map(payment => <li key={payment.id}><div><strong>{money(payment.amountCents)}</strong><span>{payment.method.toUpperCase()} · {payment.reference}</span></div><time>{dateLabel(payment.paymentDate)}</time></li>)}</ol>}</div>
    </div></div>}
  </section>;
}
