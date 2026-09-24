import { useCallback, useEffect, useRef, useState } from 'react';
import './batchInventory.css';

const today = () => new Date().toISOString().slice(0, 10);
const initial = branchId => ({ itemId: '', branchId: String(branchId || ''), toBranchId: '', batchCode: '', manufacturedOn: '', expiresOn: '', quantity: '', reason: '', clientReference: '' });
const count = value => Number(value || 0).toLocaleString('en-IN');

export default function BatchInventory({ context = {}, refresh }) {
  const company = context.bootstrap?.companies?.find(entry => String(entry.id) === String(context.companyId));
  const branches = company?.branches || [];
  const [mode, setMode] = useState('receive');
  const [form, setForm] = useState(() => initial(context.branchId));
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [items, setItems] = useState([]);
  const [rows, setRows] = useState([]);
  const [expiring, setExpiring] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const version = useRef(0);
  const entryRef = useRef(null);
  const request = useCallback(async (path, init = {}) => {
    const response = context.apiFetch ? await context.apiFetch(path, init) : await fetch(path, { ...init, headers: { 'content-type': 'application/json', 'x-company-id': context.companyId, 'x-user-id': context.userId, ...init.headers } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }, [context.apiFetch, context.companyId, context.userId]);
  const load = useCallback(async () => {
    const token = ++version.current;
    setLoading(true); setError(''); setRows([]); setExpiring([]); setLedger([]); setItems([]);
    try {
      const [stockResult, itemResult] = await Promise.all([request(`/api/batches?branchId=${context.branchId}&expiringWithinDays=30`), request('/api/items')]);
      if (token !== version.current) return;
      setRows(stockResult.batches || []); setExpiring(stockResult.expiring || []); setLedger(stockResult.ledger || []);
      setItems((itemResult.items || []).filter(item => item.trackStock));
    } catch (cause) { if (token === version.current) setError(cause.message); }
    finally { if (token === version.current) setLoading(false); }
  }, [context.branchId, request]);
  useEffect(() => { setForm(initial(context.branchId)); setSelectedBatchId(''); load(); }, [context.companyId, context.branchId, load]);
  const update = (key, value) => setForm(previous => ({ ...previous, [key]: value }));
  const submit = async event => {
    event.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      let path, body;
      const quantity = Number(form.quantity);
      const clientReference = form.clientReference.trim() || undefined;
      if (mode === 'receive' || mode === 'assign') {
        path = mode === 'receive' ? '/api/batches/receive' : '/api/batches/assign';
        body = { itemId: Number(form.itemId), branchId: Number(context.branchId), gstinId: Number(context.gstinId), batchCode: form.batchCode.trim(), manufacturedOn: form.manufacturedOn || undefined, expiresOn: form.expiresOn, quantity, reason: form.reason.trim(), clientReference };
      } else if (mode === 'issue') {
        path = `/api/batches/${selectedBatchId}/issue`;
        body = { branchId: Number(context.branchId), quantity, reason: form.reason.trim(), clientReference };
      } else {
        path = `/api/batches/${selectedBatchId}/transfer`;
        body = { fromBranchId: Number(context.branchId), toBranchId: Number(form.toBranchId), quantity, reason: form.reason.trim(), clientReference };
      }
      const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(result.replayed ? 'This reference was already recorded; no stock was added twice.' : `${mode === 'receive' ? 'New stock received' : mode === 'assign' ? 'Existing stock assigned' : mode === 'issue' ? 'Batch issued' : 'Transfer recorded'} · ${result.operationReference}`);
      setForm(initial(context.branchId)); setSelectedBatchId(''); await load(); refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const selected = rows.find(row => String(row.id) === String(selectedBatchId));
  const available = rows.filter(row => row.quantity > 0);
  return <section className="batch-page" aria-label="Batch inventory">
    <header className="batch-head"><div><p className="batch-eyebrow">INVENTORY / BATCH CONTROL</p><h1>Batch inventory</h1><p>Record lot receipts, controlled issues, and branch transfers. Every action posts to branch stock.</p></div><button type="button" className="batch-refresh" onClick={load}>Refresh</button></header>
    <div className="batch-note">New sales, dispatches and manual issues allocate unexpired lots first; supplier returns may remove expired lots. Use <strong>Receive new</strong> when physical stock has not been posted. Use <strong>Assign existing</strong> to tag stock already posted by a purchase invoice or order receipt without increasing branch stock. Transfers need separate tax or e-way documentation where applicable.</div>
    <button className="batch-jump" type="button" onClick={() => entryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>+ Record movement</button>
    {error && <div className="batch-alert batch-error" role="alert">{error}</div>}
    {notice && <div className="batch-alert batch-success" role="status">{notice}</div>}
    <div className="batch-layout"><div className="batch-panel batch-entry" ref={entryRef}><div className="batch-panel-head"><div><h2>Record movement</h2><p>{company?.name} · {branches.find(branch => String(branch.id) === String(context.branchId))?.name}</p></div></div>
      <div className="batch-tabs" role="tablist" aria-label="Movement type">{[['receive','Receive new'],['assign','Assign existing'],['issue','Issue'],['transfer','Transfer']].map(([key,label]) => <button key={key} type="button" role="tab" aria-selected={mode === key} className={mode === key ? 'selected' : ''} onClick={() => { setMode(key); setError(''); }}>{label}</button>)}</div>
      <form className="batch-form" onSubmit={submit}>
        {mode === 'receive' || mode === 'assign' ? <>
          <label>Tracked item<select required value={form.itemId} onChange={event => update('itemId', event.target.value)}><option value="">Choose item</option>{items.map(item => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></label>
          <label>Exact batch or lot ID<input required maxLength="80" value={form.batchCode} onChange={event => update('batchCode', event.target.value)} placeholder="Manufacturer lot / internal batch" /></label>
          <div className="batch-two"><label>Manufactured on<input type="date" value={form.manufacturedOn} onChange={event => update('manufacturedOn', event.target.value)} /></label><label>Expires on<input required type="date" value={form.expiresOn} onChange={event => update('expiresOn', event.target.value)} /></label></div>
        </> : <>
          <label>Batch in current branch<select required value={selectedBatchId} onChange={event => setSelectedBatchId(event.target.value)}><option value="">Choose batch</option>{available.map(row => <option key={row.id} value={row.id}>{row.batchCode} · {row.sku} · {count(row.quantity)} available</option>)}</select></label>
          {selected && <p className="batch-available">Available {count(selected.quantity)} · expires {selected.expiresOn}{selected.expiresOn < today() && mode === 'issue' ? ' · expired: issue blocked' : ''}</p>}
          {mode === 'transfer' && <label>Destination branch<select required value={form.toBranchId} onChange={event => update('toBranchId', event.target.value)}><option value="">Choose branch</option>{branches.filter(branch => String(branch.id) !== String(context.branchId)).map(branch => <option key={branch.id} value={branch.id}>{branch.name} · {company?.gstins?.find(gstin => gstin.id === branch.gstinId)?.gstin}</option>)}</select></label>}
        </>}
        <div className="batch-two"><label>Quantity<input required type="number" min="1" step="1" value={form.quantity} onChange={event => update('quantity', event.target.value)} /></label><label>Reference <span>(retry safe)</span><input maxLength="100" value={form.clientReference} onChange={event => update('clientReference', event.target.value)} placeholder="GRN / transfer ID" /></label></div>
        <label>Reason / source evidence<input required maxLength="500" value={form.reason} onChange={event => update('reason', event.target.value)} placeholder={mode === 'receive' ? 'Supplier delivery / GRN' : mode === 'assign' ? 'Purchase invoice / order receipt reference' : mode === 'issue' ? 'Dispatch or consumption' : 'Transfer note'} /></label>
        {mode === 'assign' && <p className="batch-available">Assigning changes lot balances only. Total branch stock stays the same.</p>}
        <button className="batch-primary" disabled={busy || loading}>{busy ? 'Recording…' : mode === 'receive' ? 'Receive new stock' : mode === 'assign' ? 'Assign existing stock' : mode === 'issue' ? 'Issue from batch' : 'Transfer batch stock'}</button>
      </form>
    </div><div className="batch-panel batch-expiry"><div className="batch-panel-head"><div><h2>Expiry watch</h2><p>Current branch · expired or due within 30 days</p></div><strong>{expiring.length}</strong></div>{loading ? <p className="batch-empty">Loading…</p> : expiring.length === 0 ? <p className="batch-empty">No expiring batch stock in this branch.</p> : <ul>{expiring.map(row => <li key={`${row.id}:${row.branchId}`}><span><strong>{row.batchCode}</strong><small>{row.itemName} · {count(row.quantity)} units</small></span><time className={row.expiresOn < today() ? 'expired' : ''}>{row.expiresOn}</time></li>)}</ul>}</div></div>
    <div className="batch-panel batch-register batch-available-register"><div className="batch-panel-head"><div><h2>Available batches</h2><p>Selected branch · exact lot identity and expiry</p></div><strong>{rows.length}</strong></div>{loading ? <p className="batch-empty">Loading batches…</p> : rows.length === 0 ? <p className="batch-empty">No allocated batches here. Receive the first lot to begin tracking.</p> : <div className="batch-table-wrap"><table><thead><tr><th>Batch</th><th>Item</th><th>Manufactured</th><th>Expires</th><th className="numeric">On hand</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.id}:${row.branchId}`}><td><strong>{row.batchCode}</strong></td><td>{row.sku} · {row.itemName}</td><td>{row.manufacturedOn || '—'}</td><td>{row.expiresOn}</td><td className="numeric"><strong>{count(row.quantity)}</strong></td></tr>)}</tbody></table></div>}</div>
    <div className="batch-panel batch-register"><div className="batch-panel-head"><div><h2>Batch ledger</h2><p>Latest 200 movements · linked to ordinary stock movement IDs</p></div></div>{loading ? <p className="batch-empty">Loading ledger…</p> : ledger.length === 0 ? <p className="batch-empty">No batch movements recorded yet.</p> : <div className="batch-table-wrap"><table><thead><tr><th>Batch / item</th><th>Movement</th><th>Reason</th><th>Evidence</th><th className="numeric">Quantity</th></tr></thead><tbody>{ledger.map(row => <tr key={row.id}><td><strong>{row.batchCode}</strong><small>{row.sku}</small></td><td>{row.isAllocation ? 'assign existing' : row.type.replace('_', ' ')}</td><td>{row.reason}</td><td><small>Stock #{row.stockMovementId}<br />{row.operationReference}</small></td><td className="numeric"><strong className={row.quantityDelta < 0 ? 'negative' : ''}>{row.quantityDelta > 0 ? '+' : ''}{count(row.quantityDelta)}</strong></td></tr>)}</tbody></table></div>}</div>
  </section>;
}
