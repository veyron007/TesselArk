import { useCallback, useEffect, useMemo, useState } from 'react';
import './return-inspection.css';

const stamp = value => value ? new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z')).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) : '—';

export default function ReturnInspection({ context, refresh }) {
  const { companyId, branchId, apiFetch, role } = context;
  const [receipts,setReceipts] = useState([]);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [filter,setFilter] = useState('quarantined');
  const [editing,setEditing] = useState(null);
  const [disposition,setDisposition] = useState('release');
  const [reason,setReason] = useState('');
  const [revision,setRevision] = useState(0);
  const canInspect = role === 'accountant' || role === 'admin';
  const request = useCallback(async (path,options) => {
    const response = await apiFetch(path,options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  },[apiFetch]);
  useEffect(() => {
    let active=true;
    setReceipts([]); setLoading(true); setError(''); setEditing(null);
    request(`/api/returns/quarantine?branchId=${encodeURIComponent(branchId)}`)
      .then(data => { if (active) setReceipts(data.receipts || []); })
      .catch(cause => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active=false; };
  },[request,companyId,branchId,revision]);
  useEffect(() => { setNotice(''); },[companyId,branchId]);
  const counts=useMemo(() => ({
    quarantined:receipts.filter(row=>row.status==='quarantined').reduce((sum,row)=>sum+row.quantity,0),
    released:receipts.filter(row=>row.status==='released').reduce((sum,row)=>sum+row.quantity,0),
    rejected:receipts.filter(row=>row.status==='rejected').reduce((sum,row)=>sum+row.quantity,0),
  }),[receipts]);
  const visible=receipts.filter(row=>filter==='all' || row.status===filter);
  const inspect=async event => {
    event.preventDefault();
    if (!editing || !reason.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result=await request(`/api/returns/quarantine/${editing}/inspect`,{method:'POST',body:JSON.stringify({disposition,reason:reason.trim()})});
      setNotice(result.receipt.status==='released' ? `${result.receipt.quantity} unit${result.receipt.quantity===1?'':'s'} released to saleable stock${result.receipt.batchCode ? ` in lot ${result.receipt.batchCode}` : ''}.` : `${result.receipt.quantity} unit${result.receipt.quantity===1?'':'s'} rejected; saleable stock is unchanged.`);
      setEditing(null); setReason(''); setRevision(value=>value+1); refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <div className="return-inspection">
    <header className="ri-header"><div><p className="ri-eyebrow">STOCK CONTROL / RETURNS</p><h1>Return inspection</h1><p>Customer returns remain in quarantine until a reviewer releases the original lot or rejects the receipt.</p></div><span className="ri-scope">Branch #{branchId}</span></header>
    <div className="ri-metrics" aria-label="Return inspection quantities"><div><span>Awaiting inspection</span><strong>{counts.quarantined}</strong><small>physical units · not saleable</small></div><div><span>Released</span><strong>{counts.released}</strong><small>posted back to stock</small></div><div><span>Rejected</span><strong>{counts.rejected}</strong><small>excluded from stock</small></div></div>
    <div className="ri-note"><strong>Stock control</strong><span>Approval records the physical receipt and its original outbound movement. Release posts one new stock movement; lot tracked units return to their source lot. Rejection keeps the units outside available stock.</span></div>
    {error && <div className="ri-alert ri-error" role="alert">{error}</div>}
    {notice && <div className="ri-alert ri-success" role="status">{notice}</div>}
    <section className="ri-panel"><div className="ri-panel-top"><div><h2>Inspection queue</h2><p>Source movement and lot provenance stay attached to every receipt.</p></div><label>Show<select aria-label="Inspection status" value={filter} onChange={event=>setFilter(event.target.value)}><option value="quarantined">Awaiting inspection</option><option value="all">All receipts</option><option value="released">Released</option><option value="rejected">Rejected</option></select></label></div>
      {loading ? <p className="ri-empty">Loading return receipts…</p> : visible.length===0 ? <p className="ri-empty">No {filter==='all'?'return receipts':filter+' receipts'} for this branch.</p> : <div className="ri-list">{visible.map(row=><article key={row.id} className="ri-card">
        <div className="ri-card-head"><div><span className="ri-item">{row.itemName}</span><span className="ri-sub">{row.sku} · {row.returnNumber} · Source {row.invoiceNumber}</span></div><span className={`ri-status ${row.status}`}>{row.status}</span></div>
        <div className="ri-card-grid"><div><small>Physical receipt</small><strong>{row.quantity} unit{row.quantity===1?'':'s'}</strong></div><div><small>Source lot</small><strong>{row.batchCode || 'Unbatched'}</strong></div><div><small>Outbound movement</small><strong>#{row.sourceStockMovementId}</strong></div><div><small>Saleable stock</small><strong>{row.status==='released'?'Posted':'Excluded'}</strong></div></div>
        {row.events?.length>0 && <details className="ri-history"><summary>Audit history · {row.events.length} event{row.events.length===1?'':'s'}</summary><ol>{row.events.map((event,index)=><li key={index}><strong>{event.action}</strong><span>{event.details}</span><small>{stamp(event.createdAt)} · actor #{event.actorId}</small></li>)}</ol></details>}
        {row.status==='quarantined' && (canInspect ? <div className="ri-actions"><button type="button" onClick={()=>{setEditing(row.id);setDisposition('release');setReason('');setError('');}}>Inspect receipt</button></div> : <p className="ri-readonly">Accountant or admin review required.</p>)}
        {editing===row.id && <form className="ri-form" onSubmit={inspect}><label>Inspection outcome<select value={disposition} onChange={event=>setDisposition(event.target.value)}><option value="release">Release to saleable stock</option><option value="reject">Reject receipt</option></select></label><label>Inspection findings<textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength="500" rows="3" required placeholder="Record condition, packaging, expiry, and review evidence" /></label><p>{disposition==='release' ? `Releases ${row.quantity} unit${row.quantity===1?'':'s'} ${row.batchCode?`to lot ${row.batchCode}`:'as unbatched stock'}.` : 'Keeps these units outside saleable stock.'}</p><div><button type="submit" disabled={busy||!reason.trim()}>{busy?'Saving…':'Confirm '+disposition}</button><button type="button" className="ri-cancel" onClick={()=>setEditing(null)}>Cancel</button></div></form>}
      </article>)}</div>}
    </section>
  </div>;
}
