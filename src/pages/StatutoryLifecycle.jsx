import { useCallback, useEffect, useMemo, useState } from 'react';
import './statutory-lifecycle.css';

const flows = [
  { kind:'irn', name:'E-invoice / IRN', source:'invoice', actions:['generate','get','cancel'] },
  { kind:'eway', name:'E-way bill', source:'invoice', actions:['generate','get','update_part_b','cancel'] },
  { kind:'gst_return', name:'GST return', source:'period', actions:['save','review','sign','file','status'] },
];
const label = value => String(value ?? '—').replaceAll('_',' ').replace(/\b\w/g, letter => letter.toUpperCase());
const date = value => value ? new Date(`${value.replace(' ','T')}Z`).toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';

export default function StatutoryLifecycle({context={},refresh=0}) {
  const {companyId,gstinId,userId,role,apiFetch} = context;
  const [kind,setKind] = useState('irn');
  const [sourceId,setSourceId] = useState('');
  const [scenario,setScenario] = useState('success');
  const [vehicleNumber,setVehicleNumber] = useState('MH12AB1234');
  const [reason,setReason] = useState('Demo cancellation requested');
  const [token,setToken] = useState(null);
  const [invoices,setInvoices] = useState([]);
  const [periods,setPeriods] = useState([]);
  const [documents,setDocuments] = useState([]);
  const [events,setEvents] = useState([]);
  const [busy,setBusy] = useState('');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const flow = flows.find(item => item.kind === kind) || flows[0];

  const request = useCallback(async (path, init={}) => {
    const response=await (apiFetch ? apiFetch(path,init) : fetch(path,{...init,headers:{'x-company-id':companyId,'x-user-id':userId,...init.headers}}));
    const payload=await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || `Request failed (${response.status})`);
    return payload;
  },[apiFetch,companyId,userId]);

  const reload = useCallback(async () => {
    const params=new URLSearchParams({gstinId:String(gstinId)});
    const [invoiceData,periodData,documentData,eventData]=await Promise.all([
      request(`/api/invoices?${params}`),request(`/api/gst/periods?${params}`),
      request(`/api/statutory/documents?${params}`),request(`/api/statutory/events?${params}`),
    ]);
    return {invoices:(invoiceData.invoices || []).filter(row => row.type === 'sale' && row.status === 'approved'),
      periods:(periodData.periods || []).filter(row => row.status === 'approved'),
      documents:documentData.documents || [],events:eventData.events || []};
  },[request,gstinId]);

  useEffect(() => {
    if (!companyId || !gstinId) return undefined;
    let active=true;
    setToken(null); setDocuments([]); setEvents([]); setError(''); setNotice('');
    reload().then(data => { if (!active) return; setInvoices(data.invoices); setPeriods(data.periods); setDocuments(data.documents); setEvents(data.events); })
      .catch(cause => { if (active) setError(cause.message); });
    return () => { active=false; };
  },[companyId,gstinId,userId,refresh,reload]);

  const sources=flow.source === 'invoice' ? invoices : periods;
  const selectedSource=useMemo(() => sources.find(row => String(row.id) === String(sourceId)) || sources[0] || null,[sources,sourceId]);
  const selectedDocument=documents.find(row => row.kind === kind && row.sourceId === selectedSource?.id);
  const selectedEvents=events.filter(row => row.kind === kind && row.sourceId === selectedSource?.id);
  const tokenCurrent=token?.service === kind && Number(token?.gstin_id) === Number(gstinId) && new Date(`${token.expires_at.replace(' ','T')}Z`).getTime() > Date.now();
  const reviewer=['accountant','admin'].includes(role);
  const canAction=action => {
    const state=selectedDocument?.status || null;
    const states={generate:[null],get:['generated','cancelled'],cancel:['generated'],update_part_b:['generated'],
      save:[null],review:['saved'],sign:['reviewed'],file:['signed'],status:['saved','reviewed','signed','filed']};
    if (!states[action]?.includes(state)) return false;
    if (kind === 'gst_return' && !reviewer) return false;
    if (action === 'cancel' && !reviewer) return false;
    if (action === 'review' && selectedDocument?.savedBy === Number(userId)) return false;
    if (action === 'sign' && selectedDocument?.reviewedBy === Number(userId)) return false;
    return Boolean(selectedSource && tokenCurrent && !busy);
  };

  async function authenticate() {
    setBusy('auth'); setError(''); setNotice('');
    try {
      const result=await request('/api/statutory/auth',{method:'POST',body:JSON.stringify({gstinId:Number(gstinId),service:kind,scenario,idempotencyKey:crypto.randomUUID()})});
      setToken(result.token || null);
      setNotice(result.event.response.message);
      const data=await reload(); setEvents(data.events);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(''); }
  }

  async function run(action) {
    if (!canAction(action)) return;
    setBusy(action); setError(''); setNotice('');
    try {
      const result=await request(`/api/statutory/${kind}/${action}`,{method:'POST',body:JSON.stringify({
        gstinId:Number(gstinId),sourceId:selectedSource.id,tokenId:token.id,scenario,idempotencyKey:crypto.randomUUID(),
        ...(action === 'update_part_b' || action === 'generate' && kind === 'eway' ? {vehicleNumber} : {}),
        ...(action === 'cancel' ? {reason} : {}),
      })});
      setNotice(result.event.response.message);
      const data=await reload(); setDocuments(data.documents); setEvents(data.events);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(''); }
  }

  return <div className="stat-life-page">
    <header className="stat-life-hero"><span className="stat-life-kicker">SIMULATED SERVICE ADAPTER</span><h1>Statutory lifecycle lab</h1><p>Practice authentication, document state changes, failed calls, retries and acknowledgement tracking. Every token and reference is synthetic. This workspace sends nothing to NIC, GSTN or any government portal.</p><span className="stat-life-chip">NO OFFICIAL FILING OR SIGNATURE</span></header>
    {error && <div className="stat-life-alert error" role="alert">{error}</div>}
    {notice && <div className="stat-life-alert success" role="status">{notice}</div>}
    <div className="stat-life-grid">
      <section className="stat-life-card"><span className="stat-life-step">01 / SOURCE</span><h2>Choose the workflow</h2>
        <div className="stat-life-tabs" role="group" aria-label="Statutory workflow">{flows.map(item => <button key={item.kind} type="button" className={kind === item.kind ? 'active' : ''} aria-pressed={kind === item.kind} onClick={() => {setKind(item.kind);setToken(null);setSourceId('');setNotice('');}}>{item.name}</button>)}</div>
        <label>Approved {flow.source === 'invoice' ? 'sales invoice' : 'GST period'}<select value={selectedSource?.id || ''} onChange={event => setSourceId(event.target.value)}><option value="">Choose source</option>{sources.map(row => <option key={row.id} value={row.id}>{flow.source === 'invoice' ? `${row.number} · ${row.partyName || 'Customer'}` : `${row.period} · ${row.gstin || 'GSTIN'}`}</option>)}</select></label>
        <div className="stat-life-source"><span>Current simulated state</span><strong>{selectedDocument ? label(selectedDocument.status) : 'Not started'}</strong><small>{selectedDocument?.reference || 'No simulated reference yet'}</small>{selectedDocument?.acknowledgement && <small>{selectedDocument.acknowledgement}</small>}</div>
      </section>
      <section className="stat-life-card"><span className="stat-life-step">02 / SESSION</span><h2>Authenticate locally</h2><p>The lab issues a 15-minute simulated token scoped to this company, GSTIN and service.</p>
        <label>Response scenario<select value={scenario} onChange={event => setScenario(event.target.value)}><option value="success">Success</option><option value="rejection">Service rejection</option><option value="timeout">Service timeout</option></select></label>
        <button className="stat-life-primary" type="button" onClick={authenticate} disabled={!reviewer || Boolean(busy)}>{busy === 'auth' ? 'Authenticating…' : 'Issue simulated token'}</button>
        <div className="stat-life-source"><span>Session</span><strong>{tokenCurrent ? 'Ready' : 'Authentication required'}</strong><small>{tokenCurrent ? `${token.token_reference} · expires ${date(token.expires_at)}` : 'Use a demo accountant or admin user. No credentials are sent.'}</small></div>
      </section>
      <section className="stat-life-card stat-life-actions"><span className="stat-life-step">03 / ACTION</span><h2>Run a lifecycle action</h2><p>A timeout or rejection creates an audit event without advancing the document. Select success and retry with a new request key.</p>
        {kind === 'eway' && <label>Vehicle number / Part B<input value={vehicleNumber} maxLength={20} onChange={event => setVehicleNumber(event.target.value.toUpperCase())} /></label>}
        {kind !== 'gst_return' && <label>Cancellation reason<input value={reason} maxLength={200} onChange={event => setReason(event.target.value)} /></label>}
        <div className="stat-life-action-grid">{flow.actions.map(action => <button type="button" key={action} disabled={!canAction(action)} onClick={() => run(action)}>{busy === action ? 'Running…' : label(action)}<span aria-hidden="true">→</span></button>)}</div>
        {kind === 'gst_return' && <p className="stat-life-note">A different demo user must review after save, then a different user must simulate signing. The filed state and ARN remain local simulation records.</p>}
      </section>
    </div>
    <section className="stat-life-card stat-life-history"><div><span className="stat-life-step">04 / AUDIT</span><h2>Immutable request history</h2><p>Snapshots show the request, selected source and simulated response for the current record.</p></div>
      {selectedEvents.length === 0 ? <p className="stat-life-empty">No requests for this source yet.</p> : <div className="stat-life-events">{selectedEvents.map(item => <details key={item.id}><summary><span className={`stat-life-outcome ${item.outcome}`}>{label(item.outcome)}</span><strong>{label(item.action)}</strong><span>{date(item.createdAt)} · user #{item.actorId}</span></summary><pre>{JSON.stringify({request:item.request,sourceSnapshot:item.sourceSnapshot,response:item.response},null,2)}</pre></details>)}</div>}
    </section>
  </div>;
}
