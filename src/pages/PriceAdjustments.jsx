import { useCallback, useEffect, useMemo, useState } from 'react';
import './price-adjustments.css';

const rupees = cents => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(cents || 0) / 100);
const emptyForm = () => ({clientReference:'',reason:'',invoiceLineId:'',quantity:'',newUnitPriceCents:'',lines:[]});
const statusLabel = value => ({pending:'Awaiting review',approved:'Commercially approved',rejected:'Rejected'}[value] || value);

export default function PriceAdjustments({ context = {}, refresh }) {
  const { companyId, branchId, gstinId, userId, role, apiFetch } = context;
  const company = context.bootstrap?.companies?.find(row => String(row.id) === String(companyId));
  const branch = company?.branches?.find(row => String(row.id) === String(branchId));
  const gstin = company?.gstins?.find(row => String(row.id) === String(gstinId));
  const [sources,setSources] = useState([]);
  const [adjustments,setAdjustments] = useState([]);
  const [periods,setPeriods] = useState([]);
  const [selectedId,setSelectedId] = useState(null);
  const [detail,setDetail] = useState(null);
  const [form,setForm] = useState(emptyForm);
  const [reviewReason,setReviewReason] = useState('');
  const [taxReason,setTaxReason] = useState('');
  const [taxPeriod,setTaxPeriod] = useState('');
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const canPrepare = ['staff','accountant','admin'].includes(role);
  const canReview = ['accountant','admin'].includes(role);
  const request = useCallback(async (path,options = {}) => {
    const response = apiFetch ? await apiFetch(path,options) : await fetch(path,{...options,headers:{'content-type':'application/json','x-company-id':companyId,'x-user-id':userId,...options.headers}});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  },[apiFetch,companyId,userId]);
  const reload = useCallback(async (id = selectedId) => {
    if (!branchId || !gstinId) return;
    const [sourceData,adjustmentData,periodData] = await Promise.all([
      request(`/api/price-adjustments/sources?branchId=${branchId}`),
      request(`/api/price-adjustments?branchId=${branchId}`),
      request(`/api/gst/periods?gstinId=${gstinId}`),
    ]);
    setSources(sourceData.sources || []);
    setAdjustments(adjustmentData.adjustments || []);
    setPeriods(periodData.periods || []);
    setTaxPeriod(current => periodData.periods?.some(row => row.period === current) ? current : periodData.periods?.find(row => row.status === 'open')?.period || '');
    const nextId = adjustmentData.adjustments?.some(row => row.id === id) ? id : adjustmentData.adjustments?.[0]?.id;
    setSelectedId(nextId || null);
    if (nextId) setDetail((await request(`/api/price-adjustments/${nextId}`)).adjustment);
    else setDetail(null);
  },[branchId,gstinId,request,selectedId]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setDetail(null); setSelectedId(null); setForm(emptyForm());
    if (!branchId || !gstinId) { setLoading(false); return undefined; }
    Promise.all([
      request(`/api/price-adjustments/sources?branchId=${branchId}`),
      request(`/api/price-adjustments?branchId=${branchId}`),
      request(`/api/gst/periods?gstinId=${gstinId}`),
    ]).then(async ([sourceData,adjustmentData,periodData]) => {
      if (!active) return;
      setSources(sourceData.sources || []); setAdjustments(adjustmentData.adjustments || []); setPeriods(periodData.periods || []);
      setTaxPeriod(periodData.periods?.find(row => row.status === 'open')?.period || '');
      const id = adjustmentData.adjustments?.[0]?.id;
      if (id) { setSelectedId(id); setDetail((await request(`/api/price-adjustments/${id}`)).adjustment); }
    }).catch(cause => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  },[branchId,gstinId,companyId,userId,request]);

  const sourceById = useMemo(() => new Map(sources.map(row => [row.invoiceLineId,row])),[sources]);
  const selectedSource = sourceById.get(Number(form.invoiceLineId));
  const firstSelected = sourceById.get(form.lines[0]?.invoiceLineId);
  const eligibleSources = sources.filter(row => row.availableQuantity > 0 && !form.lines.some(line => line.invoiceLineId === row.invoiceLineId)
    && (!firstSelected || (row.invoiceType === firstSelected.invoiceType && row.partyId === firstSelected.partyId)));
  const preview = form.lines.reduce((sum,line) => {
    const source = sourceById.get(line.invoiceLineId);
    return sum + (source ? (line.newUnitPriceCents-source.unitPriceCents)*line.quantity : 0);
  },0);
  const outstanding = adjustments.filter(row => row.status === 'pending').length;
  const open = async id => {
    setSelectedId(id); setError('');
    try { setDetail((await request(`/api/price-adjustments/${id}`)).adjustment); }
    catch (cause) { setError(cause.message); }
  };
  const command = async (path,body,success) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await request(path,{method:'POST',body:JSON.stringify(body)});
      setNotice(data.replayed ? 'This decision was already recorded. No duplicate event was created.' : success);
      await reload(data.adjustment?.id);
      if (typeof refresh === 'function') refresh();
      return data;
    } catch (cause) { setError(cause.message); return null; }
    finally { setBusy(false); }
  };
  const addLine = () => {
    const invoiceLineId = Number(form.invoiceLineId);
    const quantity = Number(form.quantity);
    const newUnitPriceCents = Number(form.newUnitPriceCents);
    if (!selectedSource || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > selectedSource.availableQuantity) {
      setError('Enter a whole affected quantity within the source line’s available balance.'); return;
    }
    if (!Number.isSafeInteger(newUnitPriceCents) || newUnitPriceCents < 1 || newUnitPriceCents === selectedSource.unitPriceCents) {
      setError('Enter a new positive rate in paise that differs from the original rate.'); return;
    }
    setError('');
    setForm(previous => ({...previous,invoiceLineId:'',quantity:'',newUnitPriceCents:'',lines:[...previous.lines,{invoiceLineId,quantity,newUnitPriceCents}]}));
  };
  const create = async event => {
    event.preventDefault();
    if (!form.lines.length) { setError('Add at least one affected invoice line.'); return; }
    const data = await command('/api/price-adjustments',{
      clientReference:form.clientReference.trim(),reason:form.reason.trim(),lines:form.lines,
    },'Adjustment proposal saved. An independent accountant can review it.');
    if (data) setForm(emptyForm());
  };
  const review = async decision => {
    if (!reviewReason.trim()) { setError('Enter the commercial review reason.'); return; }
    const data = await command(`/api/price-adjustments/${detail.id}/review`,{decision,reason:reviewReason},`Commercial proposal ${decision}. Tax impact still needs its own review.`);
    if (data) setReviewReason('');
  };
  const reviewTax = async decision => {
    if (!taxPeriod || !taxReason.trim()) { setError('Choose a period and enter the tax review reason.'); return; }
    const data = await command(`/api/price-adjustments/${detail.id}/tax-review`,{decision,period:taxPeriod,reason:taxReason},`Local tax proposal ${decision}. GST and ledger totals remain unchanged.`);
    if (data) setTaxReason('');
  };

  return <section className="pad-page" aria-label="Price difference adjustments">
    <header className="pad-hero">
      <div><span className="pad-eyebrow">TRADE CONTROL · ERP-012</span><h1>Price adjustments</h1><p>Correct a rate against approved sale or purchase invoice quantities, then review the commercial and tax consequences separately.</p></div>
      <div className="pad-hero-metric"><strong>{outstanding}</strong><span>awaiting commercial review</span></div>
    </header>
    <div className="pad-scope"><strong>{company?.name || 'Selected company'}</strong><span>{gstin?.gstin || 'GSTIN'} / {branch?.name || 'Branch'}</span><span>{role || 'Current role'}</span></div>
    <p className="pad-boundary"><strong>Source invoices stay intact.</strong> These are local, reviewed proposals. Commercial approval does not adjust receivables, payables or journals. Tax review does not change GST totals, ITC or filing state. Rate basis and statutory tax treatment require separate documentation.</p>
    {error && <div className="pad-alert pad-error" role="alert">{error}</div>}
    {notice && <div className="pad-alert pad-success" role="status">{notice}</div>}
    {!branchId && <div className="pad-empty">Select a branch to see approved invoice lines and adjustments.</div>}
    {loading && <div className="pad-empty">Loading price adjustments…</div>}
    {!loading && branchId && <div className="pad-grid">
      <div className="pad-left">
        <section className="pad-panel pad-create"><div className="pad-panel-head"><div><span className="pad-step">01 / PREPARE</span><h2>New adjustment</h2></div><span className="pad-small-pill">Source linked</span></div>
          {canPrepare ? <form onSubmit={create}>
            <div className="pad-fields"><label>Unique reference<input required maxLength="100" value={form.clientReference} onChange={event=>setForm(previous=>({...previous,clientReference:event.target.value}))} placeholder="PRICE-MUM-001" /></label><label>Reason and rate evidence<input required maxLength="500" value={form.reason} onChange={event=>setForm(previous=>({...previous,reason:event.target.value}))} placeholder="Supplier rate letter, customer agreement…" /></label></div>
            <div className="pad-line-builder"><h3>Affected invoice lines</h3><label>Approved source line<select value={form.invoiceLineId} onChange={event=>setForm(previous=>({...previous,invoiceLineId:event.target.value,quantity:'',newUnitPriceCents:''}))}><option value="">Choose invoice and item</option>{eligibleSources.map(row=><option key={row.invoiceLineId} value={row.invoiceLineId}>{row.invoiceNumber} · {row.invoiceType} · {row.itemName} · {row.partyName} · {row.availableQuantity} available</option>)}</select></label>
              {selectedSource && <div className="pad-source-summary"><span>Original rate <strong>{rupees(selectedSource.unitPriceCents)}</strong></span><span>GST rate <strong>{selectedSource.gstRateBps/100}%</strong></span><span>Available <strong>{selectedSource.availableQuantity} / {selectedSource.quantity}</strong></span></div>}
              <div className="pad-add-grid"><label>Affected units<input type="number" min="1" max={selectedSource?.availableQuantity || undefined} step="1" value={form.quantity} onChange={event=>setForm(previous=>({...previous,quantity:event.target.value}))} /></label><label>New rate in paise<input type="number" min="1" step="1" value={form.newUnitPriceCents} onChange={event=>setForm(previous=>({...previous,newUnitPriceCents:event.target.value}))} placeholder="10005 = ₹100.05" /></label><button type="button" onClick={addLine} disabled={!selectedSource || busy}>Add line</button></div>
            </div>
            {form.lines.length > 0 && <div className="pad-draft-lines"><h3>Proposed lines</h3>{form.lines.map(line=>{const row=sourceById.get(line.invoiceLineId);return <div key={line.invoiceLineId}><span><strong>{row?.invoiceNumber || 'Invoice'}</strong> · {row?.itemName || 'Item'} · {line.quantity} units<br/><small>{rupees(row?.unitPriceCents)} → {rupees(line.newUnitPriceCents)} per unit</small></span><strong>{rupees((line.newUnitPriceCents-(row?.unitPriceCents || 0))*line.quantity)}</strong><button type="button" aria-label={`Remove invoice line ${line.invoiceLineId}`} onClick={()=>setForm(previous=>({...previous,lines:previous.lines.filter(item=>item.invoiceLineId!==line.invoiceLineId)}))}>×</button></div>})}<footer><span>Indicative commercial difference</span><strong>{rupees(preview)}</strong></footer></div>}
            <button className="pad-primary" disabled={busy || !form.lines.length}>Save proposal</button>
          </form> : <p className="pad-muted">This role can inspect proposals only.</p>}
        </section>
        <section className="pad-panel"><div className="pad-panel-head"><div><span className="pad-step">REGISTER</span><h2>Branch adjustments</h2></div><button className="pad-text-button" type="button" onClick={()=>reload()} disabled={busy}>Refresh</button></div>
          {!adjustments.length ? <p className="pad-empty">No price adjustments in this branch yet.</p> : <div className="pad-register">{adjustments.map(row=><button type="button" key={row.id} className={selectedId===row.id?'selected':''} onClick={()=>open(row.id)}><span><strong>{row.clientReference}</strong><small>{row.invoiceType} · {statusLabel(row.status)}</small></span><strong className={row.subtotalDeltaCents < 0 ? 'negative':''}>{rupees(row.subtotalDeltaCents)}</strong></button>)}</div>}
        </section>
      </div>
      <div className="pad-right">{detail ? <section className="pad-panel pad-detail"><div className="pad-panel-head"><div><span className="pad-step">02 / VERIFY</span><h2>{detail.clientReference}</h2></div><span className={`pad-status ${detail.status}`}>{statusLabel(detail.status)}</span></div>
        <div className="pad-detail-body"><p className="pad-muted">{detail.reason}</p><div className="pad-summary-grid"><div><span>Commercial difference</span><strong>{rupees(detail.subtotalDeltaCents)}</strong></div><div><span>Tax consequence proposal</span><strong>{rupees(detail.taxProposalCents)}</strong></div></div>
          <div className="pad-table-wrap"><table><caption>Original invoice rates and affected quantities</caption><thead><tr><th>Invoice / item</th><th>Units</th><th>Old rate</th><th>New rate</th><th>Difference</th></tr></thead><tbody>{detail.lines.map(row=><tr key={row.id}><td><strong>{row.invoiceNumber}</strong><small>{row.itemName}</small></td><td>{row.quantity}</td><td>{rupees(row.oldUnitPriceCents)}</td><td>{rupees(row.newUnitPriceCents)}</td><td>{rupees(row.subtotalDeltaCents)}</td></tr>)}</tbody></table></div>
          <div className="pad-review-card"><span className="pad-step">COMMERCIAL REVIEW</span>{detail.status==='pending' && canReview && detail.createdBy!==Number(userId) ? <><label>Review reason<input maxLength="500" value={reviewReason} onChange={event=>setReviewReason(event.target.value)} placeholder="Original invoice and rate evidence checked" /></label><div className="pad-actions"><button type="button" className="pad-primary" disabled={busy} onClick={()=>review('approved')}>Approve proposal</button><button type="button" className="pad-secondary" disabled={busy} onClick={()=>review('rejected')}>Reject</button></div></> : <p>{detail.status==='pending' ? 'Awaiting an accountant other than the preparer.' : `${statusLabel(detail.status)}${detail.reviewReason ? ` · ${detail.reviewReason}` : ''}`}</p>}</div>
          <div className="pad-review-card"><span className="pad-step">SEPARATE TAX REVIEW</span><p>Indicative GST difference at each source line’s original rate. Statutory treatment and note issuance require separate checks.</p>{detail.taxReview && <p className="pad-tax-outcome"><strong>{detail.taxReview.decision}</strong> · {detail.taxReview.period} · {detail.taxReview.reason}</p>}{detail.status==='approved' && canReview && detail.createdBy!==Number(userId) && (!detail.taxReview || detail.taxReview.decision==='deferred') && <><div className="pad-fields"><label>Local review period<select value={taxPeriod} onChange={event=>setTaxPeriod(event.target.value)}><option value="">Choose period</option>{periods.map(row=><option key={row.id} value={row.period}>{row.period} · {row.status}</option>)}</select></label><label>Tax review reason<input maxLength="500" value={taxReason} onChange={event=>setTaxReason(event.target.value)} placeholder="Tax basis and period checked" /></label></div><div className="pad-actions"><button type="button" className="pad-primary" disabled={busy} onClick={()=>reviewTax('accepted')}>Accept local proposal</button><button type="button" className="pad-secondary" disabled={busy} onClick={()=>reviewTax('deferred')}>Defer</button><button type="button" className="pad-secondary" disabled={busy} onClick={()=>reviewTax('rejected')}>Reject</button></div></>}</div>
          <details className="pad-audit"><summary>Audit trail · {detail.events.length + detail.taxEvents.length} events</summary><ol>{[...detail.events.map(row=>({key:`c${row.id}`,label:row.action,actorId:row.actorId,createdAt:row.createdAt})),...detail.taxEvents.map(row=>({key:`t${row.id}`,label:`Tax ${row.decision} · ${row.period}`,actorId:row.actorId,createdAt:row.createdAt}))].map(row=><li key={row.key}><strong>{row.label}</strong> · user #{row.actorId} · {row.createdAt}</li>)}</ol></details>
        </div></section> : <section className="pad-panel pad-empty-detail"><span className="pad-step">02 / VERIFY</span><h2>Select an adjustment</h2><p>Review the source rate, exact quantities, commercial difference and tax proposal.</p></section>}</div>
    </div>}
  </section>;
}
