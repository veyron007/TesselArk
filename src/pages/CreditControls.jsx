import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './credit-controls.css';

const money = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', minimumFractionDigits:2 }).format(value / 100);
const toPaise = value => {
  const clean = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) throw new Error('Enter rupees with at most two decimal places.');
  const [rupees, fraction = ''] = clean.split('.');
  const cents = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds the supported limit.');
  return Number(cents);
};
const fromPaise = value => value === null || value === undefined ? '' : (value / 100).toFixed(2);
const localToday = () => new Date().toISOString().slice(0,10);
const query = (gstinId, branchId) => `gstinId=${encodeURIComponent(gstinId)}&branchId=${encodeURIComponent(branchId)}`;

export default function CreditControls({ context }) {
  const { companyId, gstinId, branchId, userId, bootstrap, apiFetch } = context;
  const company = bootstrap?.companies?.find(row => String(row.id) === String(companyId));
  const gstin = company?.gstins?.find(row => String(row.id) === String(gstinId));
  const branch = company?.branches?.find(row => String(row.id) === String(branchId));
  const user = bootstrap?.users?.find(row => String(row.id) === String(userId));
  const [overview,setOverview] = useState(null);
  const [partyId,setPartyId] = useState('');
  const [assessment,setAssessment] = useState(null);
  const [events,setEvents] = useState([]);
  const [loading,setLoading] = useState(false);
  const [detailLoading,setDetailLoading] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [limit,setLimit] = useState('');
  const [mode,setMode] = useState('warn');
  const [policyReason,setPolicyReason] = useState('');
  const [additional,setAdditional] = useState('');
  const [validFrom,setValidFrom] = useState(localToday());
  const [validThrough,setValidThrough] = useState(localToday());
  const [requestReason,setRequestReason] = useState('');
  const [reviewReason,setReviewReason] = useState('');
  const [asOf,setAsOf] = useState(localToday());
  const overviewRevision = useRef(0);
  const detailRevision = useRef(0);

  const request = useCallback(async (url, options) => {
    const response = await apiFetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Credit request failed (${response.status})`);
    return data;
  },[apiFetch]);
  const scopedQuery = useMemo(() => query(gstinId,branchId),[gstinId,branchId]);

  const loadOverview = useCallback(async () => {
    if (!gstinId || !branchId) return;
    const revision = ++overviewRevision.current;
    setLoading(true); setError('');
    try {
      const data = await request(`/api/credit/overview?${scopedQuery}`);
      if (revision !== overviewRevision.current) return;
      setOverview(data);
      setPartyId(current => data.parties.some(party => String(party.id) === String(current)) ? current : String(data.parties[0]?.id || ''));
    } catch (cause) { if (revision === overviewRevision.current) { setError(cause.message); setOverview(null); } }
    finally { if (revision === overviewRevision.current) setLoading(false); }
  },[gstinId,branchId,scopedQuery,request]);
  const loadDetail = useCallback(async () => {
    const revision = ++detailRevision.current;
    if (!partyId || !gstinId || !branchId) { setAssessment(null); setEvents([]); return; }
    setDetailLoading(true); setError('');
    try {
      const base = `/api/credit/parties/${encodeURIComponent(partyId)}`;
      const [assessed,audit] = await Promise.all([
        request(`${base}/assessment?${scopedQuery}&asOf=${encodeURIComponent(asOf)}`),
        request(`${base}/events?${scopedQuery}`),
      ]);
      if (revision !== detailRevision.current) return;
      setAssessment(assessed.assessment); setEvents(audit.events);
    } catch (cause) { if (revision === detailRevision.current) { setError(cause.message); setAssessment(null); setEvents([]); } }
    finally { if (revision === detailRevision.current) setDetailLoading(false); }
  },[partyId,gstinId,branchId,asOf,scopedQuery,request]);

  useEffect(() => { setPartyId(''); setOverview(null); setAssessment(null); setEvents([]); setNotice(''); loadOverview(); },[companyId,gstinId,branchId,loadOverview]);
  useEffect(() => { loadDetail(); },[loadDetail]);
  useEffect(() => {
    const policy = overview?.policies.find(row => String(row.partyId) === String(partyId));
    setLimit(fromPaise(policy?.baseLimitCents)); setMode(policy?.mode || 'warn'); setPolicyReason('');
    setAdditional(''); setRequestReason(''); setReviewReason('');
  },[overview,partyId]);

  const selectedParty = overview?.parties.find(row => String(row.id) === String(partyId));
  const selectedPolicy = overview?.policies.find(row => String(row.partyId) === String(partyId));
  const requests = overview?.requests.filter(row => String(row.partyId) === String(partyId)) || [];
  const canReview = user?.role === 'accountant' || user?.role === 'admin';
  const canSetPolicy = user?.role === 'admin';
  const submit = async (action, message) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); await loadOverview(); await loadDetail(); setNotice(message); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const savePolicy = event => { event.preventDefault(); submit(async () => {
    await request('/api/credit/policies',{ method:'PUT', body:JSON.stringify({ gstinId:Number(gstinId),branchId:Number(branchId),partyId:Number(partyId),
      baseLimitCents:toPaise(limit),mode,reason:policyReason.trim(),expectedVersion:selectedPolicy?.version || 0 }) });
    setPolicyReason('');
  },'Credit policy saved and audited.'); };
  const createRequest = event => { event.preventDefault(); submit(async () => {
    await request('/api/credit/requests',{ method:'POST', body:JSON.stringify({ gstinId:Number(gstinId),branchId:Number(branchId),partyId:Number(partyId),
      additionalLimitCents:toPaise(additional),validFrom,validThrough,reason:requestReason.trim(),clientReference:crypto.randomUUID() }) });
    setAdditional(''); setRequestReason('');
  },'Temporary limit submitted for independent review.'); };
  const review = (id,decision) => submit(() => request(`/api/credit/requests/${id}/review`,{ method:'POST',
    body:JSON.stringify({ decision,reason:reviewReason.trim() }) }),`Temporary limit ${decision === 'approve' ? 'approved' : 'rejected'}.`);
  const e = assessment?.exposure;

  return <main className="credit-page">
    <header className="credit-hero"><div><span className="credit-eyebrow">FINANCE / CONTROL DESK</span><h1>Customer credit</h1><p>Review receivables and open commitments, then record scoped limits and time bound exceptions.</p></div><button type="button" onClick={() => { loadOverview(); loadDetail(); }} disabled={loading || busy}>Refresh assessment</button></header>
    <div className="credit-scope"><span><small>Company</small><strong>{company?.name || '—'}</strong></span><span><small>GSTIN</small><strong>{gstin?.gstin || '—'}</strong></span><span><small>Branch</small><strong>{branch?.name || '—'}</strong></span><span><small>Acting user</small><strong>{user?.name || '—'} · {user?.role || '—'}</strong></span></div>
    <p className="credit-notice">Hold blocks new over-limit sales order confirmations and sales invoice submissions. Existing commitments can still move through their linked invoice workflow when exposure does not rise. Warn shows the assessment without blocking. No statutory approval or filing is implied.</p>
    {error && <div className="credit-alert credit-error" role="alert">{error}</div>}{notice && <div className="credit-alert credit-success" role="status">{notice}</div>}
    <div className="credit-toolbar"><label>Customer<select value={partyId} onChange={event => setPartyId(event.target.value)} disabled={loading || !overview?.parties.length}><option value="">Select customer</option>{overview?.parties.map(party => <option key={party.id} value={party.id}>{party.name}{party.gstin ? ` · ${party.gstin}` : ''}</option>)}</select></label><label>Temporary limit date<input type="date" value={asOf} onChange={event => setAsOf(event.target.value)} /></label>{loading && <span className="credit-muted">Loading customers…</span>}</div>
    {!loading && overview && !overview.parties.length && <div className="credit-empty">No customer master records are available for this company.</div>}
    {selectedParty && <>
      <section className="credit-summary" aria-label="Credit summary"><div className="credit-summary-heading"><div><span className="credit-eyebrow">{selectedParty.gstin || 'UNREGISTERED CUSTOMER'}</span><h2>{selectedParty.name}</h2><p>{selectedPolicy ? `Policy v${selectedPolicy.version} · ${selectedPolicy.mode.toUpperCase()} · ${assessment?.enforcement === 'advisory_only' ? 'advisory only' : 'new commitments held over limit'}` : 'No credit policy yet'}</p></div><span className={`credit-indicator ${assessment?.overLimit ? 'over' : assessment?.overLimit === false ? 'within' : ''}`}>{detailLoading ? 'Calculating' : assessment?.overLimit === null ? 'Unconfigured' : assessment?.overLimit ? 'Over limit' : 'Within limit'}</span></div>
        <div className="credit-metrics"><div><small>Base limit</small><strong>{money(assessment?.policy?.baseLimitCents)}</strong></div><div><small>Temporary addition</small><strong>{money(assessment?.activeTemporaryLimit?.additionalLimitCents || 0)}</strong><em>{assessment?.activeTemporaryLimit ? `through ${assessment.activeTemporaryLimit.validThrough}` : 'No active exception'}</em></div><div><small>Exposure</small><strong>{money(e?.totalCents)}</strong></div><div className={assessment?.overLimit ? 'negative' : ''}><small>Available credit</small><strong>{money(assessment?.availableCents)}</strong></div></div>
      </section>
      <div className="credit-grid"><section className="credit-card"><div className="credit-card-title"><h2>Exposure composition</h2><span>Current records</span></div>{detailLoading ? <p className="credit-empty">Calculating exposure…</p> : e ? <><div className="credit-breakdown"><div><span>Approved invoice balances</span><strong>{money(e.approvedOutstandingCents)}</strong></div><div><span>Submitted invoices</span><strong>{money(e.submittedInvoiceCents)}</strong></div><div><span>Uncleared cheque allocations</span><strong>{money(e.unclearedChequeCents)}</strong></div><div><span>Open confirmed sales orders</span><strong>{money(e.openOrderCents)}</strong></div></div><p className="credit-fine">The selected date applies only to the temporary limit. Exposure uses current source records. Linked submitted or approved invoices reduce their source order commitment. Draft and unposted documents and overdue status are excluded. Cheques stay in exposure until a clearance workflow exists.</p><details className="credit-details"><summary>Source documents · {e.invoices.length} invoices, {e.orders.length} orders</summary><div className="credit-source-list">{e.invoices.map(row => <div key={`i-${row.invoiceId}`}><span><strong>{row.number}</strong><small>{row.status} invoice · {row.invoiceDate}</small></span><strong>{money(row.exposureCents)}</strong></div>)}{e.orders.map(row => <div key={`o-${row.orderId}`}><span><strong>{row.number}</strong><small>confirmed order · {row.orderDate}</small></span><strong>{money(row.exposureCents)}</strong></div>)}</div></details></> : <p className="credit-empty">Select a customer to calculate exposure.</p>}</section>
        <section className="credit-card"><div className="credit-card-title"><h2>Base credit policy</h2><span>{selectedPolicy ? `Version ${selectedPolicy.version}` : 'Not set'}</span></div>{canSetPolicy ? <form className="credit-form" onSubmit={savePolicy}><label>Limit in rupees<input inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} placeholder="0.00" required /></label><label>Policy mode<select value={mode} onChange={event => setMode(event.target.value)}><option value="warn">Warn</option><option value="hold">Hold new commitments</option></select></label><label className="wide">Decision reason<textarea value={policyReason} onChange={event => setPolicyReason(event.target.value)} maxLength="500" required placeholder="Why this limit is appropriate" /></label><button type="submit" disabled={busy || !partyId}>{busy ? 'Saving…' : selectedPolicy ? 'Update policy' : 'Set policy'}</button></form> : <p className="credit-fine">A company admin sets the base policy. {selectedPolicy ? `Last reason: ${selectedPolicy.reason}` : 'No base policy has been set.'}</p>}</section>
      </div>
      <div className="credit-grid"><section className="credit-card"><div className="credit-card-title"><h2>Request temporary credit</h2><span>Additional limit</span></div><p className="credit-fine">A request adds to the base limit only during its approved date window. Approval requires a different accountant or admin.</p><form className="credit-form" onSubmit={createRequest}><label>Additional rupees<input inputMode="decimal" value={additional} onChange={event => setAdditional(event.target.value)} placeholder="0.00" required /></label><label>Valid from<input type="date" value={validFrom} onChange={event => setValidFrom(event.target.value)} required /></label><label>Valid through<input type="date" value={validThrough} min={validFrom} onChange={event => setValidThrough(event.target.value)} required /></label><label className="wide">Business reason<textarea value={requestReason} onChange={event => setRequestReason(event.target.value)} maxLength="500" required placeholder="Order or customer context for the reviewer" /></label><button type="submit" disabled={busy || !selectedPolicy}>{busy ? 'Submitting…' : 'Send for review'}</button></form>{!selectedPolicy && <p className="credit-fine">A base policy is required before a temporary request.</p>}</section>
        <section className="credit-card"><div className="credit-card-title"><h2>Exception review</h2><span>{requests.length} requests</span></div>{requests.length ? <div className="credit-request-list">{requests.map(row => <article key={row.id}><div className="credit-request-top"><strong>#{row.id} · {money(row.additionalLimitCents)}</strong><span className={`credit-status ${row.status}`}>{row.status}</span></div><p>{row.reason}</p><small>{row.validFrom} → {row.validThrough} · requested by user #{row.requestedBy}</small>{row.reviewedBy && <small>Reviewed by user #{row.reviewedBy} · {row.reviewReason}</small>}{row.status === 'pending' && canReview && row.requestedBy !== Number(userId) && <div className="credit-review"><label>Review reason<input value={reviewReason} onChange={event => setReviewReason(event.target.value)} maxLength="500" placeholder="Evidence checked or rejection reason" /></label><div><button type="button" disabled={busy || !reviewReason.trim()} onClick={() => review(row.id,'approve')}>Approve</button><button type="button" className="secondary" disabled={busy || !reviewReason.trim()} onClick={() => review(row.id,'reject')}>Reject</button></div></div>}</article>)}</div> : <p className="credit-empty">No temporary requests for this customer and branch.</p>}</section></div>
      <section className="credit-card credit-audit"><div className="credit-card-title"><h2>Decision history</h2><span>{events.length} events</span></div>{events.length ? <ol>{events.map(row => <li key={row.id}><span className="credit-audit-dot" /><div><strong>{row.action.replaceAll('_',' ')}</strong><small>{row.createdAt} · user #{row.actorId}</small><p>{(() => { try { const detail = JSON.parse(row.details); return detail.reason || detail.reviewReason || ''; } catch { return row.details; } })()}</p></div></li>)}</ol> : <p className="credit-empty">No credit decisions recorded for this scope.</p>}</section>
    </>}
  </main>;
}
