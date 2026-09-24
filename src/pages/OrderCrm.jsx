import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './order-crm.css';

const today = () => new Date().toISOString().slice(0,10);
const reference = () => `CRM-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
const emptyForm = () => ({partyId:'',orderId:'',subject:'',customerRequest:'',ownerId:'',nextAction:'',dueDate:today()});
const emptyAction = () => ({kind:'request',detail:'',relatedEventId:'',disposition:'fulfilled',nextAction:'',dueDate:today(),ownerId:'',fulfillmentId:'',blockerId:''});
const retryReference = (holder,payload) => {
  const signature = JSON.stringify(payload);
  if (holder.current?.signature !== signature) holder.current = {signature,clientReference:reference()};
  return holder.current.clientReference;
};

export default function OrderCrm({ context = {}, onNavigate }) {
  const { companyId,gstinId,branchId,userId,bootstrap,apiFetch } = context;
  const company = bootstrap?.companies?.find(row => String(row.id) === String(companyId));
  const gstin = company?.gstins?.find(row => String(row.id) === String(gstinId));
  const branch = company?.branches?.find(row => String(row.id) === String(branchId));
  const user = bootstrap?.users?.find(row => String(row.id) === String(userId));
  const [overview,setOverview] = useState(null);
  const [selectedId,setSelectedId] = useState(null);
  const [selected,setSelected] = useState(null);
  const [form,setForm] = useState(emptyForm);
  const [action,setAction] = useState(emptyAction);
  const [loading,setLoading] = useState(false);
  const [detailLoading,setDetailLoading] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const caseRetry = useRef(null);
  const actionRetry = useRef(null);
  const canCreate = user?.role === 'staff' || user?.role === 'admin';
  const canEdit = canCreate && selected && (user?.role === 'admin' || Number(selected.ownerId) === Number(userId));
  const request = useCallback(async (path,options) => {
    const response = await apiFetch(path,options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Follow-up request failed (${response.status})`);
    return data;
  },[apiFetch]);
  const scoped = useMemo(() => `gstinId=${encodeURIComponent(gstinId)}&branchId=${encodeURIComponent(branchId)}`,[gstinId,branchId]);
  const load = useCallback(async () => {
    if (!gstinId || !branchId) return;
    setLoading(true); setError('');
    try { setOverview(await request(`/api/order-crm?${scoped}`)); }
    catch (cause) { setError(cause.message); setOverview(null); }
    finally { setLoading(false); }
  },[request,scoped,gstinId,branchId]);
  const loadDetail = useCallback(async id => {
    if (!id) { setSelected(null); return; }
    setDetailLoading(true); setError('');
    try { const data = await request(`/api/order-crm/${id}`); setSelected(data.case); }
    catch (cause) { setError(cause.message); setSelected(null); }
    finally { setDetailLoading(false); }
  },[request]);
  useEffect(() => { setSelectedId(null); setSelected(null); setForm(emptyForm()); setAction(emptyAction()); caseRetry.current=null; actionRetry.current=null; load(); },[load,companyId]);
  useEffect(() => { setAction(emptyAction()); actionRetry.current=null; loadDetail(selectedId); },[loadDetail,selectedId]);
  useEffect(() => { if (selected?.status === 'closed') setAction(current => current.kind === 'reopen' ? current : {...emptyAction(),kind:'reopen'}); else if (selected?.status === 'open') setAction(current => current.kind === 'reopen' ? emptyAction() : current); },[selected?.status]);
  const matchedOrders = (overview?.orders || []).filter(order => String(order.partyId) === String(form.partyId));
  const submitCase = async event => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const body = {...form,gstinId:Number(gstinId),branchId:Number(branchId),partyId:Number(form.partyId),
        orderId:form.orderId ? Number(form.orderId) : null,ownerId:Number(form.ownerId || userId)};
      body.clientReference=retryReference(caseRetry,body);
      const data = await request('/api/order-crm',{method:'POST',body:JSON.stringify(body)});
      caseRetry.current=null; setSelectedId(data.case.id); setSelected(data.case); setForm(emptyForm()); setNotice('Follow-up created with the customer request in its history.');
      await load();
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const submitAction = async event => {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const body = {kind:action.kind,detail:action.detail.trim()};
      if (action.kind === 'disposition') { body.relatedEventId=Number(action.relatedEventId); body.disposition=action.disposition; }
      if (action.kind === 'follow_up') { body.nextAction=action.nextAction; body.dueDate=action.dueDate; body.ownerId=Number(action.ownerId || selected.ownerId); }
      if (action.kind === 'blocker_open') body.fulfillmentId=action.fulfillmentId ? Number(action.fulfillmentId) : null;
      if (action.kind === 'blocker_resolve') body.blockerId=Number(action.blockerId);
      body.clientReference=retryReference(actionRetry,{caseId:selected.id,...body});
      const result = await request(`/api/order-crm/${selected.id}/actions`,{method:'POST',body:JSON.stringify(body)});
      actionRetry.current=null; setSelected(result.case); setAction(emptyAction()); setNotice('Follow-up history updated.'); await load();
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const setField = (name,value) => setForm(current => ({...current,[name]:value}));
  const setActionField = (name,value) => setAction(current => ({...current,[name]:value}));
  const openBlockers = selected?.blockers?.filter(blocker => blocker.status === 'open') || [];
  const actionChoices = selected?.status === 'closed' ? [['reopen','Reopen case']] : [
    ['request','Customer request'],['commitment','Commitment'],['disposition','Commitment disposition'],['follow_up','Next action / owner'],
    ...(selected?.orderId ? [['blocker_open','Fulfillment blocker']] : []),
    ...(openBlockers.length ? [['blocker_resolve','Resolve blocker']] : []),['close','Close case']
  ];

  return <div className="order-crm-page">
    <header className="order-crm-hero"><div><span className="order-crm-eyebrow">CUSTOMER OPERATIONS · ERP-029</span><h1>Order follow-up</h1><p>Keep each request, promise and outcome with the right customer and source order.</p></div><div className="order-crm-scope"><strong>{company?.name || 'Company'}</strong><span>{gstin?.gstin || 'GSTIN'} · {branch?.name || 'Branch'}</span><span>{user?.name || 'User'} · {user?.role || 'role'}</span></div></header>
    <div className="order-crm-boundary">Follow-up notes and blockers are operational records. Dispatch, invoice, stock, tax and accounting states remain with their source workflows.</div>
    {error && <div className="order-crm-alert error" role="alert">{error}</div>}{notice && <div className="order-crm-alert success" role="status">{notice}</div>}
    <div className="order-crm-grid"><section className="order-crm-card"><div className="order-crm-card-head"><div><span className="order-crm-eyebrow">QUEUE</span><h2>Customer cases</h2></div><span>{overview?.cases?.length || 0}</span></div>
      {loading ? <p className="order-crm-empty">Loading cases…</p> : !overview?.cases?.length ? <p className="order-crm-empty">No follow-ups in this branch yet.</p> : <div className="order-crm-list">{overview.cases.map(item => <button key={item.id} className={`order-crm-case ${selectedId === item.id ? 'active' : ''}`} onClick={() => setSelectedId(item.id)} type="button"><span className="order-crm-case-top"><strong>{item.subject}</strong><span className={`order-crm-status ${item.status}`}>{item.status}</span></span><span>{item.partyName}{item.orderNumber ? ` · ${item.orderNumber}` : ' · enquiry'}</span><small>{item.ownerName} · due {item.dueDate}{item.openBlockerCount ? ` · ${item.openBlockerCount} blocker${item.openBlockerCount === 1 ? '' : 's'}` : ''}</small></button>)}</div>}
      {canCreate && <form className="order-crm-create" onSubmit={submitCase}><h3>New customer follow-up</h3><div className="order-crm-fields"><label>Customer<select required value={form.partyId} onChange={event => setForm(current => ({...current,partyId:event.target.value,orderId:''}))}><option value="">Choose customer</option>{overview?.customers?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Sales order <small>optional</small><select value={form.orderId} onChange={event => setField('orderId',event.target.value)}><option value="">Enquiry without order</option>{matchedOrders.map(item => <option key={item.id} value={item.id}>{item.number} · {item.status}</option>)}</select></label><label>Subject<input required maxLength="160" value={form.subject} onChange={event => setField('subject',event.target.value)}/></label><label>Owner<select value={form.ownerId || String(userId)} onChange={event => setField('ownerId',event.target.value)} disabled={user?.role !== 'admin'}>{overview?.users?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="wide">Customer request<textarea required maxLength="1000" rows="2" value={form.customerRequest} onChange={event => setField('customerRequest',event.target.value)}/></label><label className="wide">Next action<input required maxLength="300" value={form.nextAction} onChange={event => setField('nextAction',event.target.value)}/></label><label>Due date<input required type="date" value={form.dueDate} onChange={event => setField('dueDate',event.target.value)}/></label></div><button className="order-crm-primary" disabled={busy || loading}>Create follow-up</button></form>}
    </section><section className="order-crm-card order-crm-detail"><div className="order-crm-card-head"><div><span className="order-crm-eyebrow">CASE FILE</span><h2>{selected?.subject || 'Select a follow-up'}</h2></div>{selected && <span className={`order-crm-status ${selected.status}`}>{selected.status}</span>}</div>
      {detailLoading ? <p className="order-crm-empty">Loading case…</p> : !selected ? <p className="order-crm-empty">Choose a case to review requests, promises and fulfillment blockers.</p> : <div className="order-crm-detail-body"><div className="order-crm-meta"><span><b>Customer</b>{selected.partyName}</span><span><b>Owner</b>{selected.ownerName}</span><span><b>Due</b>{selected.dueDate}</span><span><b>Scope</b>{branch?.name}</span></div>
        <div className="order-crm-source"><div><span className="order-crm-eyebrow">SOURCE ORDER</span>{selected.order ? <><strong>{selected.order.number}</strong><small>{selected.order.status} · {selected.order.orderDate}</small></> : <strong>Enquiry · no sales order linked</strong>}</div>{selected.order && <button type="button" className="order-crm-link" onClick={() => onNavigate?.('orders',selected.order.id)}>Open source order ↗</button>}</div>
        <div className="order-crm-next"><span className="order-crm-eyebrow">NEXT ACTION</span><strong>{selected.nextAction}</strong><small>Owned by {selected.ownerName} · due {selected.dueDate}</small></div>
        <section><div className="order-crm-section-head"><h3>Commitments and dispositions</h3><span>{selected.commitments.length}</span></div>{!selected.commitments.length ? <p className="order-crm-muted">No commitment recorded yet.</p> : <div className="order-crm-commitments">{selected.commitments.map(item => <div key={item.id}><span className="order-crm-event-dot"/><div><strong>{item.detail}</strong><small>{item.actorName} · {item.createdAt}</small>{item.latestDisposition ? <p><b>{item.latestDisposition.disposition}</b> · {item.latestDisposition.detail}</p> : <p>Awaiting disposition</p>}</div></div>)}</div>}</section>
        {selected.order && <section><div className="order-crm-section-head"><h3>Fulfillment view and blockers</h3><span>{selected.fulfillments.length} physical events</span></div>{selected.fulfillments.map(item => <div className="order-crm-fulfillment" key={item.id}><strong>{item.number}</strong><span>{item.kind} · {item.status} · {item.quantity} units · {item.eventDate}</span></div>)}{selected.blockers.map(item => <div className="order-crm-blocker" key={item.id}><span className={`order-crm-status ${item.status}`}>{item.status}</span><div><strong>{item.description}</strong><small>{item.fulfillmentNumber ? `Linked to ${item.fulfillmentNumber}` : 'Order level blocker'}{item.resolution ? ` · Resolution: ${item.resolution}` : ''}</small></div></div>)}{!selected.blockers.length && <p className="order-crm-muted">No fulfillment blockers recorded.</p>}</section>}
        <section><div className="order-crm-section-head"><h3>Full activity history</h3><span>{selected.events.length} entries</span></div><div className="order-crm-timeline">{selected.events.map(item => <div key={item.id}><span>{item.kind.replace('_',' ')}</span><p>{item.detail}</p><small>{item.actorName} · {item.createdAt}</small></div>)}</div></section>
        {canEdit && <form className="order-crm-action" onSubmit={submitAction}><h3>Record an action</h3><div className="order-crm-fields"><label>Action<select value={actionChoices.some(([kind]) => kind === action.kind) ? action.kind : actionChoices[0]?.[0]} onChange={event => setAction(current => ({...emptyAction(),kind:event.target.value}))}>{actionChoices.map(([kind,label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>{action.kind === 'disposition' && <><label>Commitment<select required value={action.relatedEventId} onChange={event => setActionField('relatedEventId',event.target.value)}><option value="">Choose promise</option>{selected.commitments.map(item => <option key={item.id} value={item.id}>#{item.id} · {item.detail.slice(0,65)}</option>)}</select></label><label>Disposition<select value={action.disposition} onChange={event => setActionField('disposition',event.target.value)}><option value="fulfilled">Fulfilled</option><option value="partial">Partially fulfilled</option><option value="unmet">Unmet</option><option value="withdrawn">Withdrawn</option></select></label></>}{action.kind === 'follow_up' && <><label className="wide">Next action<input required maxLength="300" value={action.nextAction} onChange={event => setActionField('nextAction',event.target.value)}/></label><label>Due date<input required type="date" value={action.dueDate} onChange={event => setActionField('dueDate',event.target.value)}/></label><label>Owner<select value={action.ownerId || String(selected.ownerId)} onChange={event => setActionField('ownerId',event.target.value)} disabled={user?.role !== 'admin'}>{overview?.users?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}{action.kind === 'blocker_open' && <label>Physical event <small>optional</small><select value={action.fulfillmentId} onChange={event => setActionField('fulfillmentId',event.target.value)}><option value="">Order level</option>{selected.fulfillments.map(item => <option key={item.id} value={item.id}>{item.number}</option>)}</select></label>}{action.kind === 'blocker_resolve' && <label>Open blocker<select required value={action.blockerId} onChange={event => setActionField('blockerId',event.target.value)}><option value="">Choose blocker</option>{openBlockers.map(item => <option key={item.id} value={item.id}>#{item.id} · {item.description.slice(0,65)}</option>)}</select></label>}<label className="wide">{action.kind === 'close' ? 'Closure reason' : action.kind === 'reopen' ? 'Reopening reason' : 'Details'}<textarea required maxLength="1000" rows="2" value={action.detail} onChange={event => setActionField('detail',event.target.value)}/></label></div><button className="order-crm-primary" disabled={busy}>Save action</button></form>}
      </div>}
    </section></div>
  </div>;
}
