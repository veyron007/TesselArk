import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './bundles.css';

const money = cents => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format((cents||0)/100);
const today = () => new Date().toISOString().slice(0,10);
const initialBundle = {name:'',reason:'',components:[{itemId:'',quantity:'1'}]};
const initialScheme = {name:'',itemIds:[],minQuantity:'1',discountBps:'0',freeItemId:'',freeQuantity:'0',stackingPolicy:'exclusive',effectiveFrom:today(),effectiveTo:today(),sourceReference:''};
const inputId = () => crypto.randomUUID();

export default function Bundles({context}) {
  const {companyId,gstinId,branchId,userId,bootstrap,apiFetch} = context;
  const company=bootstrap?.companies?.find(x=>String(x.id)===String(companyId));
  const branch=company?.branches?.find(x=>String(x.id)===String(branchId));
  const gstin=company?.gstins?.find(x=>String(x.id)===String(gstinId));
  const user=bootstrap?.users?.find(x=>String(x.id)===String(userId));
  const canAuthor=['staff','admin'].includes(user?.role);
  const canReview=['accountant','admin'].includes(user?.role);
  const replayKeys=useRef({});
  const referenceFor=(kind,payload)=>{const signature=JSON.stringify(payload); const prior=replayKeys.current[kind]; if(prior?.signature===signature) return prior.key; const key=inputId(); replayKeys.current={...replayKeys.current,[kind]:{signature,key}}; return key;};
  const clearReference=kind=>{const {[kind]:_discarded,...remaining}=replayKeys.current;replayKeys.current=remaining;};
  const [items,setItems]=useState([]),[parties,setParties]=useState([]);
  const [bundles,setBundles]=useState([]),[schemes,setSchemes]=useState([]);
  const [selectedBundle,setSelectedBundle]=useState(''),[previewQuantity,setPreviewQuantity]=useState('1'),[bundlePreview,setBundlePreview]=useState(null);
  const [bundleForm,setBundleForm]=useState(initialBundle),[schemeForm,setSchemeForm]=useState(initialScheme);
  const [reviewReasons,setReviewReasons]=useState({});
  const [dealsFilter,setDealsFilter]=useState({type:'sale',itemId:'',partyId:'',from:'2025-01-01',to:today()});
  const [deals,setDeals]=useState(null),[schemePreview,setSchemePreview]=useState(null);
  const [quote,setQuote]=useState({itemId:'',quantity:'2',unitRate:'',date:today()});
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const request=useCallback(async(path,options)=>{
    const response=await apiFetch(path,options);
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||`Bundle request failed (${response.status})`);
    return data;
  },[apiFetch]);
  const load=useCallback(async()=>{
    if(!branchId) return;
    setLoading(true); setError('');
    try {
      const [masters,formulaRows,schemeRows]=await Promise.all([
        request('/api/bundles/masters'),
        request(`/api/bundles?branchId=${encodeURIComponent(branchId)}`),
        request(`/api/bundles/schemes?branchId=${encodeURIComponent(branchId)}`),
      ]);
      setItems(masters.items); setParties(masters.parties); setBundles(formulaRows.bundles); setSchemes(schemeRows.schemes);
      setSelectedBundle(current=>formulaRows.bundles.some(x=>String(x.id)===String(current))?current:String(formulaRows.bundles[0]?.id||''));
    } catch(cause) { setError(cause.message); setBundles([]); setSchemes([]); }
    finally { setLoading(false); }
  },[branchId,request]);
  useEffect(()=>{setSelectedBundle('');setBundlePreview(null);setSchemePreview(null);setDeals(null);setBundleForm(initialBundle);setSchemeForm(initialScheme);load();},[companyId,gstinId,branchId,load]);
  const chosen=bundles.find(x=>String(x.id)===String(selectedBundle));
  const itemName=id=>items.find(x=>x.id===id)?.name||`Item #${id}`;
  const run=async(action,message)=>{
    setBusy(true);setError('');setNotice('');
    try { const result=await action();await load();setNotice(result?.replayed?'Existing request returned without a duplicate.':message);return result; }
    catch(cause) {setError(cause.message);return null;}
    finally {setBusy(false);}
  };
  const createBundle=async(event)=>{
    event.preventDefault();
    const body={branchId:Number(branchId),gstinId:Number(gstinId),name:bundleForm.name,reason:bundleForm.reason,components:bundleForm.components.map(x=>({itemId:Number(x.itemId),quantity:Number(x.quantity)})),clientReference:''};
    body.clientReference=referenceFor('bundle',body);
    const result=await run(()=>request('/api/bundles',{method:'POST',body:JSON.stringify(body)}),'Formula version 1 saved.');
    if(result) {clearReference('bundle');setSelectedBundle(String(result.bundle.id));setBundleForm(initialBundle);setBundlePreview(null);}
  };
  const reviseBundle=async(event)=>{
    event.preventDefault(); if(!chosen) return;
    const body={expectedVersion:chosen.currentVersion,reason:bundleForm.reason,components:bundleForm.components.map(x=>({itemId:Number(x.itemId),quantity:Number(x.quantity)})),clientReference:''};
    body.clientReference=referenceFor('version',body);
    const result=await run(()=>request(`/api/bundles/${chosen.id}/versions`,{method:'POST',body:JSON.stringify(body)}),'A new formula version was saved.');
    if(result) {clearReference('version');setBundleForm(initialBundle);setBundlePreview(null);}
  };
  const createScheme=async(event)=>{
    event.preventDefault();
    const body={...schemeForm,branchId:Number(branchId),gstinId:Number(gstinId),itemIds:schemeForm.itemIds.map(Number),minQuantity:Number(schemeForm.minQuantity),discountBps:Number(schemeForm.discountBps),freeItemId:schemeForm.freeItemId?Number(schemeForm.freeItemId):null,freeQuantity:Number(schemeForm.freeQuantity),clientReference:''};
    body.clientReference=referenceFor('scheme',body);
    const result=await run(()=>request('/api/bundles/schemes',{method:'POST',body:JSON.stringify(body)}),'Scheme sent for independent review.');
    if(result) {clearReference('scheme');setSchemeForm(initialScheme);}
  };
  const decide=async(scheme,decision)=>{
    await run(()=>request(`/api/bundles/schemes/${scheme.id}/decision`,{method:'POST',body:JSON.stringify({decision,reason:reviewReasons[scheme.id]||''})}),`Scheme ${decision}.`);
  };
  const showPreview=async()=>{
    if(!chosen) return;
    setBusy(true);setError('');
    try {setBundlePreview(await request(`/api/bundles/${chosen.id}/preview?quantity=${encodeURIComponent(previewQuantity)}`));}
    catch(cause){setError(cause.message);}finally{setBusy(false);}
  };
  const searchDeals=async(event)=>{
    event.preventDefault();setBusy(true);setError('');
    try {const q=new URLSearchParams({...dealsFilter,branchId:String(branchId)}); if(!dealsFilter.partyId) q.delete('partyId');setDeals(await request(`/api/bundles/deals?${q}`));}
    catch(cause){setError(cause.message);setDeals(null);}finally{setBusy(false);}
  };
  const previewSchemes=async(event)=>{
    event.preventDefault();setBusy(true);setError('');
    try {
      const decimal=quote.unitRate.trim();
      if(!/^\d+(?:\.\d{1,2})?$/.test(decimal)) throw new Error('Enter a rate in rupees with at most two decimals.');
      const [whole,fraction='']=decimal.split('.'); const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
      if(cents>1000000000n) throw new Error('Rate exceeds supported limit.');
      const q=new URLSearchParams({branchId:String(branchId),itemId:quote.itemId,quantity:quote.quantity,unitRateCents:String(cents),date:quote.date});
      setSchemePreview(await request(`/api/bundles/schemes/preview?${q}`));
    }catch(cause){setError(cause.message);setSchemePreview(null);}finally{setBusy(false);}
  };
  const setComponent=(index,key,value)=>setBundleForm(current=>({...current,components:current.components.map((row,i)=>i===index?{...row,[key]:value}:row)}));
  const changeScheme=(key,value)=>setSchemeForm(current=>({...current,[key]:value}));
  const selectedCount=useMemo(()=>schemeForm.itemIds.length,[schemeForm.itemIds]);
  return <section className="bundles-page">
    <header className="bundles-hero"><div><span className="bundles-kicker">TRADE / ERP-014</span><h1>Bundles & schemes</h1><p>Traceable pack formulas, reviewed offers, and original invoice deals in one local workspace.</p></div><div className="bundles-context"><span>Working scope</span><strong>{company?.name||'Company'} · {branch?.name||'Branch'}</strong><small>{gstin?.gstin||'GSTIN'} · {user?.name||'User'} ({user?.role||'role'})</small></div></header>
    <div className="bundles-notice"><strong>Commercial preview only</strong><span>Formula and scheme reviews do not reserve or post stock. Discounts and free goods need explicit source documents; GST is never inferred here.</span></div>
    {error&&<div className="bundles-error" role="alert">{error}</div>}{notice&&<div className="bundles-success" role="status">{notice}</div>}
    {loading?<p className="bundles-empty">Loading scoped trade records…</p>:<>
      <div className="bundles-grid"><section className="bundles-panel"><div className="bundles-head"><div><span className="bundles-kicker">01 / FORMULAS</span><h2>Bundle versions</h2></div><span>{bundles.length} formulas</span></div>
        <label>Selected formula<select value={selectedBundle} onChange={e=>{setSelectedBundle(e.target.value);setBundlePreview(null);}}><option value="">Choose a formula</option>{bundles.map(x=><option key={x.id} value={x.id}>{x.name} · v{x.currentVersion}</option>)}</select></label>
        {chosen?<div className="bundles-version"><div><strong>{chosen.name}</strong><span>Current version {chosen.currentVersion}</span></div><p>Saved component quantities are immutable by version. A revision creates a new snapshot.</p>{chosen.versions.map(v=><details key={v.id} open={v.version===chosen.currentVersion}><summary>Version {v.version} · {v.reason}</summary><ul>{v.components.map(c=><li key={c.itemId}><strong>{c.quantity} {c.unitSnapshot}</strong> {c.itemNameSnapshot} <small>({c.itemSkuSnapshot})</small></li>)}</ul><small>Created by user #{v.createdBy} · {v.createdAt}</small></details>)}</div>:<p className="bundles-empty">No formulas for this branch yet.</p>}
        {chosen&&<div className="bundles-preview"><div className="bundles-inline"><label>Bundles to prepare<input type="number" min="1" value={previewQuantity} onChange={e=>setPreviewQuantity(e.target.value)}/></label><button disabled={busy} onClick={showPreview}>Check component stock</button></div>{bundlePreview&&<div className="bundles-result"><strong>{bundlePreview.canFulfill?'All components available':'Component shortage'}</strong><table><thead><tr><th>Component</th><th>Required</th><th>Available</th><th>Short</th></tr></thead><tbody>{bundlePreview.lines.map(x=><tr key={x.itemId}><td>{x.itemNameSnapshot}</td><td>{x.requiredQuantity}</td><td>{x.availableQuantity}</td><td>{x.shortageQuantity}</td></tr>)}</tbody></table><small>Physical branch balance at preview time. No reservation or stock posting.</small></div>}</div>}
      </section>
      <section className="bundles-panel"><div className="bundles-head"><div><span className="bundles-kicker">02 / EDITOR</span><h2>Formula editor</h2></div><span>{canAuthor?'Staff workspace':'Read only'}</span></div>
        <form onSubmit={createBundle} className="bundles-form"><label>Bundle name<input value={bundleForm.name} onChange={e=>setBundleForm(x=>({...x,name:e.target.value}))} placeholder="e.g. Clinic starter pack" required disabled={!canAuthor}/></label>
          <div className="bundles-subhead"><strong>Components</strong><button type="button" className="bundles-quiet" disabled={!canAuthor} onClick={()=>setBundleForm(x=>({...x,components:[...x.components,{itemId:'',quantity:'1'}]}))}>Add component</button></div>
          {bundleForm.components.map((row,index)=><div className="bundles-component" key={index}><select aria-label={`Component ${index+1}`} value={row.itemId} onChange={e=>setComponent(index,'itemId',e.target.value)} disabled={!canAuthor} required><option value="">Select stock item</option>{items.filter(x=>x.trackStock&&x.active).map(x=><option key={x.id} value={x.id}>{x.sku} · {x.name} ({x.unit})</option>)}</select><input aria-label={`Quantity ${index+1}`} type="number" min="1" value={row.quantity} onChange={e=>setComponent(index,'quantity',e.target.value)} disabled={!canAuthor} required/><button type="button" className="bundles-quiet" disabled={!canAuthor||bundleForm.components.length===1} onClick={()=>setBundleForm(x=>({...x,components:x.components.filter((_,i)=>i!==index)}))}>Remove</button></div>)}
          <label>Reason or source note<textarea rows="2" value={bundleForm.reason} onChange={e=>setBundleForm(x=>({...x,reason:e.target.value}))} placeholder="Why this formula or revision exists" disabled={!canAuthor} required/></label><div className="bundles-actions"><button disabled={busy||!canAuthor}>Create formula</button>{chosen&&<button type="button" className="bundles-secondary" disabled={busy||!canAuthor} onClick={reviseBundle}>Save new version of selected</button>}</div>
        </form></section></div>
      <div className="bundles-grid"><section className="bundles-panel"><div className="bundles-head"><div><span className="bundles-kicker">03 / GROUP POLICY</span><h2>Scheme proposals</h2></div><span>{schemes.length} records</span></div>
        <form onSubmit={createScheme} className="bundles-form"><label>Scheme name<input value={schemeForm.name} onChange={e=>changeScheme('name',e.target.value)} disabled={!canAuthor} required/></label><label>Eligible item group <small>{selectedCount} selected</small><select multiple size="4" value={schemeForm.itemIds.map(String)} onChange={e=>changeScheme('itemIds',Array.from(e.target.selectedOptions,x=>Number(x.value)))} disabled={!canAuthor}>{items.filter(x=>x.active).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <div className="bundles-pair"><label>Minimum paid quantity<input type="number" min="1" value={schemeForm.minQuantity} onChange={e=>changeScheme('minQuantity',e.target.value)} disabled={!canAuthor}/></label><label>Discount basis points<input type="number" min="0" max="10000" value={schemeForm.discountBps} onChange={e=>changeScheme('discountBps',e.target.value)} disabled={!canAuthor}/></label></div>
          <div className="bundles-pair"><label>Free goods item<select value={schemeForm.freeItemId} onChange={e=>changeScheme('freeItemId',e.target.value)} disabled={!canAuthor}><option value="">None</option>{items.filter(x=>x.trackStock&&x.active).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Free quantity<input type="number" min="0" value={schemeForm.freeQuantity} onChange={e=>changeScheme('freeQuantity',e.target.value)} disabled={!canAuthor}/></label></div>
          <div className="bundles-pair"><label>Stacking policy<select value={schemeForm.stackingPolicy} onChange={e=>changeScheme('stackingPolicy',e.target.value)} disabled={!canAuthor}><option value="exclusive">Exclusive · use alone</option><option value="stackable">Stackable · explicit selection</option></select></label><label>Source reference<input value={schemeForm.sourceReference} onChange={e=>changeScheme('sourceReference',e.target.value)} disabled={!canAuthor} required/></label></div>
          <div className="bundles-pair"><label>Valid from<input type="date" value={schemeForm.effectiveFrom} onChange={e=>changeScheme('effectiveFrom',e.target.value)} disabled={!canAuthor}/></label><label>Valid to<input type="date" value={schemeForm.effectiveTo} onChange={e=>changeScheme('effectiveTo',e.target.value)} disabled={!canAuthor}/></label></div><button disabled={busy||!canAuthor}>Submit for independent review</button></form>
        <div className="bundles-scheme-list">{schemes.length?schemes.map(x=><article key={x.id} className="bundles-scheme"><div className="bundles-scheme-top"><strong>{x.name}</strong><span className={`bundles-status ${x.status}`}>{x.status}</span></div><p>{x.itemIds.map(itemName).join(', ')} · min {x.minQuantity} · {x.discountBps/100}% discount{x.freeItemId?` + ${x.freeQuantity} free ${itemName(x.freeItemId)}`:''}</p><small>{x.stackingPolicy} · {x.effectiveFrom} → {x.effectiveTo} · {x.sourceReference}</small>{x.status==='pending'&&canReview&&x.createdBy!==Number(userId)&&<div className="bundles-review"><input aria-label={`Review reason for ${x.name}`} placeholder="Review reason" value={reviewReasons[x.id]||''} onChange={e=>setReviewReasons(old=>({...old,[x.id]:e.target.value}))}/><button disabled={busy||!reviewReasons[x.id]?.trim()} onClick={()=>decide(x,'approved')}>Approve</button><button className="bundles-secondary" disabled={busy||!reviewReasons[x.id]?.trim()} onClick={()=>decide(x,'rejected')}>Reject</button></div>}{x.reviewReason&&<small>Review: {x.reviewReason} · user #{x.reviewedBy}</small>}</article>):<p className="bundles-empty">No scheme proposals in this branch.</p>}</div>
      </section>
      <section className="bundles-panel"><div className="bundles-head"><div><span className="bundles-kicker">04 / ADVISORY</span><h2>Offer preview</h2></div><span>No tax posting</span></div><form onSubmit={previewSchemes} className="bundles-form"><label>Item<select value={quote.itemId} onChange={e=>setQuote(x=>({...x,itemId:e.target.value}))} required><option value="">Select item</option>{items.filter(x=>x.active).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><div className="bundles-pair"><label>Paid quantity<input type="number" min="1" value={quote.quantity} onChange={e=>setQuote(x=>({...x,quantity:e.target.value}))}/></label><label>Unit rate (₹)<input inputMode="decimal" value={quote.unitRate} onChange={e=>setQuote(x=>({...x,unitRate:e.target.value}))} placeholder="100.00"/></label></div><label>Offer date<input type="date" value={quote.date} onChange={e=>setQuote(x=>({...x,date:e.target.value}))}/></label><button disabled={busy}>Preview reviewed schemes</button></form>
        {schemePreview&&<div className="bundles-result"><strong>Base line {money(schemePreview.baseCents)}</strong>{schemePreview.candidates.length?schemePreview.candidates.map(x=><article key={x.scheme.id}><div><strong>{x.scheme.name}</strong><span className="bundles-status approved">{x.scheme.stackingPolicy}</span></div><p>Illustrative discount {money(x.discountCents)}{x.freeGoods?` · ${x.freeGoods.quantity} free ${itemName(x.freeGoods.itemId)} (available ${x.freeGoods.available})`:''}</p></article>):<p className="bundles-empty">No approved scheme qualifies for this item, quantity and date.</p>}<small>Choose scheme terms explicitly in a future source document. Exclusive schemes cannot combine. No rate, tax, or stock document was created.</small></div>}
      </section></div>
      <section className="bundles-panel"><div className="bundles-head"><div><span className="bundles-kicker">05 / SOURCE HISTORY</span><h2>Previous sale & purchase deals</h2></div><span>Approved invoices only</span></div><form className="bundles-deal-form" onSubmit={searchDeals}><label>Document type<select value={dealsFilter.type} onChange={e=>setDealsFilter(x=>({...x,type:e.target.value,partyId:''}))}><option value="sale">Sales</option><option value="purchase">Purchases</option></select></label><label>Item<select value={dealsFilter.itemId} onChange={e=>setDealsFilter(x=>({...x,itemId:e.target.value}))} required><option value="">Select item</option>{items.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Party<select value={dealsFilter.partyId} onChange={e=>setDealsFilter(x=>({...x,partyId:e.target.value}))}><option value="">All accessible parties</option>{parties.filter(x=>dealsFilter.type==='sale'?['customer','both'].includes(x.type):['supplier','both'].includes(x.type)).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>From<input type="date" value={dealsFilter.from} onChange={e=>setDealsFilter(x=>({...x,from:e.target.value}))}/></label><label>To<input type="date" value={dealsFilter.to} onChange={e=>setDealsFilter(x=>({...x,to:e.target.value}))}/></label><button disabled={busy}>Search original lines</button></form>
        {deals&&<div className="bundles-table-wrap">{deals.deals.length?<table><thead><tr><th>Date / source</th><th>Party</th><th>Qty</th><th>Original rate</th><th>Original GST</th><th>Original subtotal</th><th>Original tax</th></tr></thead><tbody>{deals.deals.map(x=><tr key={x.invoiceLineId}><td><strong>{x.invoiceDate}</strong><small>{x.invoiceNumber}{x.supplierInvoiceNumber?` · supplier ${x.supplierInvoiceNumber}`:''} · line #{x.invoiceLineId}</small></td><td>{x.partyNameSnapshot}</td><td>{x.quantity}</td><td>{money(x.unitPriceCents)}</td><td>{(x.gstRateBps/100).toFixed(2)}%</td><td>{money(x.subtotalCents)}</td><td>{money(x.taxCents)}</td></tr>)}</tbody></table>:<p className="bundles-empty">No approved source lines match this date and scope.</p>}<small>Historical invoice line values are shown as recorded. They do not become current pricing or tax terms.</small></div>}
      </section>
    </>}
  </section>;
}
