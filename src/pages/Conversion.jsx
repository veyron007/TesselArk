import { useCallback, useEffect, useMemo, useState } from 'react';
import './conversion.css';

const blank = branchId => ({ branchId:String(branchId || ''),sourceItemId:'',targetItemId:'',sourceQuantity:'',ratioNumerator:'1',ratioDenominator:'1',allowedWastageQuantity:'0',actualWastageQuantity:'0',costBasisCents:'',costBasisReference:'',reason:'',clientReference:'' });
const money = cents => `₹${(Number(cents || 0)/100).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const quantity = value => Number(value || 0).toLocaleString('en-IN');

export default function Conversion({ context = {}, refresh }) {
  const company = context.bootstrap?.companies?.find(row => String(row.id) === String(context.companyId));
  const branches = company?.branches || [];
  const gstins = company?.gstins || [];
  const [form,setForm] = useState(() => blank(context.branchId));
  const [items,setItems] = useState([]);
  const [conversions,setConversions] = useState([]);
  const [detail,setDetail] = useState(null);
  const [preview,setPreview] = useState(null);
  const [previewKey,setPreviewKey] = useState('');
  const [reviewNote,setReviewNote] = useState('');
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const canDraft = ['staff','admin'].includes(context.role);
  const canReview = ['accountant','admin'].includes(context.role);
  const currentKey = JSON.stringify(form);
  const request = useCallback(async (path, init = {}) => {
    const response = context.apiFetch ? await context.apiFetch(path,init) : await fetch(path,{...init,headers:{'content-type':'application/json','x-company-id':context.companyId,'x-user-id':context.userId,...init.headers}});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  },[context.apiFetch,context.companyId,context.userId]);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [itemData,conversionData] = await Promise.all([request('/api/items'),request('/api/conversions')]);
      setItems((itemData.items || []).filter(row => row.active && row.trackStock));
      setConversions(conversionData.conversions || []);
    } catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  },[request]);
  useEffect(() => { setForm(blank(context.branchId)); setPreview(null); setPreviewKey(''); setDetail(null); load(); },[context.companyId,context.branchId,context.userId,load]);
  const branchLabel = id => { const branch=branches.find(row => row.id === Number(id)); const gstin=gstins.find(row => row.id === branch?.gstinId); return `${branch?.name || `Branch #${id}`} · ${gstin?.gstin || 'GSTIN'}`; };
  const selectedBranch = branches.find(row => row.id === Number(form.branchId));
  const body = useMemo(() => ({ branchId:Number(form.branchId),gstinId:selectedBranch?.gstinId,sourceItemId:Number(form.sourceItemId),targetItemId:Number(form.targetItemId),sourceQuantity:Number(form.sourceQuantity),ratioNumerator:Number(form.ratioNumerator),ratioDenominator:Number(form.ratioDenominator),allowedWastageQuantity:Number(form.allowedWastageQuantity),actualWastageQuantity:Number(form.actualWastageQuantity),costBasisCents:Number(form.costBasisCents),costBasisReference:form.costBasisReference.trim(),reason:form.reason.trim(),clientReference:form.clientReference.trim() }),[form,selectedBranch]);
  const update = (key,value) => { setForm(previous => ({...previous,[key]:value})); setPreview(null); setPreviewKey(''); };
  const command = async (path,payload,success) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result=await request(path,{method:'POST',body:JSON.stringify(payload)});
      setNotice(result.replayed ? 'Already recorded. No stock was posted twice.' : success);
      await load();
      if (result.conversion) setDetail(result);
      refresh?.();
      return result;
    } catch (cause) { setError(cause.message); return null; }
    finally { setBusy(false); }
  };
  const open = async id => { setError(''); try { setDetail(await request(`/api/conversions/${id}`)); } catch (cause) { setError(cause.message); } };
  const costPerUnit = conversion => conversion.targetQuantity ? money(conversion.costBasisCents/conversion.targetQuantity) : '—';
  const conversion = detail?.conversion;

  return <section className="conversion-page" aria-label="Stock conversion and packing">
    <header className="conversion-header"><div><p className="conversion-kicker">INVENTORY / ERP-005</p><h1>Stock conversion & packing</h1><p>Prepare a whole unit conversion, record allowed wastage and a documented cost basis, then obtain an independent review before posting stock.</p></div><button type="button" onClick={load} disabled={busy || loading}>Refresh</button></header>
    <div className="conversion-scope"><strong>{company?.name || 'Selected company'}</strong><span>{branchLabel(context.branchId)}</span><span>{context.role || 'Current role'}</span></div>
    <p className="conversion-boundary">This is a local stock quantity workflow. The cost basis below is entered from a referenced document; the app does not calculate inventory valuation or post accounting, tax or filing entries. Target stock enters unbatched. Source stock assigned to a location must be classified out first.</p>
    {error && <p className="conversion-alert conversion-error" role="alert">{error}</p>}
    {notice && <p className="conversion-alert conversion-success" role="status">{notice}</p>}
    {loading && <p>Loading conversions…</p>}
    <div className="conversion-columns">
      <div className="conversion-panel">
        <h2>Prepare conversion</h2>
        {!canDraft && <p>Staff or admin access is required to prepare a draft. You can inspect and review conversions in your granted branches.</p>}
        {canDraft && <form onSubmit={async event => { event.preventDefault(); const result=await command('/api/conversions',body,'Draft created. Submit it for independent review.'); if (result) { setPreview(null); setPreviewKey(''); } }}>
          <label>Branch and GSTIN<select required value={form.branchId} onChange={event => update('branchId',event.target.value)}><option value="">Choose branch</option>{branches.map(row => <option key={row.id} value={row.id}>{branchLabel(row.id)}</option>)}</select></label>
          <div className="conversion-form-grid">
            <label>Source tracked item<select required value={form.sourceItemId} onChange={event => update('sourceItemId',event.target.value)}><option value="">Choose source</option>{items.map(row => <option key={row.id} value={row.id}>{row.sku} · {row.name} ({row.unit})</option>)}</select></label>
            <label>Target tracked item<select required value={form.targetItemId} onChange={event => update('targetItemId',event.target.value)}><option value="">Choose target</option>{items.filter(row => String(row.id)!==form.sourceItemId).map(row => <option key={row.id} value={row.id}>{row.sku} · {row.name} ({row.unit})</option>)}</select></label>
            <label>Source quantity<input required type="number" min="1" step="1" value={form.sourceQuantity} onChange={event => update('sourceQuantity',event.target.value)} /></label>
            <label>Target units per source: numerator<input required type="number" min="1" step="1" value={form.ratioNumerator} onChange={event => update('ratioNumerator',event.target.value)} /></label>
            <label>Target units per source: denominator<input required type="number" min="1" step="1" value={form.ratioDenominator} onChange={event => update('ratioDenominator',event.target.value)} /></label>
            <label>Allowed wastage (target units)<input required type="number" min="0" step="1" value={form.allowedWastageQuantity} onChange={event => update('allowedWastageQuantity',event.target.value)} /></label>
            <label>Actual wastage (target units)<input required type="number" min="0" step="1" value={form.actualWastageQuantity} onChange={event => update('actualWastageQuantity',event.target.value)} /></label>
            <label>Documented total cost basis (paise)<input required type="number" min="0" step="1" value={form.costBasisCents} onChange={event => update('costBasisCents',event.target.value)} /></label>
          </div>
          <label>Cost basis document or calculation reference<input required maxLength="200" value={form.costBasisReference} onChange={event => update('costBasisReference',event.target.value)} placeholder="Supplier bill / approved calculation reference" /></label>
          <label>Reason<input required maxLength="400" value={form.reason} onChange={event => update('reason',event.target.value)} placeholder="Packing or conversion reason" /></label>
          <label>Unique conversion reference<input required maxLength="100" value={form.clientReference} onChange={event => update('clientReference',event.target.value)} placeholder="CONV-MUM-001" /></label>
          <div className="conversion-actions"><button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const result=await request('/api/conversions/preview',{method:'POST',body:JSON.stringify(body)}); setPreview(result); setPreviewKey(currentKey); } catch (cause) { setError(cause.message); } finally { setBusy(false); } }}>Preview quantity and cost</button><button disabled={busy || !preview || previewKey!==currentKey}>Save draft</button></div>
        </form>}
        {preview && previewKey===currentKey && <div className="conversion-preview"><h3>Preview</h3><p>{quantity(preview.sourceQuantity)} {preview.sourceItem.unit} × {quantity(preview.ratioNumerator)}/{quantity(preview.ratioDenominator)} = {quantity(preview.expectedTargetQuantity)} expected {preview.targetItem.unit}</p><p>{quantity(preview.actualWastageQuantity)} wastage within {quantity(preview.allowedWastageQuantity)} allowed → <strong>{quantity(preview.targetQuantity)} target units</strong></p><p>Source {quantity(preview.quantityBefore.sourceQuantity)} → {quantity(preview.quantityAfter.sourceQuantity)} · Target {quantity(preview.quantityBefore.targetQuantity)} → {quantity(preview.quantityAfter.targetQuantity)}</p><p>Documented total cost {money(preview.costBasisCents)} → {costPerUnit(preview)} per target unit. This is a preview, with no valuation posting.</p>{preview.quantityBefore.locationAssignedQuantity>0 && <p className="conversion-warning">Location assigned source stock blocks posting until it is classified out.</p>}</div>}
      </div>
      <div className="conversion-panel"><h2>Conversion register</h2>{!loading && conversions.length===0 && <p>No conversions in your granted branches.</p>}{conversions.length>0 && <div className="conversion-list">{conversions.map(row => <button type="button" className={conversion?.id===row.id?'selected':''} key={row.id} onClick={() => open(row.id)}><strong>{row.clientReference}</strong><span>{branchLabel(row.branchId)}</span><span>{row.status} · {quantity(row.sourceQuantity)} → {quantity(row.targetQuantity)}</span></button>)}</div>}</div>
    </div>
    {conversion && <div className="conversion-panel conversion-detail"><div className="conversion-detail-title"><div><p className="conversion-kicker">{conversion.status.toUpperCase()}</p><h2>{conversion.clientReference}</h2></div><button type="button" onClick={() => setDetail(null)}>Close</button></div><p>{branchLabel(conversion.branchId)} · Source item #{conversion.sourceItemId} → target item #{conversion.targetItemId}</p><p>{quantity(conversion.sourceQuantity)} × {quantity(conversion.ratioNumerator)}/{quantity(conversion.ratioDenominator)} = {quantity(conversion.expectedTargetQuantity)} expected; {quantity(conversion.actualWastageQuantity)} wasted within {quantity(conversion.allowedWastageQuantity)} allowed; <strong>{quantity(conversion.targetQuantity)} received</strong>.</p><p>Documented cost basis: {money(conversion.costBasisCents)} · {costPerUnit(conversion)} per target unit · {conversion.costBasisReference}</p><p>{conversion.reason}</p><p>Current stock: source {quantity(detail.availability?.sourceQuantity)} · target {quantity(detail.availability?.targetQuantity)}. Stock is rechecked when posted.</p>
      <div className="conversion-actions">{canDraft && conversion.status==='draft' && conversion.createdBy===Number(context.userId) && <button type="button" disabled={busy} onClick={() => command(`/api/conversions/${conversion.id}/submit`,{},'Submitted for independent review.')}>Submit</button>}{canReview && conversion.status==='submitted' && conversion.createdBy!==Number(context.userId) && <form onSubmit={async event => { event.preventDefault(); const result=await command(`/api/conversions/${conversion.id}/review`,{reviewNote},'Conversion reviewed.'); if (result) setReviewNote(''); }}><label>Review note<input required maxLength="500" value={reviewNote} onChange={event => setReviewNote(event.target.value)} placeholder="Ratio, wastage and cost document checked" /></label><button disabled={busy}>Approve review</button></form>}{canDraft && conversion.status==='reviewed' && <button type="button" disabled={busy} onClick={() => command(`/api/conversions/${conversion.id}/post`,{},'Source issue and target receipt posted once.')}>Post stock conversion</button>}</div>
      {conversion.status==='posted' && <p className="conversion-success">Posted movement IDs: source {(conversion.sourceMovementIds || []).join(', ')} · target {conversion.targetMovementId}. The cost basis remains a document only.</p>}
      <h3>Audit trail</h3><ol>{(detail.events || []).map(row => <li key={row.id}><strong>{row.action}</strong> · user #{row.actorId} · {row.createdAt}{row.details ? ` · ${row.details}` : ''}</li>)}</ol>
    </div>}
  </section>;
}
