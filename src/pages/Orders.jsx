import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './orders.css';

const today=()=>new Date().toISOString().slice(0,10);
const money=cents=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format((cents||0)/100);
const blankLine=()=>({itemId:'',quantity:'1',unitPrice:''});

export default function Orders({context={},refresh,onNavigate,onOpenInvoice,initialOrderId}) {
  const [type,setType]=useState('sale');
  const [orders,setOrders]=useState([]);
  const [items,setItems]=useState([]);
  const [parties,setParties]=useState([]);
  const [linkedInvoices,setLinkedInvoices]=useState([]);
  const [supplierRefs,setSupplierRefs]=useState({});
  const [selectedId,setSelectedId]=useState(null);
  const [form,setForm]=useState({number:'',partyId:'',orderDate:today(),notes:'',lines:[blankLine()]});
  const [fulfillment,setFulfillment]=useState({number:'',eventDate:today(),notes:'',quantities:{}});
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const api=useCallback(async(path,init={})=>{
    const response=await context.apiFetch(path,init);
    const data=await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(data.error||`Request failed (${response.status})`);
    return data;
  },[context.apiFetch]);
  const load=useCallback(async()=>{
    setLoading(true);setError('');setOrders([]);setItems([]);setParties([]);setLinkedInvoices([]);
    try {
      const scope=new URLSearchParams({gstinId:String(context.gstinId),branchId:String(context.branchId)});
      const [a,b,c,d]=await Promise.all([api(`/api/orders?${scope}`),api('/api/items'),api('/api/parties'),api(`/api/invoices?${scope}`)]);
      setOrders(a.orders||[]);setItems(b.items||[]);setParties(c.parties||[]);setLinkedInvoices(d.invoices||[]);
    } catch(cause){setError(cause.message);} finally{setLoading(false);}
  },[api,context.gstinId,context.branchId]);
  useEffect(()=>{setSelectedId(null);load();},[load,context.companyId]);
  useEffect(()=>{
    if (!initialOrderId || !orders.length) return;
    const linked=orders.find(order=>order.id===Number(initialOrderId));
    if (linked) { setType(linked.type); setSelectedId(linked.id); }
  },[initialOrderId,orders]);
  const selected=orders.find(order=>order.id===selectedId)||null;
  const filtered=orders.filter(order=>order.type===type);
  const availableParties=parties.filter(party=>party.type==='both'||party.type===(type==='sale'?'customer':'supplier'));
  const chosen=useMemo(()=>new Set(form.lines.map(line=>Number(line.itemId)).filter(Boolean)),[form.lines]);
  const mutate=async(action,success,afterSuccess)=>{
    setBusy(true);setError('');setNotice('');
    try { const result=await action(); await load(); refresh?.(); setNotice(success); afterSuccess?.(result); }
    catch(cause){setError(cause.message);} finally{setBusy(false);}
  };
  const setLine=(index,field,value)=>setForm(current=>({...current,lines:current.lines.map((line,at)=>at===index?{...line,[field]:value}:line)}));
  const create=event=>{
    event.preventDefault();
    const body={type,number:form.number.trim(),orderDate:form.orderDate,partyId:Number(form.partyId),gstinId:Number(context.gstinId),branchId:Number(context.branchId),notes:form.notes,lines:form.lines.map(line=>({itemId:Number(line.itemId),quantity:Number(line.quantity),unitPriceCents:Math.round(Number(line.unitPrice)*100)}))};
    mutate(async()=>{const result=await api('/api/orders',{method:'POST',body:JSON.stringify(body)});setSelectedId(result.order.id);setForm({number:'',partyId:'',orderDate:today(),notes:'',lines:[blankLine()]});},`${type==='sale'?'Sales':'Purchase'} order created as draft.`);
  };
  const confirmOrder=id=>mutate(()=>api(`/api/orders/${id}/confirm`,{method:'POST',body:'{}'}),'Order confirmed. Stock and accounts remain unchanged until a separate business event.');
  const createFulfillment=event=>{
    event.preventDefault();
    if (!selected) return;
    const lines=selected.lines.map(line=>({orderLineId:line.id,quantity:Number(fulfillment.quantities[line.id]||0)})).filter(line=>line.quantity>0);
    mutate(()=>api(`/api/orders/${selected.id}/fulfillments`,{method:'POST',body:JSON.stringify({number:fulfillment.number,eventDate:fulfillment.eventDate,notes:fulfillment.notes,lines})}),`${selected.type==='purchase'?'Receipt':'Dispatch'} saved as draft. Confirm it to post stock.`);
    setFulfillment({number:'',eventDate:today(),notes:'',quantities:{}});
  };
  const confirmFulfillment=id=>mutate(()=>api(`/api/orders/fulfillments/${id}/confirm`,{method:'POST',body:'{}'}),'Physical movement confirmed and stock updated once.');
  const createLinkedInvoice=entry=>{
    if (!selected) return;
    const supplierInvoiceNumber=(supplierRefs[entry.id]||'').trim();
    if (selected.type==='purchase'&&!supplierInvoiceNumber){setError('Enter the supplier invoice reference before creating a linked purchase bill.');return;}
    const lines=entry.lines.map(line=>{
      const source=selected.lines.find(item=>item.id===line.orderLineId);
      return {itemId:source.itemId,quantity:line.quantity,unitPriceCents:source.unitPriceCents,gstRateBps:source.gstRateBps};
    });
    const body={type:selected.type,fulfillmentId:entry.id,partyId:selected.partyId,branchId:selected.branchId,gstinId:selected.gstinId,invoiceDate:entry.eventDate,notes:`From ${selected.number} / ${entry.number}`,supplierInvoiceNumber,lines};
    mutate(()=>api('/api/invoices',{method:'POST',body:JSON.stringify(body)}),`Linked invoice draft created for ${entry.number}. Stock will not post again on approval.`,result=>{if(onOpenInvoice) onOpenInvoice(result.invoice.id); else onNavigate?.('operations',result.invoice.id);});
  };

  return <div className="orders-page">
    <div className="orders-intro"><div><span className="orders-kicker">PROCUREMENT & SALES</span><h1>Orders and fulfillment</h1><p>Confirm intent, then record partial receipts or dispatches against the same order.</p></div><span className="orders-context">{context.bootstrap?.companies?.find(company=>String(company.id)===String(context.companyId))?.name} · {context.bootstrap?.companies?.find(company=>String(company.id)===String(context.companyId))?.gstins?.find(gstin=>String(gstin.id)===String(context.gstinId))?.gstin}</span></div>
    <div className="orders-boundary"><strong>Operational workflow</strong><span>Orders and physical movements do not create invoices, revenue, payables or GST credit. Accounting requires a separate approved invoice.</span></div>
    {error&&<div className="orders-message error" role="alert">{error}</div>}{notice&&<div className="orders-message success" role="status">{notice}</div>}
    <div className="orders-tabs" role="tablist" aria-label="Order type">{[['sale','Sales orders'],['purchase','Purchase orders']].map(([value,label])=><button role="tab" aria-selected={type===value} className={type===value?'active':''} key={value} onClick={()=>{setType(value);setSelectedId(null);setForm({number:'',partyId:'',orderDate:today(),notes:'',lines:[blankLine()]});}}>{label}</button>)}</div>
    <div className="orders-layout"><section className="orders-card"><div className="orders-card-head"><h2>{type==='sale'?'Sales':'Purchase'} order register</h2><span>{filtered.length} records</span></div>
      {loading?<div className="orders-empty">Loading orders…</div>:!filtered.length?<div className="orders-empty"><strong>No {type} orders yet</strong><p>Create one with items from this company.</p></div>:<div className="orders-list">{filtered.map(order=><button type="button" key={order.id} className={`orders-row ${selectedId===order.id?'selected':''}`} onClick={()=>setSelectedId(order.id)}><span><strong>{order.number}</strong><small>{order.partyNameSnapshot} · {order.orderDate}</small></span><span className="orders-row-right"><span className={`orders-badge ${order.status}`}>{order.status}</span><small>{order.remainingQuantity} / {order.orderedQuantity} remaining</small></span></button>)}</div>}
    </section><section className="orders-card orders-work"><div className="orders-card-head"><h2>{selected?selected.number:`New ${type} order`}</h2>{selected&&<button className="orders-text-button" onClick={()=>setSelectedId(null)}>New order</button>}</div>
      {!selected?<form className="orders-form" onSubmit={create}><div className="orders-fields"><label>Order number<input required maxLength="60" value={form.number} onChange={event=>setForm(current=>({...current,number:event.target.value}))} placeholder={type==='sale'?'SO-2026-001':'PO-2026-001'}/></label><label>Order date<input type="date" required value={form.orderDate} onChange={event=>setForm(current=>({...current,orderDate:event.target.value}))}/></label><label>Counterparty<select required value={form.partyId} onChange={event=>setForm(current=>({...current,partyId:event.target.value}))}><option value="">Choose {type==='sale'?'customer':'supplier'}</option>{availableParties.map(party=><option value={party.id} key={party.id}>{party.name}</option>)}</select></label></div>
        <div className="orders-section-label">Order lines</div><div className="orders-form-lines">{form.lines.map((line,index)=><div className="orders-form-line" key={index}><label>Item<select required value={line.itemId} onChange={event=>setLine(index,'itemId',event.target.value)}><option value="">Choose item</option>{items.filter(item=>!chosen.has(item.id)||Number(line.itemId)===item.id).map(item=><option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></label><label>Quantity<input type="number" min="1" step="1" required value={line.quantity} onChange={event=>setLine(index,'quantity',event.target.value)}/></label><label>Unit price ₹<input type="number" min="0" step="0.01" required value={line.unitPrice} onChange={event=>setLine(index,'unitPrice',event.target.value)}/></label><button type="button" aria-label="Remove line" disabled={form.lines.length===1} onClick={()=>setForm(current=>({...current,lines:current.lines.filter((_,at)=>at!==index)}))}>×</button></div>)}</div><button className="orders-text-button" type="button" onClick={()=>setForm(current=>({...current,lines:[...current.lines,blankLine()]}))}>+ Add line</button><label className="orders-notes">Notes<textarea maxLength="1000" rows="2" value={form.notes} onChange={event=>setForm(current=>({...current,notes:event.target.value}))}/></label><button className="orders-primary" disabled={busy||loading} type="submit">{busy?'Saving…':'Create draft order'}</button></form>
      :<div className="orders-detail"><div className="orders-detail-meta"><span>{selected.partyNameSnapshot}</span><span>{selected.orderDate}</span><span className={`orders-badge ${selected.status}`}>{selected.status}</span></div><div className="orders-detail-lines">{selected.lines.map(line=><div key={line.id}><span><strong>{line.itemNameSnapshot}</strong><small>{line.sku} · {money(line.unitPriceCents)} each</small></span><span><strong>{line.remainingQuantity} remaining</strong><small>{line.confirmedQuantity} of {line.quantity} fulfilled</small></span></div>)}</div><div className="orders-total"><span>Order subtotal · excludes GST estimate</span><strong>{money(selected.subtotalCents)}</strong></div>{selected.status==='draft'?<button className="orders-primary" disabled={busy} onClick={()=>confirmOrder(selected.id)}>Confirm order</button>:<><div className="orders-section-label">Record {type==='purchase'?'goods receipt':'delivery dispatch'}</div><form onSubmit={createFulfillment} className="orders-form"><div className="orders-fields"><label>Document number<input required value={fulfillment.number} onChange={event=>setFulfillment(current=>({...current,number:event.target.value}))} placeholder={type==='purchase'?'GRN-001':'DC-001'}/></label><label>Date<input type="date" required value={fulfillment.eventDate} onChange={event=>setFulfillment(current=>({...current,eventDate:event.target.value}))}/></label></div>{selected.lines.filter(line=>line.remainingQuantity>0).map(line=><label className="orders-quantity" key={line.id}><span>{line.itemNameSnapshot}<small>Maximum {line.remainingQuantity}</small></span><input type="number" min="0" max={line.remainingQuantity} step="1" value={fulfillment.quantities[line.id]??''} placeholder="0" onChange={event=>setFulfillment(current=>({...current,quantities:{...current.quantities,[line.id]:event.target.value}}))}/></label>)}{selected.remainingQuantity>0?<button className="orders-primary" disabled={busy} type="submit">Save draft {type==='purchase'?'receipt':'dispatch'}</button>:<div className="orders-complete">All quantities fulfilled.</div>}</form><div className="orders-section-label">Receipts & dispatches</div>{!selected.fulfillments.length?<p className="orders-muted">No physical events yet.</p>:<div className="orders-fulfillments">{selected.fulfillments.map(entry=>{const invoice=linkedInvoices.find(row=>row.fulfillmentId===entry.id);return <div key={entry.id}><span><strong>{entry.number}</strong><small>{entry.eventDate} · {entry.lines.reduce((total,line)=>total+line.quantity,0)} units</small></span><span className={`orders-badge ${entry.status}`}>{entry.status}</span>{entry.status==='draft'&&<button className="orders-text-button" disabled={busy} onClick={()=>confirmFulfillment(entry.id)}>Confirm & post stock</button>}{entry.status==='confirmed'&&(invoice?<span className="orders-invoice-link">{invoice.number} · {invoice.status}</span>:<div className="orders-invoice-action">{selected.type==='purchase'&&<input aria-label={`Supplier invoice reference for ${entry.number}`} placeholder="Supplier bill no." value={supplierRefs[entry.id]||''} onChange={event=>setSupplierRefs(current=>({...current,[entry.id]:event.target.value}))}/>}<button className="orders-text-button" disabled={busy} onClick={()=>createLinkedInvoice(entry)}>Create linked invoice draft</button></div>)}</div>})}</div>}</>}</div>}
    </section></div>
  </div>;
}
