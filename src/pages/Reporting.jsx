import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './reporting.css';

const money = cents => new Intl.NumberFormat('en-IN',{ style:'currency',currency:'INR' }).format((cents || 0) / 100);
const iso = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const initialFrom = () => { const date = new Date(); date.setFullYear(date.getFullYear()-1); return iso(date); };
const stamp = value => value ? new Date(value).toLocaleString('en-IN',{ dateStyle:'medium',timeStyle:'short' }) : '—';

export default function Reporting({ context = {}, onOpenInvoice, onNavigate }) {
  const { companyId, apiFetch, bootstrap, gstinId, branchId, userId } = context;
  const scopeKey = [companyId,gstinId,branchId,userId].join(':');
  const latestScope = useRef(scopeKey);
  latestScope.current = scopeKey;
  const requestVersion = useRef(0);
  const activeRequest = useRef(null);
  const company = useMemo(() => bootstrap?.companies?.find(row => String(row.id) === String(companyId)),[bootstrap,companyId]);
  const [filter,setFilter] = useState(() => ({ from:initialFrom(),to:iso(new Date()),gstinId:'',branchId:'' }));
  const [snapshot,setSnapshot] = useState(null);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState('');
  const [tab,setTab] = useState('invoices');
  const report = snapshot?.scopeKey === scopeKey ? snapshot.data : null;
  const applied = report ? snapshot.applied : null;
  useEffect(() => {
    requestVersion.current += 1;
    activeRequest.current?.abort();
    setFilter(previous => ({ ...previous,gstinId:String(gstinId || ''),branchId:String(branchId || '') }));
    setSnapshot(null); setError(''); setLoading(false);
  },[scopeKey,gstinId,branchId]);
  useEffect(() => () => { requestVersion.current += 1; activeRequest.current?.abort(); },[]);
  const load = useCallback(async selected => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const version = ++requestVersion.current;
    const current = () => version === requestVersion.current && scopeKey === latestScope.current;
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ from:selected.from,to:selected.to });
      if (selected.gstinId) query.set('gstinId',selected.gstinId);
      if (selected.branchId) query.set('branchId',selected.branchId);
      const response = await apiFetch(`/api/reports/operations?${query}`,{signal:controller.signal});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Report request failed (${response.status})`);
      if (current()) setSnapshot({ data,applied:selected,scopeKey });
    } catch (cause) { if (current() && cause.name !== 'AbortError') { setError(cause.message); setSnapshot(null); } }
    finally { if (current()) { setLoading(false); activeRequest.current = null; } }
  },[apiFetch,scopeKey]);
  useEffect(() => { if (companyId && gstinId && branchId) load({ from:initialFrom(),to:iso(new Date()),gstinId:String(gstinId),branchId:String(branchId) }); },[companyId,gstinId,branchId,load]);
  const chooseGstin = value => setFilter(previous => ({...previous,gstinId:value,branchId:''}));
  const chooseBranch = value => {
    const branch = company?.branches?.find(row => String(row.id) === value);
    setFilter(previous => ({...previous,branchId:value,gstinId:branch ? String(branch.gstinId) : previous.gstinId}));
  };
  const submit = event => { event.preventDefault(); load(filter); };
  const metrics = report?.metrics;
  const tabs = [ ['invoices','Invoices'],['payments','Payments'],['returns','Return proposals'],['gstPeriods','GST review'] ];
  const rows = report?.[tab] || [];
  return <section className="report-page" aria-label="Management reporting">
    <header className="report-head"><div><span className="report-eyebrow">ERP-021 · SOURCE LINKED MIS</span><h1>Management reporting</h1><p>Inspect operational activity with the company, date and tax identity visible.</p></div><div className="report-live"><span className="report-pulse" /> {report ? `Generated ${stamp(report.generatedAt)}` : 'Awaiting report'}</div></header>
    <form className="report-filters" onSubmit={submit}>
      <label>From<input type="date" value={filter.from} max={filter.to} onChange={event => setFilter(previous => ({...previous,from:event.target.value}))} required /></label>
      <label>To<input type="date" value={filter.to} min={filter.from} onChange={event => setFilter(previous => ({...previous,to:event.target.value}))} required /></label>
      <label>GSTIN<select value={filter.gstinId} onChange={event => chooseGstin(event.target.value)}><option value="">All GSTINs in company</option>{company?.gstins?.map(row => <option key={row.id} value={row.id}>{row.gstin}</option>)}</select></label>
      <label>Branch<select value={filter.branchId} onChange={event => chooseBranch(event.target.value)}><option value="">All branches</option>{company?.branches?.filter(row => !filter.gstinId || String(row.gstinId) === filter.gstinId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <button type="submit" disabled={loading || !filter.from || !filter.to || filter.from > filter.to}>{loading ? 'Refreshing…' : 'Run report'}</button>
    </form>
    {error && <div role="alert" className="report-error">{error}</div>}
    {loading && !report && <div className="report-empty" role="status">Preparing report…</div>}
    {report && <>
      <div className="report-scope"><div><strong>{report.scope.companyName}</strong><span>{report.scope.gstin || 'All company GSTINs'} · {report.scope.branchName || 'All branches'} · INR</span></div><div><strong>{applied?.from} → {applied?.to}</strong><span>As of {stamp(report.generatedAt)} · local records</span></div></div>
      <div className="report-kpis" aria-label="Separate source measures">
        <article><span>APPROVED SALES</span><strong>{money(metrics.approvedSalesCents)}</strong><small>Invoice date · gross billed</small></article>
        <article><span>APPROVED PURCHASES</span><strong>{money(metrics.approvedPurchasesCents)}</strong><small>Invoice date · gross billed</small></article>
        <article><span>RECEIPT ALLOCATIONS</span><strong>{money(metrics.paymentReceiptsCents)}</strong><small>Payment date · sales invoices</small></article>
        <article><span>PAYMENT ALLOCATIONS</span><strong>{money(metrics.paymentDisbursementsCents)}</strong><small>Payment date · purchase invoices</small></article>
        <article><span>RETURN PROPOSALS</span><strong>{money(metrics.returnProposalCents)}</strong><small>Creation date · all review states</small></article>
      </div>
      <div className="report-definition"><strong>Read each measure separately.</strong> {report.notes.join(' ')}</div>
      <section className="report-records"><div className="report-records-head"><div><span className="report-eyebrow">SOURCE DETAIL</span><h2>Trace every figure</h2></div><div className="report-tabs" role="tablist" aria-label="Report sources">{tabs.map(([key,label]) => <button type="button" key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}<b>{report[key].length}</b></button>)}</div></div>
        {rows.length === 0 ? <div className="report-empty">No {tabs.find(([key]) => key === tab)?.[1].toLowerCase()} in this period and scope.</div> :
        <div className="report-table-wrap"><table className="report-table"><thead><tr>{tab === 'invoices' ? <><th>Source</th><th>Date</th><th>Party / branch</th><th>Status</th><th>Gross</th></> : tab === 'payments' ? <><th>Source</th><th>Payment date</th><th>Linked invoice</th><th>Method</th><th>Allocation</th></> : tab === 'returns' ? <><th>Source</th><th>Created</th><th>Linked invoice</th><th>Approval / tax review</th><th>Proposal</th></> : <><th>Source</th><th>Period</th><th>GSTIN scope</th><th>Local state</th><th>Next step</th></>}</tr></thead><tbody>
          {tab === 'invoices' && rows.map(row => <tr key={row.id}><td><button type="button" className="report-source" onClick={() => onOpenInvoice?.(row.id)}>{row.number} <small>invoice #{row.id}</small></button><span className="report-type">{row.type}</span></td><td>{row.invoiceDate}</td><td>{row.partyName}<small>{row.branchName}</small></td><td><span className={`report-status ${row.status}`}>{row.status}</span></td><td className="report-money">{money(row.totalCents)}<small>{money(row.taxCents)} tax recorded</small></td></tr>)}
          {tab === 'payments' && rows.map(row => <tr key={row.id}><td><strong>Payment #{row.id}</strong><small>{row.reference}</small></td><td>{row.paymentDate}</td><td><button type="button" className="report-source" onClick={() => onOpenInvoice?.(row.invoiceId)}>{row.invoiceNumber} <small>invoice #{row.invoiceId}</small></button></td><td>{row.method.toUpperCase()} · {row.invoiceType}</td><td className="report-money">{money(row.amountCents)}<small>allocation only</small></td></tr>)}
          {tab === 'returns' && rows.map(row => <tr key={row.id}><td><button type="button" className="report-source" onClick={() => onNavigate?.('returns')}>{row.number} <small>return #{row.id}</small></button><span className="report-type">{row.kind.replace('_',' ')}</span></td><td>{row.createdAt?.slice(0,10)}</td><td><button type="button" className="report-source" onClick={() => onOpenInvoice?.(row.invoiceId)}>{row.invoiceNumber} <small>invoice #{row.invoiceId}</small></button></td><td><span className={`report-status ${row.status}`}>{row.status}</span><small>Tax: {row.taxReviewDecision}</small></td><td className="report-money">{money(row.totalProposalCents)}<small>{money(row.taxProposalCents)} tax proposed</small></td></tr>)}
          {tab === 'gstPeriods' && rows.map(row => <tr key={row.id}><td><strong>Period #{row.id}</strong></td><td>{row.period}</td><td>{row.gstin}<small>GSTIN wide, including all branches</small></td><td><span className={`report-status ${row.status}`}>{row.status}</span></td><td><button type="button" className="report-source" onClick={() => onNavigate?.('gst')}>Open GST workspace ↗</button></td></tr>)}
        </tbody></table></div>}
      </section>
    </>}
  </section>;
}
