import { useCallback, useEffect, useRef, useState } from 'react';
import './locations.css';

const initialLocation = branchId => ({ branchId: String(branchId || ''), kind: 'warehouse', parentId: '', name: '' });
const initialAssignment = () => ({ locationId: '', itemId: '', quantity: '', reason: '', clientReference: '' });
const initialTransfer = () => ({ sourceLocationId: '', destinationLocationId: '', itemId: '', quantity: '', reason: '', clientReference: '' });
const qty = value => Number(value || 0).toLocaleString('en-IN');

export default function Locations({ context = {}, refresh }) {
  const company = context.bootstrap?.companies?.find(row => String(row.id) === String(context.companyId));
  const branches = company?.branches || [];
  const gstins = company?.gstins || [];
  const [locations, setLocations] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [items, setItems] = useState([]);
  const [locationForm, setLocationForm] = useState(() => initialLocation(context.branchId));
  const [assignmentForm, setAssignmentForm] = useState(initialAssignment);
  const [transferForm, setTransferForm] = useState(initialTransfer);
  const [receiptQuantities, setReceiptQuantities] = useState({});
  const [evidence, setEvidence] = useState({});
  const [selectedTransferId, setSelectedTransferId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const version = useRef(0);
  const request = useCallback(async (path, init = {}) => {
    const response = context.apiFetch ? await context.apiFetch(path, init) : await fetch(path, {
      ...init, headers: { 'content-type': 'application/json', 'x-company-id': context.companyId, 'x-user-id': context.userId, ...init.headers },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [context.apiFetch, context.companyId, context.userId]);
  const load = useCallback(async () => {
    const token = ++version.current;
    setLoading(true); setError('');
    try {
      const [placeData, balanceData, transferData, itemData] = await Promise.all([
        request('/api/locations'), request('/api/locations/availability'), request('/api/location-transfers'), request('/api/items'),
      ]);
      if (token !== version.current) return;
      setLocations(placeData.locations || []);
      setAvailability(balanceData.availability || []);
      setTransfers(transferData.transfers || []);
      setItems((itemData.items || []).filter(row => row.trackStock));
    } catch (cause) { if (token === version.current) setError(cause.message); }
    finally { if (token === version.current) setLoading(false); }
  }, [request]);
  useEffect(() => { setLocationForm(initialLocation(context.branchId)); setAssignmentForm(initialAssignment()); setTransferForm(initialTransfer()); setSelectedTransferId(null); setDetail(null); load(); }, [context.companyId, context.branchId, context.userId, load]);
  const update = (setter, key, value) => setter(previous => ({ ...previous, [key]: value }));
  const mutate = async (path, body, success) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(result.replayed ? 'Reference already recorded; no quantity was posted twice.' : success);
      await load(); refresh?.();
      if (selectedTransferId) await openTransfer(selectedTransferId);
      return result;
    } catch (cause) { setError(cause.message); return null; }
    finally { setBusy(false); }
  };
  const openTransfer = async id => {
    setSelectedTransferId(id); setDetail(null);
    try { setDetail(await request(`/api/location-transfers/${id}`)); }
    catch (cause) { setError(cause.message); }
  };
  const branchLabel = id => {
    const branch = branches.find(row => row.id === id);
    const gstin = gstins.find(row => row.id === branch?.gstinId);
    return `${branch?.name || `Branch #${id}`} · ${gstin?.gstin || 'GSTIN scope'}`;
  };
  const locationLabel = row => `${row.name} · ${row.kind} · ${branchLabel(row.branchId)}`;
  const source = locations.find(row => String(row.id) === transferForm.sourceLocationId);
  const destination = locations.find(row => String(row.id) === transferForm.destinationLocationId);
  const assigned = availability.find(row => String(row.locationId) === transferForm.sourceLocationId && String(row.itemId) === transferForm.itemId);
  const parents = locations.filter(row => row.branchId === Number(locationForm.branchId) && row.kind === (locationForm.kind === 'store' ? 'warehouse' : 'store'));
  const canWrite = ['staff', 'admin'].includes(context.role);

  return <section className="locations-page" aria-label="Locations and in-transit transfers">
    <header className="locations-head"><div><p className="locations-kicker">INVENTORY / ERP-003</p><h1>Locations & transfers</h1><p>Allocate counted branch stock to warehouses, stores and racks. Dispatch moves quantities into transit; receiving evidence brings them into the destination.</p></div><button type="button" onClick={load} disabled={loading || busy}>Refresh</button></header>
    <div className="locations-scope"><strong>{company?.name || 'Selected company'}</strong><span>{branchLabel(Number(context.branchId))}</span><span>{context.role || 'Current role'}</span></div>
    <p className="locations-guidance">Location assignments classify stock already posted to a branch. Cross-branch dispatch reduces physical available stock until receipt. This flow currently handles unbatched stock. Inter-GSTIN dispatch is blocked pending a reviewed tax invoice, valuation and transport document workflow; an internal transfer note is not statutory evidence.</p>
    {error && <div role="alert" className="locations-alert locations-error">{error}</div>}
    {notice && <div role="status" className="locations-alert locations-success">{notice}</div>}
    {loading && <p className="locations-empty">Loading locations and transfers…</p>}
    {canWrite && <div className="locations-forms">
      <form onSubmit={async event => { event.preventDefault(); const result = await mutate('/api/locations', { branchId: Number(locationForm.branchId), kind: locationForm.kind, parentId: locationForm.kind === 'warehouse' ? null : Number(locationForm.parentId), name: locationForm.name.trim() }, 'Location created.'); if (result) setLocationForm(initialLocation(context.branchId)); }}>
        <h2>Create location</h2><p>Build the hierarchy inside one branch.</p>
        <label>Branch<select required value={locationForm.branchId} onChange={event => setLocationForm({ branchId: event.target.value, kind: 'warehouse', parentId: '', name: '' })}><option value="">Choose branch</option>{branches.map(row => <option key={row.id} value={row.id}>{branchLabel(row.id)}</option>)}</select></label>
        <label>Type<select value={locationForm.kind} onChange={event => setLocationForm(previous => ({ ...previous, kind: event.target.value, parentId: '' }))}><option value="warehouse">Warehouse</option><option value="store">Store</option><option value="rack">Rack</option></select></label>
        {locationForm.kind !== 'warehouse' && <label>Parent<select required value={locationForm.parentId} onChange={event => update(setLocationForm, 'parentId', event.target.value)}><option value="">Choose {locationForm.kind === 'store' ? 'warehouse' : 'store'}</option>{parents.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
        <label>Name<input required maxLength="100" value={locationForm.name} onChange={event => update(setLocationForm, 'name', event.target.value)} placeholder="Main warehouse / Dispatch store / A-01" /></label>
        <button disabled={busy}>Create location</button>
      </form>
      <form onSubmit={async event => { event.preventDefault(); const result = await mutate('/api/location-assignments', { locationId: Number(assignmentForm.locationId), itemId: Number(assignmentForm.itemId), quantity: Number(assignmentForm.quantity), reason: assignmentForm.reason.trim(), clientReference: assignmentForm.clientReference.trim() }, 'Existing branch stock assigned to location.'); if (result) setAssignmentForm(initialAssignment()); }}>
        <h2>Assign existing stock</h2><p>No physical receipt is posted.</p>
        <label>Location<select required value={assignmentForm.locationId} onChange={event => update(setAssignmentForm, 'locationId', event.target.value)}><option value="">Choose location</option>{locations.map(row => <option key={row.id} value={row.id}>{locationLabel(row)}</option>)}</select></label>
        <label>Tracked item<select required value={assignmentForm.itemId} onChange={event => update(setAssignmentForm, 'itemId', event.target.value)}><option value="">Choose item</option>{items.map(row => <option key={row.id} value={row.id}>{row.sku} · {row.name}</option>)}</select></label>
        <label>Quantity<input required type="number" min="1" step="1" value={assignmentForm.quantity} onChange={event => update(setAssignmentForm, 'quantity', event.target.value)} /></label>
        <label>Count or source evidence<input required maxLength="500" value={assignmentForm.reason} onChange={event => update(setAssignmentForm, 'reason', event.target.value)} /></label>
        <label>Unique reference<input required maxLength="100" value={assignmentForm.clientReference} onChange={event => update(setAssignmentForm, 'clientReference', event.target.value)} placeholder="COUNT-MUM-001" /></label>
        <button disabled={busy}>Assign stock</button>
      </form>
      <form onSubmit={async event => { event.preventDefault(); const result = await mutate('/api/location-transfers', { sourceLocationId: Number(transferForm.sourceLocationId), destinationLocationId: Number(transferForm.destinationLocationId), itemId: Number(transferForm.itemId), quantity: Number(transferForm.quantity), reason: transferForm.reason.trim(), clientReference: transferForm.clientReference.trim() }, 'Transfer draft created.'); if (result) { setTransferForm(initialTransfer()); openTransfer(result.transfer.id); } }}>
        <h2>Prepare transfer</h2><p>Select the sending and receiving locations.</p>
        <label>Source<select required value={transferForm.sourceLocationId} onChange={event => update(setTransferForm, 'sourceLocationId', event.target.value)}><option value="">Choose source</option>{locations.map(row => <option key={row.id} value={row.id}>{locationLabel(row)}</option>)}</select></label>
        <label>Destination<select required value={transferForm.destinationLocationId} onChange={event => update(setTransferForm, 'destinationLocationId', event.target.value)}><option value="">Choose destination</option>{locations.filter(row => String(row.id) !== transferForm.sourceLocationId).map(row => <option key={row.id} value={row.id}>{locationLabel(row)}</option>)}</select></label>
        {source && destination && source.gstinId !== destination.gstinId && <p className="locations-warning">Different GSTINs: you can prepare a draft, but dispatch is blocked until the separate tax and document workflow exists.</p>}
        <label>Tracked item<select required value={transferForm.itemId} onChange={event => update(setTransferForm, 'itemId', event.target.value)}><option value="">Choose item</option>{items.map(row => <option key={row.id} value={row.id}>{row.sku} · {row.name}</option>)}</select></label>
        {assigned && <small>Source location: {qty(assigned.quantity)} units</small>}
        <label>Quantity<input required type="number" min="1" step="1" value={transferForm.quantity} onChange={event => update(setTransferForm, 'quantity', event.target.value)} /></label>
        <label>Reason<input required maxLength="500" value={transferForm.reason} onChange={event => update(setTransferForm, 'reason', event.target.value)} /></label>
        <label>Unique transfer reference<input required maxLength="100" value={transferForm.clientReference} onChange={event => update(setTransferForm, 'clientReference', event.target.value)} placeholder="XFER-001" /></label>
        <button disabled={busy}>Prepare transfer</button>
      </form>
    </div>}
    <div className="locations-register"><h2>Recorded location balances</h2><p>These assignments are reconciled against branch stock at dispatch. Sales and other stock issues without a selected location can leave a location count needing recount.</p>{availability.length === 0 ? <p className="locations-empty">No stock assigned to a location in this scope.</p> : <div className="locations-table-wrap"><table><thead><tr><th>Location</th><th>Branch / GSTIN</th><th>Item</th><th>Assigned</th><th>Check</th></tr></thead><tbody>{availability.map(row => <tr key={`${row.locationId}:${row.itemId}`}><td>{row.locationName} <small>{row.kind}</small></td><td>{branchLabel(row.branchId)}</td><td>{row.sku} · {row.itemName}</td><td>{qty(row.quantity)}</td><td>{row.reconciliationRequired ? <span className="locations-warning">Recount: assigned {qty(row.assignedBranchQuantity)} exceeds unbatched branch stock {qty(row.unbatchedPhysicalQuantity)}</span> : 'In balance'}</td></tr>)}</tbody></table></div>}</div>
    <div className="locations-register"><h2>Transfer register</h2>{transfers.length === 0 ? <p className="locations-empty">No transfers between locations in this scope.</p> : <div className="locations-table-wrap"><table><thead><tr><th>Reference</th><th>Route</th><th>Status</th><th>Sent</th><th>In transit</th><th>Received</th><th></th></tr></thead><tbody>{transfers.map(row => <tr key={row.id}><td><strong>{row.clientReference}</strong><small>{row.taxBoundary === 'inter_gstin' ? 'Inter-GSTIN · dispatch blocked' : 'Same GSTIN'}</small></td><td>{row.sourceLocationName} → {row.destinationLocationName}</td><td>{row.status.replace('_', ' ')}</td><td>{qty(row.quantity)}</td><td>{qty(row.inTransitQuantity)}</td><td>{qty(row.receivedQuantity)}</td><td><button type="button" onClick={() => openTransfer(row.id)}>Open</button></td></tr>)}</tbody></table></div>}</div>
    {detail?.transfer && <div className="locations-register locations-detail"><div className="locations-detail-head"><h2>{detail.transfer.clientReference}</h2><button type="button" onClick={() => { setDetail(null); setSelectedTransferId(null); }}>Close</button></div><p>{detail.transfer.documentLimit}</p><p><strong>{detail.transfer.status.replace('_', ' ')}</strong> · {qty(detail.transfer.inTransitQuantity)} in transit · {qty(detail.transfer.receivedQuantity)} received</p>
      {canWrite && detail.transfer.status === 'draft' && detail.transfer.taxBoundary === 'same_gstin' && <form className="locations-action" onSubmit={async event => { event.preventDefault(); await mutate(`/api/location-transfers/${detail.transfer.id}/dispatch`, { evidenceReference: evidence[`dispatch:${detail.transfer.id}`] || '' }, 'Dispatch recorded; quantity is in transit.'); }}><label>Sending evidence reference<input required maxLength="160" value={evidence[`dispatch:${detail.transfer.id}`] || ''} onChange={event => setEvidence(previous => ({ ...previous, [`dispatch:${detail.transfer.id}`]: event.target.value }))} placeholder="Dispatch note / challan reference" /></label><button disabled={busy}>Dispatch</button></form>}
      {canWrite && ['dispatched', 'partial_received'].includes(detail.transfer.status) && <form className="locations-action" onSubmit={async event => { event.preventDefault(); const result = await mutate(`/api/location-transfers/${detail.transfer.id}/receive`, { quantity: Number(receiptQuantities[detail.transfer.id] || ''), evidenceReference: evidence[`receive:${detail.transfer.id}`] || '', clientReference: `${detail.transfer.clientReference}-RCV-${(detail.receipts || []).length + 1}` }, 'Receipt recorded against in-transit stock.'); if (result) { setReceiptQuantities(previous => ({ ...previous, [detail.transfer.id]: '' })); setEvidence(previous => ({ ...previous, [`receive:${detail.transfer.id}`]: '' })); } }}><label>Quantity received<input required type="number" min="1" max={detail.transfer.inTransitQuantity} step="1" value={receiptQuantities[detail.transfer.id] || ''} onChange={event => setReceiptQuantities(previous => ({ ...previous, [detail.transfer.id]: event.target.value }))} /></label><label>Receiving evidence reference<input required maxLength="160" value={evidence[`receive:${detail.transfer.id}`] || ''} onChange={event => setEvidence(previous => ({ ...previous, [`receive:${detail.transfer.id}`]: event.target.value }))} placeholder="Goods receipt reference" /></label><button disabled={busy}>Receive quantity</button></form>}
      <h3>Audit trail</h3><ol className="locations-events">{(detail.events || []).map(row => <li key={row.id}><strong>{row.action}</strong> · {qty(row.quantity)} units · actor #{row.actorId} · {row.createdAt}{row.evidenceReference ? ` · ${row.evidenceReference}` : ''}</li>)}</ol>
    </div>}
  </section>;
}
