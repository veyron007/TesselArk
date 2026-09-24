import { useEffect, useMemo, useState } from 'react';
import './returnTaxReview.css';

const money = cents => new Intl.NumberFormat('en-IN',{ style:'currency', currency:'INR' }).format((Number(cents) || 0) / 100);
const niceMonth = value => /^\d{4}-\d{2}$/.test(value || '') ? new Intl.DateTimeFormat('en-IN',{ month:'long',year:'numeric' }).format(new Date(`${value}-01T00:00:00Z`)) : value;

export default function ReturnTaxReview({ context = {}, refresh = 0 }) {
  const { companyId, gstinId, branchId, role, apiFetch } = context;
  const [periods,setPeriods] = useState([]);
  const [period,setPeriod] = useState('');
  const [reviews,setReviews] = useState([]);
  const [preview,setPreview] = useState(null);
  const [selectedId,setSelectedId] = useState(null);
  const [reason,setReason] = useState('');
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const canReview = ['accountant','admin'].includes(role);
  const selected = useMemo(() => reviews.find(item => item.id === selectedId),[reviews,selectedId]);

  const request = async (path,options) => {
    const response = await apiFetch(path,options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  };
  const load = async (chosenPeriod = period) => {
    if (!companyId || !gstinId) return;
    const params = new URLSearchParams({ gstinId:String(gstinId) });
    if (branchId) params.set('branchId',String(branchId));
    if (chosenPeriod) params.set('period',chosenPeriod);
    const [reviewData,previewData] = await Promise.all([
      request(`/api/return-tax/reviews?${params}`),
      chosenPeriod ? request(`/api/return-tax/preview?gstinId=${gstinId}&period=${chosenPeriod}`) : Promise.resolve({preview:null}),
    ]);
    setReviews(reviewData.reviews || []);
    setPreview(previewData.preview);
    setSelectedId(current => reviewData.reviews?.some(item => item.id === current) ? current : reviewData.reviews?.[0]?.id ?? null);
  };

  useEffect(() => {
    if (!companyId || !gstinId) return undefined;
    let active = true;
    setLoading(true); setError(''); setReviews([]); setPreview(null);
    request(`/api/gst/periods?gstinId=${gstinId}`)
      .then(data => {
        if (!active) return;
        const rows = data.periods || [];
        setPeriods(rows);
        setPeriod(current => rows.some(row => row.period === current) ? current : rows.find(row => row.status === 'open')?.period || rows[0]?.period || '');
      })
      .catch(cause => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  },[companyId,gstinId,refresh]);

  useEffect(() => {
    if (!period || !gstinId) return undefined;
    let active = true;
    setLoading(true); setError('');
    const params = new URLSearchParams({ gstinId:String(gstinId),period });
    if (branchId) params.set('branchId',String(branchId));
    Promise.all([request(`/api/return-tax/reviews?${params}`),request(`/api/return-tax/preview?gstinId=${gstinId}&period=${period}`)])
      .then(([items,summary]) => {
        if (!active) return;
        setReviews(items.reviews || []); setPreview(summary.preview);
        setSelectedId(current => items.reviews?.some(item => item.id === current) ? current : items.reviews?.[0]?.id ?? null);
      })
      .catch(cause => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  },[companyId,gstinId,branchId,period,refresh]);

  async function decide(decision) {
    if (!selected || !period || !reason.trim()) { setError('Add a reason and select a period before recording a decision.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await request(`/api/return-tax/reviews/${selected.id}/decision`,{method:'POST',body:JSON.stringify({decision,period,reason})});
      setNotice(`${selected.number}: ${decision} recorded${data.replayed ? ' (existing decision)' : ''}. GST totals and filing state are unchanged.`);
      setReason('');
      await load();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  const pending = reviews.filter(item => item.status === 'approved' && !item.reviewDecision).length;
  const periodStatus = periods.find(item => item.period === period)?.status;
  return <section className="rtr-page" aria-label="Return tax review">
    <div className="rtr-head"><div><p className="rtr-kicker">GST ADJUSTMENT CONTROL</p><h1>Return tax review</h1><p>Review source-linked credit and debit note proposals, then inspect their separate local period preview.</p></div><span className="rtr-count">{pending} awaiting review</span></div>
    <div className="rtr-boundary"><strong>Local arithmetic preview.</strong> Decisions here do not modify recorded GST totals, eligible ITC, approved periods, or official filings. Tax head allocation and statutory eligibility need separate verification.</div>
    <div className="rtr-toolbar"><label>Review period<select value={period} onChange={event => setPeriod(event.target.value)}><option value="">Select period</option>{periods.map(item => <option key={item.id} value={item.period}>{niceMonth(item.period)} · {item.status}</option>)}</select></label><span>Company and GSTIN follow the workspace selector. {periodStatus === 'open' ? 'Eligible decisions can be recorded.' : 'This period is closed for eligible decisions.'}</span></div>
    {error && <p className="rtr-alert error" role="alert">{error}</p>}{notice && <p className="rtr-alert success" role="status">{notice}</p>}
    {preview && <div className="rtr-metrics"><article><span>Reviewed sales credit tax</span><strong>{money(preview.salesCreditTaxCents)}</strong></article><article><span>Reviewed purchase debit tax</span><strong>{money(preview.purchaseDebitTaxCents)}</strong></article><article><span>Indicative net adjustment</span><strong>{money(preview.indicativeNetAdjustmentCents)}</strong></article><small>{preview.documentCount} accepted note{preview.documentCount === 1 ? '' : 's'} · separate from GST period totals</small></div>}
    <div className="rtr-layout"><section className="rtr-list" aria-label="Return proposals"><header><h2>Proposals</h2><span>{reviews.length} in view</span></header>{loading ? <p className="rtr-empty">Loading proposals…</p> : reviews.length === 0 ? <p className="rtr-empty">No returns for this period and scope.</p> : reviews.map(item => <button type="button" key={item.id} className={`rtr-row ${selectedId === item.id ? 'active' : ''}`} onClick={() => { setSelectedId(item.id); setReason(''); }}><span><strong>{item.number}</strong><small>{item.invoiceNumber} · {item.partyName}</small></span><span><b>{money(item.taxProposalCents)}</b><small className={`rtr-state ${item.reviewDecision || item.status}`}>{item.reviewDecision || item.status}</small></span></button>)}</section>
      <section className="rtr-detail" aria-label="Selected return tax proposal">{!selected ? <p className="rtr-empty">Select a return to inspect its source and review history.</p> : <><div className="rtr-detail-head"><div><span>{selected.kind === 'sales_return' ? 'SALES CREDIT NOTE' : 'PURCHASE DEBIT NOTE'}</span><h2>{selected.number}</h2><p>Source {selected.invoiceNumber} · {selected.partyName} · {selected.gstin}</p></div><strong>{money(selected.taxProposalCents)}</strong></div><p className="rtr-reason">Return reason: {selected.reason}</p><div className="rtr-lines">{selected.lines.map(line => <div key={line.id}><span>{line.itemName} × {line.quantity}</span><strong>{money(line.taxProposalCents)} tax</strong></div>)}</div><div className="rtr-history"><h3>Decision history</h3>{selected.events.length ? selected.events.map(event => <div key={event.id}><span className={`rtr-state ${event.decision}`}>{event.decision}</span><span>{niceMonth(event.period)} · {event.reviewerName}<small>{event.reason}</small></span></div>) : <p>No tax decision recorded.</p>}</div>{selected.status !== 'approved' && <p className="rtr-inline">Approve the physical return in Returns before tax review.</p>}{selected.status === 'approved' && !['eligible','rejected'].includes(selected.reviewDecision) && <div className="rtr-decide"><label>Decision reason<textarea rows="3" maxLength="1000" value={reason} onChange={event => setReason(event.target.value)} placeholder="Record evidence and why this local treatment was chosen" /></label><div><button onClick={() => decide('eligible')} disabled={!canReview || busy || periodStatus !== 'open'}>Accept for preview</button><button onClick={() => decide('deferred')} disabled={!canReview || busy}>Defer</button><button onClick={() => decide('rejected')} disabled={!canReview || busy}>Reject</button></div>{!canReview && <small>Accountant or admin demo role required.</small>}</div>}</>}</section></div>
  </section>;
}
