import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './budgets.css';

const monthNow = () => new Date().toISOString().slice(0, 7);
const rupees = value => value == null ? '—' : `${value < 0 ? '−' : ''}₹${(Math.abs(value) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toPaise = value => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(value).trim())) throw new Error('Enter a non-negative rupee amount with at most two decimals.');
  const [whole, fraction = ''] = String(value).trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('Amount exceeds safe paise range.');
  return amount;
};
const labels = { expense: 'Expense budget', sales: 'Sales target', collections: 'Collection target' };
const sourceLabels = { purchase_line: 'Purchase line', sale_line: 'Sales line', sale_receipt: 'Sales receipt' };
const status = value => value === 'approved' ? 'Approved' : value === 'rejected' ? 'Rejected' : 'Awaiting review';
const scopeLabel = (context, key) => {
  const company = context.bootstrap?.companies?.find(row => String(row.id) === String(context.companyId));
  if (key === 'company') return company?.name || `Company #${context.companyId}`;
  if (key === 'gstin') return company?.gstins?.find(row => String(row.id) === String(context.gstinId))?.gstin || `GSTIN #${context.gstinId}`;
  return company?.branches?.find(row => String(row.id) === String(context.branchId))?.name || `Branch #${context.branchId}`;
};

export default function Budgets({ context = {}, refresh }) {
  const [period, setPeriod] = useState(monthNow);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [centreForm, setCentreForm] = useState({ code: '', name: '', purpose: '' });
  const [planForm, setPlanForm] = useState({ centreId: '', measure: 'expense', amount: '', basis: '' });
  const [allocationForm, setAllocationForm] = useState({ centreId: '', sourceKey: '', amount: '', basis: '' });
  const [reviewReasons, setReviewReasons] = useState({});
  const replayKeys = useRef({});
  const referenceFor = (kind, payload) => {
    const signature = JSON.stringify({ companyId: context.companyId, ...payload });
    const prior = replayKeys.current[kind];
    if (prior?.signature === signature) return prior.key;
    const key = crypto.randomUUID();
    replayKeys.current = { ...replayKeys.current, [kind]: { signature, key } };
    return key;
  };
  const clearReference = kind => {
    const { [kind]: _discarded, ...remaining } = replayKeys.current;
    replayKeys.current = remaining;
  };
  const canReview = ['accountant','admin'].includes(context.role);
  const query = useMemo(() => new URLSearchParams({ gstinId: String(context.gstinId), branchId: String(context.branchId), period }).toString(), [context.gstinId, context.branchId, period]);
  const request = useCallback(async (path, init = {}) => {
    const response = context.apiFetch ? await context.apiFetch(path, init) : await fetch(path, {
      ...init, headers: { 'content-type': 'application/json', 'x-company-id': String(context.companyId), 'x-user-id': String(context.userId), ...init.headers },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Budget request failed (${response.status})`);
    return data;
  }, [context.apiFetch, context.companyId, context.userId]);
  const load = useCallback(async () => {
    if (!context.gstinId || !context.branchId) { setOverview(null); setLoading(false); return; }
    const data = await request(`/api/budgets/overview?${query}`);
    setOverview(data);
    setPlanForm(previous => ({ ...previous, centreId: data.centres.some(row => String(row.id) === previous.centreId) ? previous.centreId : String(data.centres[0]?.id || '') }));
    setAllocationForm(previous => ({ ...previous, centreId: data.centres.some(row => String(row.id) === previous.centreId) ? previous.centreId : String(data.centres[0]?.id || '') }));
  }, [context.gstinId, context.branchId, query, request]);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setNotice(''); setOverview(null);
    if (!context.gstinId || !context.branchId) { setLoading(false); return undefined; }
    request(`/api/budgets/overview?${query}`).then(data => { if (live) { setOverview(data); setPlanForm(previous => ({ ...previous, centreId: String(data.centres[0]?.id || '') })); setAllocationForm(previous => ({ ...previous, centreId: String(data.centres[0]?.id || '') })); } })
      .catch(cause => { if (live) setError(cause.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [context.gstinId, context.branchId, context.companyId, context.userId, query, request]);
  const send = async (path, body, message, after) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
      after?.();
      setNotice(result.replayed ? 'Existing request returned without a duplicate.' : message);
      refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const createCentre = event => { event.preventDefault(); send('/api/budgets/centres', { gstinId: Number(context.gstinId), branchId: Number(context.branchId), ...centreForm }, 'Cost centre created for this branch.', () => setCentreForm({ code: '', name: '', purpose: '' })); };
  const createPlan = event => { event.preventDefault(); try {
    const payload = { centreId: Number(planForm.centreId), period, measure: planForm.measure, amountCents: toPaise(planForm.amount), basis: planForm.basis };
    send('/api/budgets/plans', { ...payload, clientReference: referenceFor('plan',payload) }, 'Period plan submitted for independent review.', () => { clearReference('plan'); setPlanForm(previous => ({ ...previous, amount: '', basis: '' })); });
  } catch (cause) { setError(cause.message); } };
  const createAllocation = event => { event.preventDefault(); try {
    const [sourceType, sourceId] = allocationForm.sourceKey.split(':');
    const payload = { centreId: Number(allocationForm.centreId), sourceType, sourceId: Number(sourceId), amountCents: toPaise(allocationForm.amount), basis: allocationForm.basis };
    send('/api/budgets/allocations', { ...payload, clientReference: referenceFor('allocation',payload) }, 'Source allocation submitted for independent review.', () => { clearReference('allocation'); setAllocationForm(previous => ({ ...previous, sourceKey: '', amount: '', basis: '' })); });
  } catch (cause) { setError(cause.message); } };
  const review = (kind, row, decision) => send(`/api/budgets/${kind}/${row.id}/review`, { decision, reason: reviewReasons[`${kind}-${row.id}`] || '' }, `${kind === 'plans' ? 'Plan' : 'Allocation'} ${decision === 'approve' ? 'approved' : 'rejected'}.`);
  const sourceByKey = key => overview?.sources.find(row => `${row.sourceType}:${row.sourceId}` === key);
  const chosenSource = sourceByKey(allocationForm.sourceKey);
  const approved = overview?.rows.filter(row => row.planId != null || row.actualCents > 0) || [];
  const pending = [ ...(overview?.plans || []).filter(row => row.status === 'pending').map(row => ({ ...row, kind: 'plans' })), ...(overview?.allocations || []).filter(row => row.status === 'pending').map(row => ({ ...row, kind: 'allocations' })) ];

  return <main className="budgets-page">
    <header className="budgets-hero"><div><span className="budgets-eyebrow">FINANCE / PERFORMANCE · ERP-022</span><h1>Budgets &amp; targets</h1><p>Set branch cost centres, approve period plans, and explain every variance with reviewed source allocations.</p></div><div className="budgets-period"><label htmlFor="budgets-period">Reporting period</label><input id="budgets-period" type="month" value={period} onChange={event => setPeriod(event.target.value)} /><button type="button" onClick={() => { setLoading(true); load().catch(cause => setError(cause.message)).finally(() => setLoading(false)); }} disabled={loading || busy}>Refresh</button></div></header>
    <div className="budgets-scope"><span><small>Company</small><strong>{scopeLabel(context,'company')}</strong></span><span><small>GSTIN</small><strong>{scopeLabel(context,'gstin')}</strong></span><span><small>Branch</small><strong>{scopeLabel(context,'branch')}</strong></span><span><small>Acting as</small><strong>{context.role || 'User'} #{context.userId}</strong></span></div>
    <p className="budgets-boundary">Local performance review only. Expense, sales and collection measures stay separate. Approved returns are not netted here, receipts may include uncleared methods, and this workflow never changes the ledger, GST or filing state.</p>
    {error && <div className="budgets-alert budgets-error" role="alert">{error}</div>}{notice && <div className="budgets-alert budgets-success" role="status">{notice}</div>}
    {loading ? <section className="budgets-card">Loading scoped plans and actuals…</section> : overview && <>
      <section className="budgets-section"><div className="budgets-section-head"><div><span className="budgets-eyebrow">01 / PERFORMANCE</span><h2>Period variance</h2></div><span>{period} · {overview.centres.length} cost centres</span></div>
        {approved.length ? <div className="budgets-variance-grid">{approved.map(row => <article className="budgets-variance" key={`${row.centreId}-${row.measure}`}><div className="budgets-variance-top"><span>{row.code}</span><span>{labels[row.measure]}</span></div><h3>{row.centreName}</h3><div className="budgets-variance-figures"><div><small>Approved plan</small><strong>{rupees(row.planCents)}</strong></div><div><small>Reviewed actual</small><strong>{rupees(row.actualCents)}</strong></div><div className={row.varianceCents < 0 ? 'negative' : row.measure === 'expense' && row.varianceCents > 0 ? 'negative' : ''}><small>Actual − plan</small><strong>{rupees(row.varianceCents)}</strong></div></div><p><strong>Plan basis:</strong> {row.basis || 'No approved plan for this measure.'}</p><details><summary>Source drilldown · {row.allocationIds.length} allocation{row.allocationIds.length === 1 ? '' : 's'}</summary>{row.allocationIds.length ? <ul>{row.allocationIds.map(id => { const allocation = overview.allocations.find(item => item.id === id); const source = sourceByKey(`${allocation.sourceType}:${allocation.sourceId}`); return <li key={id}><span>{sourceLabels[allocation.sourceType]} #{allocation.sourceId} · {source?.documentNumber || 'Approved source'} · {allocation.sourceDate}<br /><small>Basis: {allocation.basis}</small></span><strong>{rupees(allocation.amountCents)}</strong></li>; })}</ul> : <p>No reviewed allocations in this period.</p>}</details></article>)}</div> : <div className="budgets-empty">No approved plans or reviewed actual allocations for this period. Create a branch cost centre and submit separate expense, sales or collection plans.</div>}
      </section>
      <div className="budgets-columns"><section className="budgets-card"><div className="budgets-card-head"><span className="budgets-eyebrow">02 / STRUCTURE</span><h2>Cost centres</h2></div>{overview.centres.length ? <div className="budgets-centres">{overview.centres.map(row => <div key={row.id}><strong>{row.code} · {row.name}</strong><small>{row.purpose}</small></div>)}</div> : <p className="budgets-empty">No cost centres in this branch yet.</p>}{canReview && <form onSubmit={createCentre} className="budgets-form"><h3>Add branch centre</h3><label>Code<input required maxLength="32" value={centreForm.code} onChange={event => setCentreForm(previous => ({ ...previous, code: event.target.value }))} placeholder="OPS-BLR" /></label><label>Name<input required maxLength="120" value={centreForm.name} onChange={event => setCentreForm(previous => ({ ...previous, name: event.target.value }))} placeholder="Branch operations" /></label><label>Purpose<textarea required maxLength="500" value={centreForm.purpose} onChange={event => setCentreForm(previous => ({ ...previous, purpose: event.target.value }))} placeholder="What this centre measures" /></label><button disabled={busy}>Create cost centre</button></form>}</section>
        <section className="budgets-card"><div className="budgets-card-head"><span className="budgets-eyebrow">03 / APPROVED PLAN</span><h2>Set a period amount</h2></div><p className="budgets-help">One immutable plan per centre, period and measure. A different accountant or admin must approve it before variance appears.</p><form onSubmit={createPlan} className="budgets-form"><label>Cost centre<select required value={planForm.centreId} onChange={event => setPlanForm(previous => ({ ...previous, centreId: event.target.value }))}><option value="">Select centre</option>{overview.centres.map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label><label>Measure<select value={planForm.measure} onChange={event => setPlanForm(previous => ({ ...previous, measure: event.target.value }))}>{Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Amount in rupees<input required inputMode="decimal" value={planForm.amount} onChange={event => setPlanForm(previous => ({ ...previous, amount: event.target.value }))} placeholder="0.00" /></label><label>Planning basis<textarea required maxLength="500" value={planForm.basis} onChange={event => setPlanForm(previous => ({ ...previous, basis: event.target.value }))} placeholder="Volume, owner and period assumption" /></label><button disabled={busy || !overview.centres.length}>Submit plan</button></form></section></div>
      <div className="budgets-columns"><section className="budgets-card"><div className="budgets-card-head"><span className="budgets-eyebrow">04 / ATTRIBUTION</span><h2>Allocate approved source</h2></div><p className="budgets-help">Choose an approved invoice line or a recorded sales receipt. Partial allocations are allowed; the unallocated remainder stays outside actuals.</p><form onSubmit={createAllocation} className="budgets-form"><label>Cost centre<select required value={allocationForm.centreId} onChange={event => setAllocationForm(previous => ({ ...previous, centreId: event.target.value }))}><option value="">Select centre</option>{overview.centres.map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label><label>Source<select required value={allocationForm.sourceKey} onChange={event => setAllocationForm(previous => ({ ...previous, sourceKey: event.target.value, amount: '' }))}><option value="">Select source</option>{overview.sources.filter(row => row.remainingCents > 0).map(row => <option key={`${row.sourceType}:${row.sourceId}`} value={`${row.sourceType}:${row.sourceId}`}>{sourceLabels[row.sourceType]} · {row.documentNumber} · {row.sourceDate} · {rupees(row.remainingCents)} available</option>)}</select></label>{chosenSource && <p className="budgets-source-note">{labels[chosenSource.measure]} · source #{chosenSource.sourceId} · available {rupees(chosenSource.remainingCents)}. Receipt reference: {chosenSource.reference || '—'}</p>}<label>Allocated rupees<input required inputMode="decimal" value={allocationForm.amount} onChange={event => setAllocationForm(previous => ({ ...previous, amount: event.target.value }))} placeholder="0.00" /></label><label>Allocation basis<textarea required maxLength="500" value={allocationForm.basis} onChange={event => setAllocationForm(previous => ({ ...previous, basis: event.target.value }))} placeholder="Why this source belongs to this centre" /></label><button disabled={busy || !allocationForm.centreId || !chosenSource}>Submit allocation</button></form></section>
        <section className="budgets-card"><div className="budgets-card-head"><span className="budgets-eyebrow">05 / INDEPENDENT REVIEW</span><h2>Pending decisions</h2></div>{pending.length ? <div className="budgets-review-list">{pending.map(row => <article key={`${row.kind}-${row.id}`}><div className="budgets-review-top"><strong>{row.kind === 'plans' ? labels[row.measure] : sourceLabels[row.sourceType]} · {rupees(row.amountCents)}</strong><span>{status(row.status)}</span></div><small>#{row.id} · centre #{row.centreId} · creator #{row.createdBy}{row.kind === 'plans' ? ` · ${row.period}` : ` · ${row.sourceDate}`}</small><p>{row.basis}</p>{canReview && row.createdBy !== Number(context.userId) && <div className="budgets-review-actions"><label>Review reason<input maxLength="500" value={reviewReasons[`${row.kind}-${row.id}`] || ''} onChange={event => setReviewReasons(previous => ({ ...previous, [`${row.kind}-${row.id}`]: event.target.value }))} placeholder="Evidence checked or reason for rejection" /></label><div><button type="button" disabled={busy || !reviewReasons[`${row.kind}-${row.id}`]?.trim()} onClick={() => review(row.kind,row,'approve')}>Approve</button><button type="button" className="secondary" disabled={busy || !reviewReasons[`${row.kind}-${row.id}`]?.trim()} onClick={() => review(row.kind,row,'reject')}>Reject</button></div></div>}</article>)}</div> : <p className="budgets-empty">No pending decisions for this branch and period.</p>}</section></div>
      <section className="budgets-card budgets-history"><div className="budgets-card-head"><span className="budgets-eyebrow">06 / TRACE</span><h2>Decision history</h2></div>{overview.events.length ? <ol>{overview.events.map(row => <li key={row.id}><strong>{row.entityType} #{row.entityId} · {row.action}</strong><span>{row.createdAt} · user #{row.actorId}</span><p>{row.details}</p></li>)}</ol> : <p className="budgets-empty">No activity in this scope and period.</p>}</section>
      <p className="budgets-footnote">Source dates use invoice date for sales and expense, payment date for collections. Variance uses approved plans and reviewed allocations only; source and plan totals are never combined across measures.</p>
    </>}
  </main>;
}
