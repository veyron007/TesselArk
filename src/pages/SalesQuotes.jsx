import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './sales-quotes.css';

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const money = (cents) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format((Number(cents) || 0) / 100);
const blankLine = () => ({ itemId: '', quantity: '1', unitPrice: '' });
const blankForm = () => ({ number: '', partyId: '', quoteDate: today(), expiryDate: inDays(30), notes: '', lines: [blankLine()] });

export default function SalesQuotes({ context, refresh, onOpenOrder }) {
  const [quotes, setQuotes] = useState([]);
  const [items, setItems] = useState([]);
  const [parties, setParties] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [reviewReason, setReviewReason] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const scopeKey = `${context.companyId}:${context.gstinId}:${context.branchId}:${context.userId}`;
  const requestId = useRef(0);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const role = context.role || context.bootstrap?.users?.find((user) => String(user.id) === String(context.userId))?.role;
  const canReview = role === 'accountant' || role === 'admin';
  const selected = quotes.find((quote) => quote.id === selectedId) || null;
  const customers = useMemo(() => parties.filter((party) => party.type === 'customer' || party.type === 'both'), [parties]);

  const api = useCallback(async (path, init = {}) => {
    const response = await context.apiFetch(path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  }, [context.apiFetch]);

  const load = useCallback(async () => {
    const sequence = ++requestId.current;
    const startedIn = scopeKey;
    setLoading(true);
    setError('');
    try {
      const scope = new URLSearchParams({ gstinId: String(context.gstinId), branchId: String(context.branchId) });
      const [quoteResult, itemResult, partyResult] = await Promise.all([
        api(`/api/quotes?${scope}`), api('/api/items'), api('/api/parties'),
      ]);
      if (sequence !== requestId.current || currentScope.current !== startedIn) return;
      setQuotes(quoteResult.quotes || []);
      setItems(itemResult.items || []);
      setParties(partyResult.parties || []);
    } catch (cause) {
      if (sequence === requestId.current && currentScope.current === startedIn) setError(cause.message);
    } finally {
      if (sequence === requestId.current && currentScope.current === startedIn) setLoading(false);
    }
  }, [api, context.gstinId, context.branchId, scopeKey]);

  useEffect(() => { setSelectedId(null); setEditingId(null); setForm(blankForm()); setReviewReason(''); setOrderNumber(''); load(); }, [load]);

  const mutate = async (action, message, after) => {
    const startedIn = scopeKey;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action();
      if (currentScope.current !== startedIn) return;
      await load();
      if (currentScope.current !== startedIn) return;
      setNotice(message);
      after?.(result);
      refresh?.();
    } catch (cause) {
      if (currentScope.current === startedIn) setError(cause.message);
    } finally {
      if (currentScope.current === startedIn) setBusy(false);
    }
  };

  const create = (event) => {
    event.preventDefault();
    if (form.expiryDate < form.quoteDate) { setError('Expiry must be on or after the quote date.'); return; }
    const body = {
      number: form.number.trim(), quoteDate: form.quoteDate, expiryDate: form.expiryDate,
      partyId: Number(form.partyId), gstinId: Number(context.gstinId), branchId: Number(context.branchId),
      notes: form.notes.trim(),
      lines: form.lines.map((line) => ({ itemId: Number(line.itemId), quantity: Number(line.quantity), unitPriceCents: Math.round(Number(line.unitPrice) * 100) })),
    };
    mutate(() => api(editingId ? `/api/quotes/${editingId}` : '/api/quotes', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(body) }), editingId ? 'Draft quotation updated.' : 'Quotation saved as a draft.', (result) => {
      setSelectedId(result.quote.id);
      setEditingId(null);
      setForm(blankForm());
    });
  };
  const edit = () => {
    setEditingId(selected.id);
    setForm({
      number: selected.number, partyId: String(selected.partyId), quoteDate: selected.quoteDate,
      expiryDate: selected.expiryDate, notes: selected.notes || '',
      lines: selected.lines.map((line) => ({ itemId: String(line.itemId), quantity: String(line.quantity), unitPrice: String(line.unitPriceCents / 100) })),
    });
    setSelectedId(null);
  };
  const action = (kind, body = {}, message) => mutate(
    () => api(`/api/quotes/${selected.id}/${kind}`, { method: 'POST', body: JSON.stringify(body) }),
    message,
    (result) => { if (kind === 'convert' && result.order) onOpenOrder?.(result.order.id); },
  );
  const review = (kind) => {
    if (kind === 'reject' && !reviewReason.trim()) { setError('Add a reason before rejecting this quotation.'); return; }
    action(kind, { reviewReason: reviewReason.trim() }, kind === 'approve' ? 'Quotation approved for conversion.' : 'Quotation returned with a review reason.');
  };
  const convert = (event) => {
    event.preventDefault();
    action('convert', { orderNumber: orderNumber.trim(), orderDate: today() }, 'Draft sales order created from the approved quotation.');
  };

  return <div className="sales-quotes">
    <div className="quote-explainer"><strong>Sales quotations</strong><span>Share a proposed price and quantity, obtain an independent decision, then create a draft sales order. A quotation does not reserve stock or post tax.</span></div>
    {error && <div className="quote-message error" role="alert">{error}</div>}
    {notice && <div className="quote-message success" role="status">{notice}</div>}
    <div className="quote-layout">
      <section className="quote-card quote-register" aria-label="Quotation register">
        <div className="quote-card-head"><div><span className="quote-eyebrow">CURRENT BRANCH</span><h2>Quotation register</h2></div><span>{quotes.length} records</span></div>
        {loading ? <p className="quote-empty">Loading quotations…</p> : !quotes.length ? <p className="quote-empty">No quotations yet for this branch. Prepare one using the form.</p> : <div className="quote-list">
          {quotes.map((quote) => <button key={quote.id} type="button" className={`quote-row ${selectedId === quote.id ? 'selected' : ''}`} onClick={() => { setSelectedId(quote.id); setEditingId(null); setReviewReason(''); setOrderNumber(''); }}>
            <span><strong>{quote.number}</strong><small>{quote.partyNameSnapshot} · {quote.quoteDate}</small></span>
            <span className="quote-row-end"><span className={`quote-status ${quote.status}`}>{quote.status}</span><b>{money(quote.totalCents)}</b></span>
          </button>)}
        </div>}
      </section>
      <section className="quote-card quote-work" aria-label={selected ? 'Quotation detail' : 'New quotation'}>
        <div className="quote-card-head"><div><span className="quote-eyebrow">{selected ? 'REVIEW & CONVERT' : 'PREPARE'}</span><h2>{selected ? selected.number : editingId ? `Edit ${form.number}` : 'New sales quotation'}</h2></div>{(selected || editingId) && <button type="button" className="quote-quiet" onClick={() => { setSelectedId(null); setEditingId(null); setForm(blankForm()); }}>New quotation</button>}</div>
        {selected ? <div className="quote-detail">
          <div className="quote-detail-meta"><span>{selected.partyNameSnapshot}</span><span className={`quote-status ${selected.status}`}>{selected.status}</span></div>
          <div className="quote-dates"><div><small>QUOTED</small><strong>{selected.quoteDate}</strong></div><div><small>VALID UNTIL</small><strong>{selected.expiryDate}</strong></div></div>
          <div className="quote-lines"><div className="quote-line-header"><span>Item</span><span>Qty · price</span><span>Amount</span></div>{(selected.lines || []).map((line) => <div className="quote-line" key={line.id}><span><strong>{line.itemNameSnapshot}</strong><small>{Number(line.gstRateBps || 0) / 100}% entered GST rate</small></span><span>{line.quantity} × {money(line.unitPriceCents)}</span><strong>{money(line.subtotalCents)}</strong></div>)}</div>
          <div className="quote-totals"><span>Subtotal <strong>{money(selected.subtotalCents)}</strong></span><span>Entered tax estimate <strong>{money(selected.taxCents)}</strong></span><span>Total estimate <strong>{money(selected.totalCents)}</strong></span></div>
          {selected.notes && <p className="quote-note">{selected.notes}</p>}
          {selected.reviewReason && <p className="quote-review-note"><strong>Review note</strong>{selected.reviewReason}</p>}
          {selected.status === 'draft' && <div className="quote-draft-actions"><button type="button" className="quote-primary" disabled={busy} onClick={() => action('submit', {}, 'Quotation submitted for independent review.')}>{busy ? 'Working…' : 'Submit for review'}</button>{String(selected.createdBy) === String(context.userId) && <button type="button" className="quote-secondary" disabled={busy} onClick={edit}>Edit draft</button>}</div>}
          {selected.status === 'submitted' && canReview && String(selected.createdBy) !== String(context.userId) && String(selected.submittedBy) !== String(context.userId) && <div className="quote-review"><label>Decision note<textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} maxLength="1000" rows="3" placeholder="State the commercial basis or reason for return" /></label><div><button type="button" className="quote-primary" disabled={busy} onClick={() => review('approve')}>Approve quotation</button><button type="button" className="quote-secondary" disabled={busy} onClick={() => review('reject')}>Reject with reason</button></div></div>}
          {selected.status === 'submitted' && (!canReview || String(selected.createdBy) === String(context.userId) || String(selected.submittedBy) === String(context.userId)) && <p className="quote-hint">Awaiting an independent accountant or admin decision.</p>}
          {selected.status === 'approved' && <form className="quote-convert" onSubmit={convert}><label>Sales order number<input value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} required maxLength="60" placeholder="SO-2026-001" /></label><button className="quote-primary" type="submit" disabled={busy || today() > selected.expiryDate}>Create draft sales order</button>{today() > selected.expiryDate && <span className="quote-hint">This quotation has expired and cannot be converted.</span>}</form>}
          {selected.status === 'converted' && <button type="button" className="quote-secondary" onClick={() => onOpenOrder?.(selected.convertedOrderId)}>Open linked sales order ↗</button>}
          {selected.events?.length > 0 && <div className="quote-history"><h3>Decision trail</h3>{selected.events.map((event) => <div key={event.id}><span>{event.action?.replaceAll('_', ' ')}</span><small>{event.createdAt}</small></div>)}</div>}
        </div> : <form className="quote-form" onSubmit={create}>
          <div className="quote-form-grid"><label>Quote number<input required maxLength="60" value={form.number} onChange={(event) => setForm((current) => ({ ...current, number: event.target.value }))} placeholder="QT-2026-001" /></label><label>Customer<select required value={form.partyId} onChange={(event) => setForm((current) => ({ ...current, partyId: event.target.value }))}><option value="">Choose customer</option>{customers.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label><label>Quote date<input type="date" required value={form.quoteDate} onChange={(event) => setForm((current) => ({ ...current, quoteDate: event.target.value }))} /></label><label>Valid until<input type="date" required min={form.quoteDate} value={form.expiryDate} onChange={(event) => setForm((current) => ({ ...current, expiryDate: event.target.value }))} /></label></div>
          <div className="quote-section-title">Priced lines</div>
          <div className="quote-form-lines">{form.lines.map((line, index) => <div className="quote-form-line" key={index}><label>Item<select required value={line.itemId} onChange={(event) => setForm((current) => ({ ...current, lines: current.lines.map((entry, at) => at === index ? { ...entry, itemId: event.target.value } : entry) }))}><option value="">Choose item</option>{items.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></label><label>Quantity<input required type="number" min="1" step="1" value={line.quantity} onChange={(event) => setForm((current) => ({ ...current, lines: current.lines.map((entry, at) => at === index ? { ...entry, quantity: event.target.value } : entry) }))} /></label><label>Unit price ₹<input required type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => setForm((current) => ({ ...current, lines: current.lines.map((entry, at) => at === index ? { ...entry, unitPrice: event.target.value } : entry) }))} /></label><button type="button" aria-label={`Remove line ${index + 1}`} disabled={form.lines.length === 1} onClick={() => setForm((current) => ({ ...current, lines: current.lines.filter((_, at) => at !== index) }))}>×</button></div>)}</div>
          <button type="button" className="quote-quiet" onClick={() => setForm((current) => ({ ...current, lines: [...current.lines, blankLine()] }))}>+ Add another line</button>
          <label className="quote-notes">Commercial notes<textarea rows="3" maxLength="1000" value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Delivery, price or approval conditions" /></label>
          <button type="submit" className="quote-primary" disabled={busy || loading}>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Save draft quotation'}</button>
        </form>}
      </section>
    </div>
  </div>;
}
