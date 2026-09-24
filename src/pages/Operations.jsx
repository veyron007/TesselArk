import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './operations.css';

const today = () => new Date().toISOString().slice(0, 10);
const sections = [['invoices', 'Invoices'], ['stock', 'Stock'], ['items', 'Items'], ['parties', 'Parties']];
const money = (cents) => `₹${(Number(cents || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const emptyLine = () => ({ itemId: '', quantity: 1, unitPrice: '', gstRate: '' });

function requestError(error) {
  return error?.message || 'The request could not be completed.';
}

function taxLabel(bps) {
  return `${number(Number(bps || 0) / 100)}%`;
}

function Field({ label, children, hint }) {
  return <label className="ops-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function Empty({ children }) {
  return <div className="ops-empty">{children}</div>;
}

export default function Operations({ context = {}, refresh, bootstrap, selection, refreshDashboard, initialInvoiceId, onOpenDocument, onNavigate }) {
  const active = { ...selection, ...context };
  const seed = context.bootstrap || bootstrap || {};
  const companyId = active.companyId || seed.currentCompanyId;
  const userId = active.userId || seed.currentUserId;
  const role = active.role || seed.users?.find((user) => String(user.id) === String(userId))?.role || 'staff';
  const company = seed.companies?.find((entry) => String(entry.id) === String(companyId));
  const composition = company?.taxRegime === 'composition';
  const branches = company?.branches || seed.branches?.filter((entry) => String(entry.companyId) === String(companyId)) || [];
  const gstins = company?.gstins || seed.gstins?.filter((entry) => String(entry.companyId) === String(companyId)) || [];
  const branchId = active.branchId || branches[0]?.id || '';
  const gstinId = branches.find((branch) => String(branch.id) === String(branchId))?.gstinId || active.gstinId || gstins[0]?.id || '';
  const [tab, setTab] = useState('invoices');
  const [items, setItems] = useState([]);
  const [parties, setParties] = useState([]);
  const [stock, setStock] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [detail, setDetail] = useState(null);
  const openedInvoiceId = useRef('');
  const loadSequence = useRef(0);
  const focusReturn = useRef(null);
  const scopeKey = `${companyId}:${branchId}:${gstinId}`;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [itemOpen, setItemOpen] = useState(false);
  const [partyOpen, setPartyOpen] = useState(false);
  const [movementOpen, setMovementOpen] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState({ type: 'sale', partyId: '', branchId, gstinId, invoiceDate: today(), supplierInvoiceNumber: '', notes: '', lines: [emptyLine()] });
  const [itemForm, setItemForm] = useState({ sku: '', name: '', hsn: '', unit: 'pcs', gstRate: '18', reorderLevel: '0' });
  const [partyForm, setPartyForm] = useState({ name: '', type: 'customer', gstin: '', stateCode: '', address: '', phone: '' });
  const [movementForm, setMovementForm] = useState({ itemId: '', branchId, type: 'receipt', quantity: '', reason: '' });

  const api = useCallback(async (path, init = {}) => {
    const response = context.apiFetch ? await context.apiFetch(path, init) : await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'x-company-id': companyId, 'x-user-id': userId, ...init.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.message || `Request failed (${response.status})`);
    return body;
  }, [companyId, context.apiFetch, userId]);

  const load = useCallback(async () => {
    if (currentScope.current !== scopeKey) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError('');
    setItems([]);
    setParties([]);
    setStock([]);
    setInvoices([]);
    setDetail(null);
    if (!companyId) { setLoading(false); return; }
    try {
      const [itemResult, partyResult, stockResult, invoiceResult] = await Promise.all([
        api('/api/items'), api('/api/parties'), api('/api/stock'), api('/api/invoices'),
      ]);
      if (sequence !== loadSequence.current || currentScope.current !== scopeKey) return;
      setItems(itemResult.items || []);
      setParties(partyResult.parties || []);
      setStock(stockResult.stock || []);
      setInvoices(invoiceResult.invoices || []);
    } catch (cause) {
      if (sequence === loadSequence.current && currentScope.current === scopeKey) setError(requestError(cause));
    } finally {
      if (sequence === loadSequence.current && currentScope.current === scopeKey) setLoading(false);
    }
  }, [api, companyId, scopeKey]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setInvoiceForm({ type: 'sale', partyId: '', branchId, gstinId, invoiceDate: today(), supplierInvoiceNumber: '', notes: '', lines: [emptyLine()] });
    setMovementForm({ itemId: '', branchId, type: 'receipt', quantity: '', reason: '' });
    setItemForm({ sku: '', name: '', hsn: '', unit: 'pcs', gstRate: '18', reorderLevel: '0' });
    setPartyForm({ name: '', type: 'customer', gstin: '', stateCode: '', address: '', phone: '' });
    setInvoiceOpen(false); setMovementOpen(false); setItemOpen(false); setPartyOpen(false);
    setDetail(null);
    setNotice('');
  }, [companyId, branchId, gstinId]);
  useEffect(() => {
    setInvoiceForm((previous) => ({ ...previous, branchId, gstinId }));
    setMovementForm((previous) => ({ ...previous, branchId }));
  }, [branchId, gstinId]);
  const activeDialog = invoiceOpen ? 'invoice' : itemOpen ? 'item' : partyOpen ? 'party' : movementOpen ? 'movement' : detail ? `detail-${detail.id}` : '';
  useEffect(() => {
    if (!activeDialog) return undefined;
    const dialog = document.querySelector('.ops-overlay .ops-dialog');
    if (!dialog) return undefined;
    if (!focusReturn.current || !focusReturn.current.isConnected) focusReturn.current = document.activeElement;
    const focusable = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')].filter((element) => element.getClientRects().length);
    const focusTimer = requestAnimationFrame(() => (dialog.querySelector('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || focusable()[0] || dialog).focus());
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        setInvoiceOpen(false); setItemOpen(false); setPartyOpen(false); setMovementOpen(false); setDetail(null);
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) { event.preventDefault(); dialog.focus(); return; }
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const onFocusIn = (event) => { if (!dialog.contains(event.target)) (focusable()[0] || dialog).focus(); };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      queueMicrotask(() => {
        if (!document.querySelector('.ops-overlay .ops-dialog')) {
          if (focusReturn.current?.isConnected) focusReturn.current.focus();
          focusReturn.current = null;
        }
      });
    };
  }, [activeDialog]);

  const act = async (work, success, afterSuccess) => {
    const startedIn = scopeKey;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await work();
      if (currentScope.current !== startedIn) return;
      afterSuccess?.(result);
      setNotice(success);
      await load();
      if (currentScope.current !== startedIn) return;
      if (result?.invoice) setDetail(result.invoice);
      await (refresh || refreshDashboard)?.();
    } catch (cause) {
      if (currentScope.current === startedIn) setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id) => {
    const requestedIn = scopeKey;
    setError('');
    try {
      const result = await api(`/api/invoices/${id}`);
      if (currentScope.current === requestedIn) setDetail(result.invoice);
    } catch (cause) {
      if (currentScope.current === requestedIn) setError(requestError(cause));
    }
  };

  useEffect(() => {
    if (loading || !initialInvoiceId || !invoices.some((invoice) => String(invoice.id) === String(initialInvoiceId))) return;
    const key = `${companyId}:${initialInvoiceId}`;
    if (openedInvoiceId.current === key) return;
    openedInvoiceId.current = key;
    openDetail(initialInvoiceId);
  }, [loading, initialInvoiceId, companyId, invoices]);

  const transition = (invoice, action) => act(() => api(`/api/invoices/${invoice.id}/${action}`, { method: 'POST' }),
    action === 'approve' ? 'Invoice approved. Stock and GST records were posted.' : 'Invoice submitted for review.');

  const saveItem = async (event) => {
    event.preventDefault();
    await act(() => api('/api/items', { method: 'POST', body: JSON.stringify({
        sku: itemForm.sku.trim(), name: itemForm.name.trim(), hsn: itemForm.hsn.trim(), unit: itemForm.unit.trim(),
        gstRateBps: Math.round(Number(itemForm.gstRate) * 100), reorderLevel: Number(itemForm.reorderLevel),
      }) }), 'Item added to the catalogue.', () => {
      setItemOpen(false);
      setItemForm({ sku: '', name: '', hsn: '', unit: 'pcs', gstRate: '18', reorderLevel: '0' });
    });
  };

  const saveParty = async (event) => {
    event.preventDefault();
    await act(() => api('/api/parties', { method: 'POST', body: JSON.stringify({ ...partyForm, name: partyForm.name.trim(), gstin: partyForm.gstin.trim().toUpperCase() }) }), 'Party added.', () => {
      setPartyOpen(false);
      setPartyForm({ name: '', type: 'customer', gstin: '', stateCode: '', address: '', phone: '' });
    });
  };

  const saveMovement = async (event) => {
    event.preventDefault();
    await act(() => api('/api/stock/movements', { method: 'POST', body: JSON.stringify({
        ...movementForm, itemId: Number(movementForm.itemId), branchId: Number(movementForm.branchId),
        quantity: Number(movementForm.quantity), reason: movementForm.reason.trim(),
      }) }), 'Stock movement recorded.', () => {
      setMovementOpen(false);
      setMovementForm({ itemId: '', branchId, type: 'receipt', quantity: '', reason: '' });
    });
  };

  const saveInvoice = async (event) => {
    event.preventDefault();
    if (invoiceForm.type === 'purchase' && !invoiceForm.supplierInvoiceNumber.trim()) {
      setError('Enter the supplier invoice number to support a later 2B match.');
      return;
    }
    await act(() => api('/api/invoices', { method: 'POST', body: JSON.stringify({
        type: invoiceForm.type, partyId: Number(invoiceForm.partyId), branchId: Number(invoiceForm.branchId),
        gstinId: Number(invoiceForm.gstinId), invoiceDate: invoiceForm.invoiceDate,
        ...(invoiceForm.type === 'purchase' ? { supplierInvoiceNumber: invoiceForm.supplierInvoiceNumber.trim() } : {}),
        notes: invoiceForm.notes,
        lines: invoiceForm.lines.map((line) => ({ itemId: Number(line.itemId), quantity: Number(line.quantity),
          unitPriceCents: Math.round(Number(line.unitPrice) * 100), gstRateBps: Math.round(Number(line.gstRate) * 100) })),
      }) }), 'Invoice draft created. Submit it when ready for review.', () => {
      setInvoiceOpen(false);
      setInvoiceForm({ type: 'sale', partyId: '', branchId, gstinId, invoiceDate: today(), supplierInvoiceNumber: '', notes: '', lines: [emptyLine()] });
    });
  };

  const updateLine = (index, patch) => setInvoiceForm((previous) => ({ ...previous,
    lines: previous.lines.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line),
  }));
  const addLine = () => setInvoiceForm((previous) => ({ ...previous, lines: [...previous.lines, emptyLine()] }));
  const removeLine = (index) => setInvoiceForm((previous) => ({ ...previous,
    lines: previous.lines.filter((_, lineIndex) => lineIndex !== index),
  }));
  const chooseItem = (index, itemId) => {
    const item = items.find((entry) => String(entry.id) === String(itemId));
    updateLine(index, { itemId, gstRate: item ? String(composition ? 0 : Number(item.gstRateBps) / 100) : '' });
  };
  const lineTotal = (line) => Number(line.quantity || 0) * Number(line.unitPrice || 0) * (1 + Number(line.gstRate || 0) / 100);
  const estimatedTotal = useMemo(() => invoiceForm.lines.reduce((sum, line) => sum + lineTotal(line), 0), [invoiceForm.lines]);
  const query = search.trim().toLowerCase();
  const matching = (entries, keys) => entries.filter((entry) => keys.some((key) => String(entry[key] || '').toLowerCase().includes(query)));
  const visibleInvoices = matching(invoices, ['number', 'partyName', 'type', 'status'])
    .filter((invoice) => (typeFilter === 'all' || invoice.type === typeFilter) && (statusFilter === 'all' || invoice.status === statusFilter));
  const visibleItems = matching(items, ['sku', 'name', 'hsn']);
  const visibleParties = matching(parties, ['name', 'gstin', 'type']);
  const visibleStock = matching(stock, ['itemName', 'sku', 'branchName']);

  return <div className="ops-page">
    <div className="ops-heading page-header"><div><p className="ops-eyebrow">TRADE OPERATIONS</p><h1>Operations</h1><p className="muted">Prepare transactions, review stock, and post approved invoices for {company?.name || 'your company'}.</p></div>
      <button type="button" className="btn btn-secondary" onClick={load} disabled={loading || busy}>Refresh data</button></div>
    <div className="ops-tabs" role="tablist" aria-label="Operations sections" onKeyDown={(event) => {
      const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : offset ? (sections.findIndex(([key]) => key === tab) + offset + sections.length) % sections.length : -1;
      if (next < 0) return;
      event.preventDefault(); setTab(sections[next][0]); setSearch('');
      event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
    }}>
      {sections.map(([key, label]) =>
        <button key={key} id={`ops-tab-${key}`} type="button" role="tab" aria-controls="ops-panel" aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} className={tab === key ? 'ops-tab active' : 'ops-tab'} onClick={() => { setTab(key); setSearch(''); }}>{label}</button>)}
    </div>
    {error && <div className="ops-alert error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {notice && <div className="ops-alert success" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
    <section id="ops-panel" role="tabpanel" aria-labelledby={`ops-tab-${tab}`} className="card ops-panel">
      <div className="ops-toolbar"><div><h2>{tab === 'invoices' ? 'Sales & purchase invoices' : tab === 'stock' ? 'Stock by branch' : tab === 'items' ? 'Item catalogue' : 'Party directory'}</h2><p className="muted">{tab === 'invoices' ? 'Draft, submit, then approve to post inventory and GST.' : tab === 'stock' ? 'Quantities reflect approved invoices and recorded movements.' : tab === 'items' ? 'Products and their GST classification.' : 'Customers and suppliers used on invoices.'}</p></div>
        <div className="ops-toolbar-actions"><input aria-label={`Search ${tab}`} placeholder={`Search ${tab}…`} value={search} onChange={(event) => setSearch(event.target.value)} />
          {tab === 'invoices' && <><select aria-label="Filter invoice type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">All types</option><option value="sale">Sales</option><option value="purchase">Purchases</option></select><select aria-label="Filter invoice status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="draft">Draft</option><option value="submitted">Submitted</option><option value="approved">Approved</option></select></>}
          <button type="button" className="btn btn-primary" onClick={() => tab === 'invoices' ? setInvoiceOpen(true) : tab === 'stock' ? setMovementOpen(true) : tab === 'items' ? setItemOpen(true) : setPartyOpen(true)}>{tab === 'invoices' ? '+ New invoice' : tab === 'stock' ? '+ Stock movement' : tab === 'items' ? '+ New item' : '+ New party'}</button></div></div>
      {tab === 'invoices' && !loading && <div className="ops-result-count" aria-live="polite">Showing {visibleInvoices.length} of {invoices.length} invoices</div>}
      {loading ? <Empty>Loading operations…</Empty> : <div className={tab === 'invoices' ? 'ops-table-wrap ops-invoice-table-wrap' : 'ops-table-wrap'}><table className="ops-table"><thead><tr>
        {tab === 'invoices' && <><th>Invoice</th><th>Party</th><th>Date</th><th>Branch</th><th>Status</th><th className="numeric">Total</th><th></th></>}
        {tab === 'stock' && <><th>Item</th><th>Branch</th><th className="numeric">On hand</th><th className="numeric">Reorder at</th><th>Health</th></>}
        {tab === 'items' && <><th>Item</th><th>SKU</th><th>HSN</th><th>Unit</th><th>GST</th><th className="numeric">Reorder at</th></>}
        {tab === 'parties' && <><th>Party</th><th>Type</th><th>GSTIN</th><th>State</th><th>Phone</th></>}
      </tr></thead><tbody>
        {tab === 'invoices' && visibleInvoices.map((invoice) => <tr key={invoice.id}><td><strong>{invoice.number || `Draft #${invoice.id}`}</strong><small>{invoice.type === 'purchase' ? 'Purchase' : 'Sale'}</small></td><td>{invoice.partyName || parties.find((party) => String(party.id) === String(invoice.partyId))?.name || '—'}</td><td>{invoice.invoiceDate || '—'}</td><td>{branches.find((branch) => String(branch.id) === String(invoice.branchId))?.name || '—'}</td><td><span className={`ops-status ${invoice.status}`}>{invoice.status}</span></td><td className="numeric">{money(invoice.totalCents)}</td><td><button type="button" className="ops-link" onClick={() => openDetail(invoice.id)}>Open</button></td></tr>)}
        {tab === 'stock' && visibleStock.map((row) => <tr key={`${row.itemId}-${row.branchId}`}><td><strong>{row.itemName}</strong><small>{row.sku}</small></td><td>{row.branchName || branches.find((branch) => String(branch.id) === String(row.branchId))?.name || '—'}</td><td className="numeric">{number(row.quantity)}</td><td className="numeric">{number(row.reorderLevel)}</td><td><span className={`ops-status ${Number(row.quantity) <= Number(row.reorderLevel) ? 'low' : 'healthy'}`}>{Number(row.quantity) <= Number(row.reorderLevel) ? 'Reorder' : 'Healthy'}</span></td></tr>)}
        {tab === 'items' && visibleItems.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.sku}</td><td>{item.hsn || '—'}</td><td>{item.unit}</td><td>{taxLabel(item.gstRateBps)}</td><td className="numeric">{number(item.reorderLevel)}</td></tr>)}
        {tab === 'parties' && visibleParties.map((party) => <tr key={party.id}><td><strong>{party.name}</strong><small>{party.address}</small></td><td className="ops-capitalize">{party.type}</td><td>{party.gstin || 'Unregistered'}</td><td>{party.stateCode || '—'}</td><td>{party.phone || '—'}</td></tr>)}
      </tbody></table>{tab === 'invoices' && <div className="ops-mobile-invoices">{visibleInvoices.map((invoice) => <article className="ops-mobile-invoice" key={invoice.id}><div className="ops-mobile-invoice-top"><div><strong>{invoice.number || `Draft #${invoice.id}`}</strong><span>{invoice.type === 'purchase' ? 'Purchase' : 'Sale'} · {invoice.invoiceDate || 'No date'}</span></div><span className={`ops-status ${invoice.status}`}>{invoice.status}</span></div><p>{invoice.partyName || parties.find((party) => String(party.id) === String(invoice.partyId))?.name || 'Unknown party'}</p><div className="ops-mobile-invoice-bottom"><strong>{money(invoice.totalCents)}</strong><button type="button" className="ops-link" onClick={() => openDetail(invoice.id)}>Open invoice →</button></div></article>)}</div>}{((tab === 'invoices' && !visibleInvoices.length) || (tab === 'stock' && !visibleStock.length) || (tab === 'items' && !visibleItems.length) || (tab === 'parties' && !visibleParties.length)) && <Empty>{query || (tab === 'invoices' && (typeFilter !== 'all' || statusFilter !== 'all')) ? 'No records match these filters.' : `No ${tab} yet. Use the button above to begin.`}</Empty>}</div>}
    </section>

    {itemOpen && <div className="ops-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setItemOpen(false); }}><form className="ops-dialog" role="dialog" aria-modal="true" aria-label="Add an item" tabIndex={-1} onSubmit={saveItem}><div className="ops-dialog-head"><div><p className="ops-eyebrow">CATALOGUE</p><h2>Add an item</h2></div><button type="button" className="ops-close" aria-label="Close dialog" onClick={() => setItemOpen(false)}>×</button></div><div className="ops-form-grid"><Field label="Item name"><input required value={itemForm.name} onChange={(event) => setItemForm({ ...itemForm, name: event.target.value })} /></Field><Field label="SKU"><input required value={itemForm.sku} onChange={(event) => setItemForm({ ...itemForm, sku: event.target.value })} /></Field><Field label="HSN code"><input value={itemForm.hsn} onChange={(event) => setItemForm({ ...itemForm, hsn: event.target.value })} /></Field><Field label="Unit"><input required value={itemForm.unit} onChange={(event) => setItemForm({ ...itemForm, unit: event.target.value })} /></Field><Field label="GST rate %"><input type="number" min="0" max="100" step="0.01" required value={itemForm.gstRate} onChange={(event) => setItemForm({ ...itemForm, gstRate: event.target.value })} /></Field><Field label="Reorder level"><input type="number" min="0" step="1" required value={itemForm.reorderLevel} onChange={(event) => setItemForm({ ...itemForm, reorderLevel: event.target.value })} /></Field></div><div className="ops-dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setItemOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={busy}>Save item</button></div></form></div>}

    {partyOpen && <div className="ops-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setPartyOpen(false); }}><form className="ops-dialog" role="dialog" aria-modal="true" aria-label="Add a party" tabIndex={-1} onSubmit={saveParty}><div className="ops-dialog-head"><div><p className="ops-eyebrow">DIRECTORY</p><h2>Add a party</h2></div><button type="button" className="ops-close" aria-label="Close dialog" onClick={() => setPartyOpen(false)}>×</button></div><div className="ops-form-grid"><Field label="Name"><input required value={partyForm.name} onChange={(event) => setPartyForm({ ...partyForm, name: event.target.value })} /></Field><Field label="Type"><select value={partyForm.type} onChange={(event) => setPartyForm({ ...partyForm, type: event.target.value })}><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Both</option></select></Field><Field label="GSTIN"><input maxLength="15" value={partyForm.gstin} onChange={(event) => setPartyForm({ ...partyForm, gstin: event.target.value.toUpperCase() })} placeholder="Optional for unregistered parties" /></Field><Field label="State code"><input maxLength="2" value={partyForm.stateCode} onChange={(event) => setPartyForm({ ...partyForm, stateCode: event.target.value })} placeholder="e.g. 27" /></Field><Field label="Phone"><input value={partyForm.phone} onChange={(event) => setPartyForm({ ...partyForm, phone: event.target.value })} /></Field><Field label="Address"><input value={partyForm.address} onChange={(event) => setPartyForm({ ...partyForm, address: event.target.value })} /></Field></div><div className="ops-dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setPartyOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={busy}>Save party</button></div></form></div>}

    {movementOpen && <div className="ops-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setMovementOpen(false); }}><form className="ops-dialog" role="dialog" aria-modal="true" aria-label="Record stock movement" tabIndex={-1} onSubmit={saveMovement}><div className="ops-dialog-head"><div><p className="ops-eyebrow">INVENTORY</p><h2>Record stock movement</h2></div><button type="button" className="ops-close" aria-label="Close dialog" onClick={() => setMovementOpen(false)}>×</button></div><div className="ops-form-grid"><Field label="Item"><select required value={movementForm.itemId} onChange={(event) => setMovementForm({ ...movementForm, itemId: event.target.value })}><option value="">Select item</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.sku}</option>)}</select></Field><Field label="Branch"><select required value={movementForm.branchId} onChange={(event) => setMovementForm({ ...movementForm, branchId: event.target.value })}><option value="">Select branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></Field><Field label="Movement"><select value={movementForm.type} onChange={(event) => setMovementForm({ ...movementForm, type: event.target.value })}><option value="receipt">Receipt</option><option value="issue">Issue</option><option value="adjustment">Adjustment</option></select></Field><Field label="Quantity" hint={movementForm.type === 'adjustment' ? 'Use a negative whole number to reduce stock.' : 'Enter a positive whole-unit quantity.'}><input type="number" step="1" required min={movementForm.type === 'adjustment' ? undefined : '1'} value={movementForm.quantity} onChange={(event) => setMovementForm({ ...movementForm, quantity: event.target.value })} /></Field><Field label="Reason"><input required value={movementForm.reason} onChange={(event) => setMovementForm({ ...movementForm, reason: event.target.value })} placeholder="Why is this stock changing?" /></Field></div><div className="ops-dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMovementOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={busy}>Record movement</button></div></form></div>}

    {invoiceOpen && <div className="ops-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setInvoiceOpen(false); }}><form className="ops-dialog wide" role="dialog" aria-modal="true" aria-label="Create invoice draft" tabIndex={-1} onSubmit={saveInvoice}><div className="ops-dialog-head"><div><p className="ops-eyebrow">NEW TRANSACTION</p><h2>Create invoice draft</h2><p className="muted">The draft affects stock and GST after accountant approval.</p></div><button type="button" className="ops-close" aria-label="Close dialog" onClick={() => setInvoiceOpen(false)}>×</button></div><div className="ops-context-summary" aria-label="Invoice context"><span><small>COMPANY</small><strong>{company?.name || '—'}</strong></span><span><small>GSTIN</small><strong>{gstins.find((entry) => String(entry.id) === String(invoiceForm.gstinId))?.gstin || '—'}</strong></span><span><small>PREPARING AS</small><strong className="ops-capitalize">{role}</strong></span></div><div className="ops-form-grid"><Field label="Transaction"><select value={invoiceForm.type} onChange={(event) => setInvoiceForm({ ...invoiceForm, type: event.target.value, partyId: '' })}><option value="sale">Sale</option><option value="purchase">Purchase</option></select></Field><Field label={invoiceForm.type === 'sale' ? 'Customer' : 'Supplier'}><select required value={invoiceForm.partyId} onChange={(event) => setInvoiceForm({ ...invoiceForm, partyId: event.target.value })}><option value="">Select party</option>{parties.filter((party) => party.type === 'both' || party.type === (invoiceForm.type === 'sale' ? 'customer' : 'supplier')).map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}</select></Field><Field label="Branch"><select required value={invoiceForm.branchId} onChange={(event) => { const next = branches.find((branch) => String(branch.id) === String(event.target.value)); setInvoiceForm({ ...invoiceForm, branchId: event.target.value, gstinId: next?.gstinId || invoiceForm.gstinId }); }}><option value="">Select branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></Field><Field label="GST registration"><select required value={invoiceForm.gstinId} onChange={(event) => setInvoiceForm({ ...invoiceForm, gstinId: event.target.value })}><option value="">Select GSTIN</option>{gstins.filter((entry) => String(entry.id) === String(branches.find((branch) => String(branch.id) === String(invoiceForm.branchId))?.gstinId)).map((entry) => <option key={entry.id} value={entry.id}>{entry.gstin}</option>)}</select></Field><Field label="Invoice date"><input type="date" required value={invoiceForm.invoiceDate} onChange={(event) => setInvoiceForm({ ...invoiceForm, invoiceDate: event.target.value })} /></Field>{invoiceForm.type === 'purchase' && <Field label="Supplier invoice number" hint="Use the reference on the supplier bill for later 2B matching."><input required maxLength="80" value={invoiceForm.supplierInvoiceNumber} onChange={(event) => setInvoiceForm({ ...invoiceForm, supplierInvoiceNumber: event.target.value })} placeholder="As printed on supplier invoice" /></Field>}<Field label="Notes"><input value={invoiceForm.notes} onChange={(event) => setInvoiceForm({ ...invoiceForm, notes: event.target.value })} placeholder="Optional internal note" /></Field></div><div className="ops-lines-head"><h3>Line items</h3><button type="button" className="ops-link" onClick={addLine}>+ Add line</button></div><div className="ops-line-list">{invoiceForm.lines.map((line, index) => <div className="ops-line" key={index}><Field label="Item"><select required value={line.itemId} onChange={(event) => chooseItem(index, event.target.value)}><option value="">Select item</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.sku}</option>)}</select></Field><Field label="Qty"><input type="number" min="1" step="1" required value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></Field><Field label="Unit price ₹"><input type="number" min="0" step="0.01" required value={line.unitPrice} onChange={(event) => updateLine(index, { unitPrice: event.target.value })} /></Field><Field label="GST %"><input type="number" min="0" max="100" step="0.01" required value={line.gstRate} onChange={(event) => updateLine(index, { gstRate: event.target.value })} /></Field><div className="ops-line-total"><span>Total</span><strong>{money(Math.round(lineTotal(line) * 100))}</strong></div><button type="button" className="ops-remove" disabled={invoiceForm.lines.length === 1} onClick={() => removeLine(index)} title="Remove line">×</button></div>)}</div><div className="ops-estimate"><span>Estimated total incl. tax</span><strong>{money(Math.round(estimatedTotal * 100))}</strong></div><div className="ops-dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setInvoiceOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={busy || !items.length || !parties.length}>Save draft</button></div></form></div>}

    {detail && <div className="ops-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}><div className="ops-dialog wide" role="dialog" aria-modal="true" aria-label="Invoice detail" tabIndex={-1}><div className="ops-dialog-head"><div><p className="ops-eyebrow">{detail.type === 'purchase' ? 'PURCHASE' : 'SALE'} INVOICE</p><h2>{detail.number || `Draft #${detail.id}`}</h2><p className="muted">{detail.partyName || parties.find((party) => String(party.id) === String(detail.partyId))?.name} · {detail.invoiceDate}</p></div><button type="button" className="ops-close" aria-label="Close dialog" onClick={() => setDetail(null)}>×</button></div><div className="ops-detail-meta"><span className={`ops-status ${detail.status}`}>{detail.status}</span><span>{branches.find((branch) => String(branch.id) === String(detail.branchId))?.name || 'Branch'}</span><span>{gstins.find((entry) => String(entry.id) === String(detail.gstinId))?.gstin || 'GSTIN'}</span>{detail.type === 'purchase' && detail.supplierInvoiceNumber && <span>Supplier ref: <strong>{detail.supplierInvoiceNumber}</strong></span>}</div><div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Item</th><th className="numeric">Qty</th><th className="numeric">Unit price</th><th className="numeric">GST</th><th className="numeric">Line total</th></tr></thead><tbody>{(detail.lines || []).map((line, index) => <tr key={line.id || index}><td>{line.itemName || items.find((item) => String(item.id) === String(line.itemId))?.name || line.itemId}</td><td className="numeric">{number(line.quantity)}</td><td className="numeric">{money(line.unitPriceCents)}</td><td className="numeric">{taxLabel(line.gstRateBps)}</td><td className="numeric">{money(line.totalCents ?? Math.round(Number(line.quantity) * Number(line.unitPriceCents) * (1 + Number(line.gstRateBps) / 10000)))}</td></tr>)}</tbody></table></div><div className="ops-detail-totals"><div><span>Subtotal</span><strong>{money(detail.subtotalCents)}</strong></div><div><span>GST</span><strong>{money(detail.taxCents)}</strong></div><div className="grand"><span>Total</span><strong>{money(detail.totalCents)}</strong></div></div>{detail.notes && <p className="ops-notes">{detail.notes}</p>}<div className="ops-dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setDetail(null)}>Close</button><button type="button" className="btn btn-secondary" onClick={() => { setDetail(null); onNavigate?.('invoice-checks', detail.id); }}>Review GST checks</button><button type="button" className="btn btn-secondary" onClick={() => onOpenDocument?.(detail.id)}>Prepare print copy</button>{detail.status === 'draft' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => transition(detail, 'submit')}>Submit for review</button>}{detail.status === 'submitted' && ['accountant', 'admin', 'ca'].includes(String(role).toLowerCase()) && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => transition(detail, 'approve')}>Approve & post</button>}</div></div></div>}
  </div>;
}
