import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './Delivery.css';

const today=()=>new Date().toISOString().slice(0,10);
const reference=prefix=>`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
const blankAttempt=()=>({clientReference:reference('delivery-attempt'),outcome:'partial',attemptDate:today(),quantities:{},proofMethod:'recipient_name',recipientName:'',proofReference:'',reason:'',note:''});
const blankCollection=()=>({clientReference:reference('delivery-collection'),reportedAmount:'',method:'cash',reference:'',note:''});
const amount=cents=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format((cents||0)/100);

export default function Delivery({context={},refresh,onNavigate}) {
  const [data,setData]=useState(null);
  const [selectedId,setSelectedId]=useState(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [assignment,setAssignment]=useState({fulfillmentId:'',assigneeId:'',address:'',clientReference:reference('delivery-assign')});
  const [attempt,setAttempt]=useState(blankAttempt);
  const [collection,setCollection]=useState(blankCollection);
  const api=useCallback(async(path,init={})=>{
    const response=await context.apiFetch(path,init);
    const result=await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(result.error||`Request failed (${response.status})`);
    return result;
  },[context.apiFetch]);
  const load=useCallback(async()=>{
    setLoading(true);
    try {
      const query=new URLSearchParams({gstinId:String(context.gstinId),branchId:String(context.branchId)});
      const next=await api(`/api/delivery?${query}`);
      setData(next);
      setSelectedId(current=>next.deliveries.some(item=>item.id===current)?current:next.deliveries[0]?.id??null);
    } catch(cause) { setError(cause.message); setData(null); } finally { setLoading(false); }
  },[api,context.gstinId,context.branchId]);
  useEffect(()=>{ setSelectedId(null); setError(''); load(); },[load,context.companyId]);
  const selected=useMemo(()=>data?.deliveries?.find(item=>item.id===selectedId)||null,[data,selectedId]);
  const company=context.bootstrap?.companies?.find(item=>String(item.id)===String(context.companyId));
  const gstin=company?.gstins?.find(item=>String(item.id)===String(context.gstinId));
  const branch=company?.branches?.find(item=>String(item.id)===String(context.branchId));
  const user=context.bootstrap?.users?.find(item=>String(item.id)===String(context.userId));
  const canWrite=['staff','admin'].includes(user?.role);
  const canAct=canWrite && selected && (user?.role==='admin' || Number(selected.assigneeId)===Number(context.userId));
  const mutate=async(action,message,onSuccess)=>{
    setBusy(true); setError(''); setNotice('');
    try { const result=await action(); await load(); refresh?.(); setNotice(result.replayed?`${message} Earlier save found; no duplicate added.`:message); onSuccess?.(result); }
    catch(cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const saveAssignment=event=>{
    event.preventDefault();
    mutate(()=>api('/api/delivery',{method:'POST',body:JSON.stringify({fulfillmentId:Number(assignment.fulfillmentId),assigneeId:Number(assignment.assigneeId||context.userId),address:assignment.address.trim(),clientReference:assignment.clientReference})}),
      'Delivery assigned to the confirmed dispatch.',result=>{setSelectedId(result.delivery.id);setAssignment({fulfillmentId:'',assigneeId:'',address:'',clientReference:reference('delivery-assign')});});
  };
  const chooseDispatch=fulfillmentId=>{
    const dispatch=data?.dispatches?.find(item=>item.id===Number(fulfillmentId));
    setAssignment(current=>({...current,fulfillmentId,address:dispatch?.address||''}));
  };
  const saveAttempt=event=>{
    event.preventDefault();
    if (!selected) return;
    const lines=attempt.outcome==='failed'?[]:selected.lines.map(line=>({orderLineId:line.orderLineId,quantity:Number(attempt.quantities[line.orderLineId]||0)})).filter(line=>line.quantity>0);
    mutate(()=>api(`/api/delivery/${selected.id}/attempts`,{method:'POST',body:JSON.stringify({
      clientReference:attempt.clientReference,outcome:attempt.outcome,attemptDate:attempt.attemptDate,lines,
      proofMethod:attempt.outcome==='failed'?'none':attempt.proofMethod,recipientName:attempt.recipientName.trim(),
      proofReference:attempt.proofReference.trim(),reason:attempt.reason.trim(),note:attempt.note.trim()
    })}), 'Delivery attempt recorded. Dispatched stock and invoicing are unchanged.',()=>setAttempt(blankAttempt()));
  };
  const saveCollection=event=>{
    event.preventDefault(); if (!selected) return;
    mutate(()=>api(`/api/delivery/${selected.id}/collections`,{method:'POST',body:JSON.stringify({
      clientReference:collection.clientReference,reportedAmountCents:Math.round(Number(collection.reportedAmount)*100),
      method:collection.method,reference:collection.reference.trim(),note:collection.note.trim()
    })}), 'Collection report saved as unallocated. Record and allocate payment in Finance separately.',()=>setCollection(blankCollection()));
  };
  const changeAttempt=(name,value)=>setAttempt(current=>({...current,[name]:value}));
  const changeCollection=(name,value)=>setCollection(current=>({...current,[name]:value}));

  return <div className="delivery-page">
    <header className="delivery-hero"><div><span className="delivery-eyebrow">FULFILMENT · ERP-030</span><h1>Home delivery</h1><p>Assign confirmed dispatches, record each visit and keep the remaining handover quantity visible.</p></div><div className="delivery-scope"><strong>{company?.name||'Company'}</strong><span>{gstin?.gstin||'GSTIN'} · {branch?.name||'Branch'}</span><span>{user?.name||'User'} · {user?.role||'role'}</span></div></header>
    <div className="delivery-boundary">Proof here is staff reported recipient or reference metadata. No customer signature, photo, or independent verification is captured. Delivery collection reports are unallocated and do not mark invoices paid.</div>
    {error&&<div className="delivery-alert error" role="alert">{error}</div>}{notice&&<div className="delivery-alert success" role="status">{notice}</div>}
    <div className="delivery-grid"><section className="delivery-card"><div className="delivery-card-head"><div><span className="delivery-eyebrow">QUEUE</span><h2>Assigned dispatches</h2></div><span>{data?.deliveries?.length||0}</span></div>
      {loading?<p className="delivery-empty">Loading deliveries…</p>:!data?.deliveries?.length?<p className="delivery-empty">No delivery assigned in this branch yet.</p>:<div className="delivery-list">{data.deliveries.map(item=><button type="button" key={item.id} className={`delivery-row ${selectedId===item.id?'active':''}`} onClick={()=>{setSelectedId(item.id);setAttempt(blankAttempt());setCollection(blankCollection());}}><span className="delivery-row-top"><strong>{item.fulfillmentNumber}</strong><span className={`delivery-badge ${item.status}`}>{item.status.replace('_',' ')}</span></span><span>{item.partyNameSnapshot} · {item.orderNumber}</span><small>{item.assigneeName} · {item.remainingQuantity} of {item.lines.reduce((sum,line)=>sum+line.dispatchedQuantity,0)} to deliver</small></button>)}</div>}
      {canWrite&&<form className="delivery-form delivery-assignment" onSubmit={saveAssignment}><h3>Assign a dispatch</h3><label>Confirmed sales dispatch<select required value={assignment.fulfillmentId} onChange={event=>chooseDispatch(event.target.value)}><option value="">Choose dispatch</option>{data?.dispatches?.map(item=><option key={item.id} value={item.id}>{item.number} · {item.orderNumber} · {item.quantity} units</option>)}</select></label><label>Delivery staff<select required value={assignment.assigneeId||String(context.userId)} disabled={user?.role!=='admin'} onChange={event=>setAssignment(current=>({...current,assigneeId:event.target.value}))}>{data?.users?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Delivery address<textarea required maxLength="500" rows="2" value={assignment.address} onChange={event=>setAssignment(current=>({...current,address:event.target.value}))}/></label><button className="delivery-primary" disabled={busy||loading||!data?.dispatches?.length}>Assign delivery</button>{!data?.dispatches?.length&&<small className="delivery-muted">No unassigned confirmed sales dispatches in this branch.</small>}</form>}
    </section><section className="delivery-card delivery-detail"><div className="delivery-card-head"><div><span className="delivery-eyebrow">DELIVERY FILE</span><h2>{selected?.fulfillmentNumber||'Select a delivery'}</h2></div>{selected&&<span className={`delivery-badge ${selected.status}`}>{selected.status.replace('_',' ')}</span>}</div>
      {!selected?<p className="delivery-empty">Choose a delivery to see attempts, proof metadata and remaining quantities.</p>:<div className="delivery-detail-body"><div className="delivery-meta"><span><b>Customer</b>{selected.partyNameSnapshot}</span><span><b>Assigned to</b>{selected.assigneeName}</span><span><b>Dispatch date</b>{selected.eventDate}</span><span><b>Collection</b>{selected.collectionStatus.replace('_',' ')}</span></div>
        <div className="delivery-source"><div><span className="delivery-eyebrow">SOURCE ORDER & DISPATCH</span><strong>{selected.orderNumber} / {selected.fulfillmentNumber}</strong><small>{selected.address}</small></div><button type="button" className="delivery-link" onClick={()=>onNavigate?.('orders',selected.orderId)}>Open order ↗</button></div>
        <section><div className="delivery-section-head"><h3>Handover balance</h3><span>{selected.remainingQuantity} remaining</span></div><div className="delivery-lines">{selected.lines.map(line=><div key={line.orderLineId}><span><strong>{line.itemNameSnapshot}</strong><small>{line.deliveredQuantity} delivered of {line.dispatchedQuantity} dispatched</small></span><b>{line.remainingQuantity} left</b></div>)}</div></section>
        <section><div className="delivery-section-head"><h3>Visit history</h3><span>{selected.attempts.length} attempts</span></div>{!selected.attempts.length?<p className="delivery-muted">No visit recorded yet.</p>:<div className="delivery-history">{selected.attempts.map(item=><article key={item.id}><div><strong>{item.outcome} · {item.attemptDate}</strong><small>{item.createdAt}</small></div><p>{item.outcome==='failed'?item.reason:`${item.lines.reduce((sum,line)=>sum+line.quantity,0)} units handed over`}{item.note?` · ${item.note}`:''}</p>{item.outcome!=='failed'&&<small>Staff reported proof: {item.proofMethod.replace('_',' ')} · {item.recipientName||item.proofReference}</small>}</article>)}</div>}</section>
        {canAct&&selected.remainingQuantity>0&&<form className="delivery-form" onSubmit={saveAttempt}><h3>Record visit</h3><div className="delivery-fields"><label>Outcome<select value={attempt.outcome} onChange={event=>changeAttempt('outcome',event.target.value)}><option value="partial">Partial handover</option><option value="delivered">Full handover</option><option value="failed">Failed visit</option></select></label><label>Visit date<input type="date" required value={attempt.attemptDate} onChange={event=>changeAttempt('attemptDate',event.target.value)}/></label></div>{attempt.outcome!=='failed'&&<><div className="delivery-quantity-list">{selected.lines.filter(line=>line.remainingQuantity>0).map(line=><label key={line.orderLineId}><span>{line.itemNameSnapshot}<small>Maximum {line.remainingQuantity}</small></span><input type="number" min="0" max={line.remainingQuantity} step="1" value={attempt.quantities[line.orderLineId]??''} onChange={event=>setAttempt(current=>({...current,quantities:{...current.quantities,[line.orderLineId]:event.target.value}}))}/></label>)}</div><div className="delivery-fields"><label>Reported proof<select value={attempt.proofMethod} onChange={event=>changeAttempt('proofMethod',event.target.value)}><option value="recipient_name">Recipient name</option><option value="reference_code">Reference code</option></select></label>{attempt.proofMethod==='recipient_name'?<label>Recipient name<input required maxLength="120" value={attempt.recipientName} onChange={event=>changeAttempt('recipientName',event.target.value)}/></label>:<label>Reference code<input required maxLength="120" value={attempt.proofReference} onChange={event=>changeAttempt('proofReference',event.target.value)}/></label>}</div></>}{attempt.outcome==='failed'&&<label>Failure reason<input required maxLength="300" value={attempt.reason} onChange={event=>changeAttempt('reason',event.target.value)}/></label>}<label>Staff note<textarea maxLength="500" rows="2" value={attempt.note} onChange={event=>changeAttempt('note',event.target.value)}/></label><button className="delivery-primary" disabled={busy}>Save visit</button></form>}
        <section><div className="delivery-section-head"><h3>Reported collections</h3><span>{selected.collections.length} reports</span></div>{!selected.collections.length?<p className="delivery-muted">No collection reported. Delivery state does not imply payment.</p>:<div className="delivery-history">{selected.collections.map(item=><article key={item.id}><div><strong>{amount(item.reportedAmountCents)} · {item.method}</strong><small>{item.createdAt}</small></div><p>{item.reference} · {item.note}</p><small>Reported, unallocated · no Finance payment posted</small></article>)}</div>}</section>
        {canAct&&<form className="delivery-form" onSubmit={saveCollection}><h3>Report collection</h3><p className="delivery-muted">Documentary report only. Allocate an actual payment in Finance.</p><div className="delivery-fields"><label>Amount ₹<input type="number" required min="0.01" step="0.01" value={collection.reportedAmount} onChange={event=>changeCollection('reportedAmount',event.target.value)}/></label><label>Method<select value={collection.method} onChange={event=>changeCollection('method',event.target.value)}><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank</option><option value="other">Other</option></select></label></div><label>Staff reference<input required maxLength="120" value={collection.reference} onChange={event=>changeCollection('reference',event.target.value)}/></label><label>Note<textarea required maxLength="500" rows="2" value={collection.note} onChange={event=>changeCollection('note',event.target.value)}/></label><button className="delivery-primary secondary" disabled={busy}>Save unallocated report</button></form>}
      </div>}
    </section></div>
  </div>;
}
