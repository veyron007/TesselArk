import { useCallback, useEffect, useMemo, useState } from 'react';
import './counts.css';

const number = value => Number(value || 0).toLocaleString('en-IN');
const message = error => error instanceof Error ? error.message : String(error);

export default function Counts({ context = {}, refresh }) {
  const [tab,setTab]=useState('counts');
  const [sessions,setSessions]=useState([]);
  const [selectedId,setSelectedId]=useState(null);
  const [drafts,setDrafts]=useState({});
  const [lookup,setLookup]=useState('');
  const [reviewReason,setReviewReason]=useState('');
  const [planning,setPlanning]=useState({lookbackDays:90,coverDays:30});
  const [replenishment,setReplenishment]=useState({rows:[],proposals:[]});
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const company=context.bootstrap?.companies?.find(row=>String(row.id)===String(context.companyId));
  const branch=company?.branches?.find(row=>String(row.id)===String(context.branchId));
  const gstin=company?.gstins?.find(row=>String(row.id)===String(context.gstinId));
  const user=context.bootstrap?.users?.find(row=>String(row.id)===String(context.userId));
  const mayPrepare=['staff','admin'].includes(user?.role);
  const mayReview=['accountant','admin'].includes(user?.role);
  const request=useCallback(async(path,init={})=>{
    const response=await context.apiFetch(path,init);
    const body=await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  },[context.apiFetch]);
  const load=useCallback(async()=>{
    if (!context.branchId || !context.gstinId) return;
    setLoading(true); setError('');
    try {
      const scope=`branchId=${context.branchId}&gstinId=${context.gstinId}`;
      const [counts,plans]=await Promise.all([
        request(`/api/counts?${scope}`),
        request(`/api/replenishment?${scope}&lookbackDays=${planning.lookbackDays}&coverDays=${planning.coverDays}`),
      ]);
      setSessions(counts.sessions || []);
      setReplenishment(plans);
    } catch(cause) {setError(message(cause));}
    finally {setLoading(false);}
  },[context.branchId,context.gstinId,planning.lookbackDays,planning.coverDays,request]);
  useEffect(()=>{setSelectedId(null);setDrafts({});setLookup('');setNotice('');},[context.companyId,context.branchId,context.gstinId]);
  useEffect(()=>{load();},[load]);
  const selected=sessions.find(row=>row.id===selectedId) || sessions[0] || null;
  const visibleLines=useMemo(()=>selected?.lines || [],[selected]);
  const lookupLine=visibleLines.find(row=>row.sku.toLowerCase()===lookup.trim().toLowerCase());
  const updateLine=(id,key,value)=>setDrafts(current=>({...current,[id]:{...current[id],[key]:value}}));
  const transact=async(action,success)=>{
    setBusy(true);setError('');setNotice('');
    try {await action();await load();refresh?.();setNotice(success);}
    catch(cause){setError(message(cause));}
    finally{setBusy(false);}
  };
  const saveLine=line=>{
    const value=drafts[line.id] || {};
    return transact(()=>request(`/api/counts/${selected.id}/lines/${line.id}`,{method:'PUT',body:JSON.stringify({countedQuantity:Number(value.countedQuantity ?? line.countedQuantity),reason:value.reason ?? line.reason})}),`${line.sku} count saved.`);
  };
  const reviewCount=decision=>transact(()=>request(`/api/counts/${selected.id}/review`,{method:'POST',body:JSON.stringify({decision,reason:reviewReason.trim()})}),`Count ${decision==='approve'?'approved and adjusted':'rejected'}.`);
  const reviewProposal=(id,decision)=>transact(()=>request(`/api/replenishment/proposals/${id}/review`,{method:'POST',body:JSON.stringify({decision,reason:reviewReason.trim()})}),`Proposal ${decision==='approve'?'approved for purchasing review':'rejected'}.`);
  return <main className="counts-page">
    <header className="counts-head"><div><p className="counts-kicker">INVENTORY / CONTROL</p><h1>Counts & replenishment</h1><p>Compare physical quantities with a branch snapshot, then review shortages and purchasing needs.</p></div><button type="button" className="counts-secondary" onClick={load} disabled={loading}>Refresh</button></header>
    <div className="counts-context"><strong>{company?.name || 'Company'}</strong><span>{gstin?.gstin || 'GSTIN'}</span><span>{branch?.name || 'Branch'}</span><span>{user?.name || 'User'} · {user?.role || 'role'}</span></div>
    {error&&<div className="counts-alert error" role="alert">{error}</div>}{notice&&<div className="counts-alert success" role="status">{notice}</div>}
    <div className="counts-tabs" role="tablist" aria-label="Inventory workflow"><button type="button" role="tab" aria-selected={tab==='counts'} onClick={()=>setTab('counts')}>Physical counts</button><button type="button" role="tab" aria-selected={tab==='reorder'} onClick={()=>setTab('reorder')}>Replenishment</button></div>
    {tab==='counts'?<>
      <div className="counts-explainer">A new count captures recorded stock now. The creator enters every quantity and explains differences. An accountant or admin who did not create it reviews the result. Approval checks for later stock changes and for batch or location allocations before posting one adjustment per difference.</div>
      <div className="counts-layout"><section className="counts-card"><div className="counts-card-head"><h2>Count sessions</h2>{mayPrepare&&<button type="button" className="counts-primary" disabled={busy || loading} onClick={()=>transact(async()=>{const result=await request('/api/counts',{method:'POST',body:JSON.stringify({gstinId:Number(context.gstinId),branchId:Number(context.branchId)})});setSelectedId(result.session.id);},'Count snapshot created. Enter physical quantities.')}>New count</button>}</div>
        {loading?<p className="counts-empty">Loading counts…</p>:sessions.length===0?<p className="counts-empty">No counts in this branch yet.</p>:<div className="counts-session-list">{sessions.map(row=><button type="button" key={row.id} className={selected?.id===row.id?'chosen':''} onClick={()=>{setSelectedId(row.id);setDrafts({});setLookup('');setReviewReason('');}}><span><strong>Count #{row.id}</strong><small>{new Date(`${row.createdAt}Z`).toLocaleString('en-IN')} · {row.lines.length} items</small></span><span className={`counts-status ${row.status}`}>{row.status}</span></button>)}</div>}</section>
      <section className="counts-card counts-work"><div className="counts-card-head"><div><h2>{selected?`Count #${selected.id}`:'Select a count'}</h2>{selected&&<p>Recorded stock at snapshot · {selected.lines.filter(line=>line.difference!==null && line.difference!==0).length} differences</p>}</div>{selected&&<span className={`counts-status ${selected.status}`}>{selected.status}</span>}</div>
        {!selected?<p className="counts-empty">Create or select a count session.</p>:<>
          {selected.status==='draft'&&<label className="counts-lookup">Find by SKU<input value={lookup} onChange={event=>setLookup(event.target.value)} placeholder="Type or scan a SKU label" />{lookup&&<small>{lookupLine?`Found ${lookupLine.itemName}`:'No item in this count matches that SKU.'}</small>}</label>}
          <div className="counts-table-wrap"><table><thead><tr><th>Item</th><th className="numeric">Recorded</th><th>Physical count</th><th>Difference reason</th><th className="numeric">Difference</th><th>Action</th></tr></thead><tbody>{visibleLines.filter(row=>!lookup || row.sku.toLowerCase().includes(lookup.trim().toLowerCase())).map(line=>{const draft=drafts[line.id] || {};const canEdit=selected.status==='draft' && selected.createdBy===Number(context.userId) && mayPrepare;return <tr key={line.id}><td><strong>{line.sku}</strong><small>{line.itemName}</small>{line.stockMovementId&&<small>Stock movement #{line.stockMovementId}</small>}</td><td className="numeric">{number(line.recordedQuantity)}</td><td>{canEdit?<input aria-label={`${line.sku} physical quantity`} type="number" min="0" step="1" value={draft.countedQuantity ?? line.countedQuantity ?? ''} onChange={event=>updateLine(line.id,'countedQuantity',event.target.value)} />:line.countedQuantity===null?'—':number(line.countedQuantity)}</td><td>{canEdit?<input aria-label={`${line.sku} difference reason`} maxLength="500" value={draft.reason ?? line.reason} onChange={event=>updateLine(line.id,'reason',event.target.value)} placeholder="Required if different" />:line.reason || '—'}</td><td className={`numeric ${line.difference<0?'shortage':''}`}>{line.difference===null?'—':line.difference>0?`+${number(line.difference)}`:number(line.difference)}</td><td>{canEdit&&<button type="button" className="counts-link" disabled={busy || draft.countedQuantity==='' || (draft.countedQuantity===undefined && line.countedQuantity===null)} onClick={()=>saveLine(line)}>Save</button>}</td></tr>;})}</tbody></table></div>
          {selected.status==='draft'&&selected.createdBy===Number(context.userId)&&mayPrepare&&<button type="button" className="counts-primary counts-submit" disabled={busy || selected.lines.some(line=>line.countedQuantity===null)} onClick={()=>transact(()=>request(`/api/counts/${selected.id}/submit`,{method:'POST',body:'{}'}),'Count submitted for independent review.')}>Submit for review</button>}
          {selected.status==='submitted'&&mayReview&&selected.createdBy!==Number(context.userId)&&<div className="counts-review"><label>Reviewer note<input maxLength="500" value={reviewReason} onChange={event=>setReviewReason(event.target.value)} placeholder="Evidence checked or rejection reason" /></label><div><button type="button" className="counts-primary" disabled={busy} onClick={()=>reviewCount('approve')}>Approve & post adjustments</button><button type="button" className="counts-secondary" disabled={busy || !reviewReason.trim()} onClick={()=>reviewCount('reject')}>Reject count</button></div></div>}
          {selected.status==='approved'&&<p className="counts-footnote">Approved adjustments are posted once. Stock movement IDs appear beside each changed count line in the audit record.</p>}
          <details className="counts-audit"><summary>Audit trail · {selected.events.length} events</summary><ol>{selected.events.map(event=><li key={event.id}><strong>{event.action.replace('_',' ')}</strong> · user #{event.actorId} · {event.createdAt}{event.details&&<small>{event.details}</small>}</li>)}</ol></details>
        </>}</section></div>
    </>:<>
      <div className="counts-explainer">Arithmetic uses approved sale invoices and confirmed dispatches without an approved linked invoice over the chosen window. Open confirmed sales orders add demand; pending confirmed purchase orders add supply. Fulfilled order quantities are excluded from those open balances. A reviewed proposal authorizes purchasing review only; it creates no purchase order.</div>
      <div className="counts-plan-controls"><label>Sales lookback, days<input type="number" min="1" max="365" value={planning.lookbackDays} onChange={event=>setPlanning(current=>({...current,lookbackDays:Number(event.target.value)}))} /></label><label>Stock cover, days<input type="number" min="1" max="365" value={planning.coverDays} onChange={event=>setPlanning(current=>({...current,coverDays:Number(event.target.value)}))} /></label></div>
      <section className="counts-card"><div className="counts-card-head"><h2>Calculated shortages</h2><span>{replenishment.rows.filter(row=>row.proposedUnits>0).length} items need review</span></div>{loading?<p className="counts-empty">Calculating…</p>:<div className="counts-table-wrap"><table><thead><tr><th>Item</th><th className="numeric">Actual sales</th><th className="numeric">On hand</th><th className="numeric">Open sales</th><th className="numeric">Pending supply</th><th className="numeric">Target</th><th className="numeric">Proposal</th><th></th></tr></thead><tbody>{replenishment.rows.map(row=><tr key={row.itemId}><td><strong>{row.sku}</strong><small>{row.itemName}</small></td><td className="numeric">{number(row.actualSalesUnits)}</td><td className="numeric">{number(row.onHandUnits)}</td><td className="numeric">{number(row.openSalesUnits)}</td><td className="numeric">{number(row.pendingSupplyUnits)}</td><td className="numeric">{number(row.targetUnits)}</td><td className="numeric"><strong>{number(row.proposedUnits)}</strong></td><td>{mayPrepare&&row.proposedUnits>0&&<button type="button" className="counts-link" disabled={busy} onClick={()=>transact(()=>request('/api/replenishment/proposals',{method:'POST',body:JSON.stringify({gstinId:Number(context.gstinId),branchId:Number(context.branchId),itemId:row.itemId,lookbackDays:planning.lookbackDays,coverDays:planning.coverDays})}),`${row.sku} proposal saved for review.`)}>Save proposal</button>}</td></tr>)}</tbody></table></div>}</section>
      <section className="counts-card"><div className="counts-card-head"><h2>Proposal review</h2><span>{replenishment.proposals.length} saved</span></div>{replenishment.proposals.length===0?<p className="counts-empty">No saved proposals in this branch.</p>:<div className="counts-proposals">{replenishment.proposals.map(row=><article key={row.id}><div><strong>#{row.id} · {row.metrics.sku} · {number(row.metrics.proposedUnits)} units</strong><span className={`counts-status ${row.status}`}>{row.status}</span></div><p>On hand {number(row.metrics.onHandUnits)} + supply {number(row.metrics.pendingSupplyUnits)} − open sales {number(row.metrics.openSalesUnits)}; target {number(row.metrics.targetUnits)}.</p><small>Saved by user #{row.createdBy} · {row.createdAt}</small>{row.status==='pending'&&mayReview&&row.createdBy!==Number(context.userId)&&<div className="counts-review"><label>Reviewer note<input maxLength="500" value={reviewReason} onChange={event=>setReviewReason(event.target.value)} placeholder="Purchasing review or rejection reason" /></label><div><button type="button" className="counts-primary" disabled={busy} onClick={()=>reviewProposal(row.id,'approve')}>Approve proposal</button><button type="button" className="counts-secondary" disabled={busy || !reviewReason.trim()} onClick={()=>reviewProposal(row.id,'reject')}>Reject</button></div></div>}</article>)}</div>}</section>
    </>}
  </main>;
}
