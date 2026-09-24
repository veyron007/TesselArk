import { useEffect, useMemo, useState } from 'react';
import './returns.css';

const money = cents => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:2}).format((Number(cents)||0)/100);
const date = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) : '—';

export default function Returns({ context, refresh }) {
  const { companyId,branchId,gstinId,role,apiFetch } = context;
  const [invoices,setInvoices] = useState([]);
  const [returns,setReturns] = useState([]);
  const [invoiceId,setInvoiceId] = useState('');
  const [source,setSource] = useState(null);
  const [quantities,setQuantities] = useState({});
  const [reason,setReason] = useState('');
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [success,setSuccess] = useState('');
  const [revision,setRevision] = useState(0);

  const request = async (path,init) => {
    const response = await apiFetch(path,init);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  };
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({branchId:String(branchId),gstinId:String(gstinId)});
    setLoading(true); setError(''); setSuccess(''); setInvoices([]); setReturns([]); setInvoiceId(''); setSource(null); setQuantities({});
    Promise.all([request(`/api/invoices?${params}`),request(`/api/returns?${params}`)])
      .then(([invoiceData,returnData]) => { if (active) { setInvoices((invoiceData.invoices||[]).filter(item=>item.status==='approved')); setReturns(returnData.returns||[]); } })
      .catch(issue => { if (active) setError(issue.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  },[companyId,branchId,gstinId,apiFetch,refresh,revision]);

  useEffect(() => {
    if (!invoiceId) { setSource(null); return undefined; }
    let active = true;
    setSource(null);
    request(`/api/invoices/${invoiceId}`).then(data => { if (active) { setSource(data.invoice); setQuantities({}); } })
      .catch(issue => { if (active) setError(issue.message); });
    return () => { active = false; };
  },[invoiceId,apiFetch]);

  const prior = useMemo(() => {
    const totals = {};
    for (const record of returns) if (record.status === 'approved') for (const line of record.lines) totals[line.invoiceLineId] = (totals[line.invoiceLineId]||0)+line.quantity;
    return totals;
  },[returns]);
  const proposal = useMemo(() => (source?.lines||[]).reduce((sum,line) => {
    const quantity = Number(quantities[line.id]||0);
    if (!Number.isSafeInteger(quantity) || quantity<=0) return sum;
    return sum+Math.round(line.totalCents*quantity/line.quantity);
  },0),[source,quantities]);
  const canApprove = role === 'accountant' || role === 'admin';

  async function create(event) {
    event.preventDefault(); setError(''); setSuccess('');
    const lines = Object.entries(quantities).filter(([,quantity])=>Number(quantity)>0).map(([invoiceLineId,quantity])=>({invoiceLineId:Number(invoiceLineId),quantity:Number(quantity)}));
    if (!lines.length) { setError('Enter a return quantity for at least one line.'); return; }
    setBusy(true);
    try {
      const result = await request('/api/returns',{method:'POST',body:JSON.stringify({invoiceId:Number(invoiceId),lines,reason})});
      setSuccess(`${result.return.number} drafted. Stock has not moved. Tax is an unreviewed proposal.`);
      setReason(''); setInvoiceId(''); setRevision(value=>value+1); refresh?.();
    } catch (issue) { setError(issue.message); }
    finally { setBusy(false); }
  }
  async function approve(id) {
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await request(`/api/returns/${id}/approve`,{method:'POST',body:'{}'});
      setSuccess(`${result.return.number} approved. Sales goods await inspection before saleable release; purchase returns issue stock where applicable. Tax adjustment remains an unreviewed proposal.`);
      setRevision(value=>value+1); refresh?.();
    } catch (issue) { setError(issue.message); }
    finally { setBusy(false); }
  }

  return <div className="returns-page">
    <div className="returns-heading"><div><p className="returns-eyebrow">SOURCE LINKED DOCUMENTS</p><h1>Returns & notes</h1><p>Record received or sold quantities against an approved invoice, with a separate inspection step for returned sales goods.</p></div><span className="returns-count">{returns.length} records</span></div>
    <div className="returns-caution"><strong>Tax treatment needs review.</strong> Values below are local proportional adjustment proposals. They do not change the source invoice, GST period, filing, or eligible ITC.</div>
    {error && <div className="returns-alert error" role="alert">{error}</div>}
    {success && <div className="returns-alert success" role="status">{success}</div>}
    <div className="returns-layout">
      <section className="returns-panel"><div className="returns-panel-title"><div><h2>New return</h2><p>Choose the original approved document.</p></div></div>
        <form onSubmit={create}>
          <label className="returns-field"><span>Source invoice</span><select value={invoiceId} onChange={event=>setInvoiceId(event.target.value)} required><option value="">Select an approved invoice</option>{invoices.map(invoice=><option key={invoice.id} value={invoice.id}>{invoice.number} · {invoice.type==='sale'?'Sales credit note':'Purchase debit note'} · {invoice.partyName}</option>)}</select></label>
          {source && <><div className="returns-source"><strong>{source.number}</strong><span>{source.partyName} · {date(source.invoiceDate)} · {source.gstin}</span></div>
            <div className="returns-lines"><div className="returns-lines-head"><span>Item / source line</span><span>Remaining</span><span>Return qty</span></div>{source.lines.map(line=>{
              const remaining = line.quantity-(prior[line.id]||0);
              return <label className="returns-line" key={line.id}><span><strong>{line.itemName}</strong><small>{line.sku} · {money(line.unitPriceCents)} each</small></span><span>{remaining} / {line.quantity}</span><input aria-label={`Return quantity for ${line.itemName}`} type="number" min="0" max={remaining} step="1" value={quantities[line.id]??''} disabled={remaining===0} onChange={event=>setQuantities(current=>({...current,[line.id]:event.target.value}))} placeholder="0" /></label>;
            })}</div></>}
          <label className="returns-field"><span>Reason for return</span><textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength="500" rows="3" required placeholder="Describe the item condition and why it is being returned" /></label>
          <div className="returns-create-footer"><div><span>Indicative note value</span><strong>{money(proposal)}</strong></div><button className="returns-primary" type="submit" disabled={busy||!source}>{busy?'Working…':'Create draft note'}</button></div>
        </form>
      </section>
      <section className="returns-panel"><div className="returns-panel-title"><div><h2>Return register</h2><p>Notes stay linked to the source invoice.</p></div></div>
        {loading ? <div className="returns-empty">Loading returns…</div> : !returns.length ? <div className="returns-empty"><span>↩</span><strong>No returns recorded</strong><p>Select an approved invoice to create the first note.</p></div> : <div className="returns-list">{returns.map(record=><article className="returns-record" key={record.id}>
          <div className="returns-record-top"><div><strong>{record.number}</strong><span>{record.kind==='sales_return'?'Sales credit note proposal':'Purchase debit note proposal'}</span></div><span className={`returns-status ${record.status}`}>{record.status}</span></div>
          <div className="returns-record-meta"><span>Source <strong>{record.invoiceNumber}</strong></span><span>{record.partyName}</span><span>{date(record.invoiceDate)}</span></div>
          <p className="returns-record-reason">{record.reason}</p>
          <div className="returns-record-lines">{record.lines.map(line=><div key={line.id}><span>{line.itemName} × {line.quantity}</span><strong>{money(line.subtotalCents+line.taxProposalCents)}</strong></div>)}</div>
          <div className="returns-record-total"><span>Tax adjustment proposal <strong>{money(record.taxProposalCents)}</strong></span><span>Total proposal <strong>{money(record.totalProposalCents)}</strong></span></div>
          <div className="returns-record-footer"><span>{record.status==='approved'?(record.kind==='sales_return'?(record.lines.some(line=>line.stockMovementId)?'Legacy return stock posted directly · inspection not recorded':'Returned goods held for inspection · tax unreviewed'):'Purchase stock issued where applicable · tax unreviewed'):'Draft · stock unchanged'}{record.sourcePeriodStatus!=='open' && ` · Source GST period ${record.sourcePeriodStatus}; separate tax review needed`}</span>{record.status==='draft' && canApprove && String(record.createdBy)!==String(context.userId) && <button type="button" onClick={()=>approve(record.id)} disabled={busy}>Approve return</button>}{record.status==='draft' && (!canApprove || String(record.createdBy)===String(context.userId)) && <small>{canApprove?'A different accountant or admin must approve':'Accountant or admin approval required'}</small>}</div>
        </article>)}</div>}
      </section>
    </div>
  </div>;
}
