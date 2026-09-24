import { useCallback, useEffect, useMemo, useState } from 'react';
import './supplier-comparison.css';

const money = cents => `₹${(Number(cents || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const unitMoney = cost => cost ? `₹${Number(cost.rupeesPerBaseUnit).toLocaleString('en-IN', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}` : '—';
const today = () => new Date().toISOString().slice(0, 10);
const uniqueReference = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
const initialQuote = () => ({ supplierId: '', quoteDate: today(), validUntil: today(), sourceReference: '', paymentTerms: '', paidPackQuantity: '1', freePackQuantity: '0', unitsPerPackNumerator: '1', unitsPerPackDenominator: '1', priceRupeesPerPack: '', taxPercent: '0', freightRupees: '0', taxTreatment: 'include' });
const toCents = value => Math.round(Number(value) * 100);
const toBps = value => Math.round(Number(value) * 100);

export default function SupplierComparison({ context = {}, refresh, onOpenInvoice }) {
  const [masters, setMasters] = useState({ items: [], suppliers: [] });
  const [comparisons, setComparisons] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [newCase, setNewCase] = useState({ itemId: '', title: '' });
  const [quote, setQuote] = useState(initialQuote);
  const [selection, setSelection] = useState({ selectedQuoteId: '', reason: '' });
  const [review, setReview] = useState({ decision: 'approve', reason: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const company = context.bootstrap?.companies?.find(row => String(row.id) === String(context.companyId));
  const branch = company?.branches?.find(row => String(row.id) === String(context.branchId));
  const gstin = company?.gstins?.find(row => String(row.id) === String(context.gstinId));
  const user = context.bootstrap?.users?.find(row => String(row.id) === String(context.userId));
  const canPrepare = ['staff', 'admin'].includes(user?.role);
  const canReview = ['accountant', 'admin'].includes(user?.role);
  const scoped = useMemo(() => comparisons.filter(row => String(row.branchId) === String(context.branchId) && String(row.gstinId) === String(context.gstinId)), [comparisons, context.branchId, context.gstinId]);
  const current = scoped.find(row => row.id === selectedId) || scoped[0] || null;
  const item = masters.items.find(row => row.id === current?.itemId);
  const request = useCallback(async (path, init = {}) => {
    const response = await context.apiFetch(path, init);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }, [context.apiFetch]);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [masterData, caseData] = await Promise.all([request('/api/supplier-comparisons/masters'), request('/api/supplier-comparisons')]);
      setMasters(masterData); setComparisons(caseData.comparisons || []);
    } catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  }, [request]);
  useEffect(() => { setSelectedId(null); setSelection({ selectedQuoteId: '', reason: '' }); setReview({ decision: 'approve', reason: '' }); setNotice(''); }, [context.companyId, context.gstinId, context.branchId]);
  useEffect(() => { load(); }, [load]);
  const act = async (path, body, success, after) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
      if (after) after(result);
      refresh?.();
      setNotice(success);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const create = event => {
    event.preventDefault();
    act('/api/supplier-comparisons', { gstinId: Number(context.gstinId), branchId: Number(context.branchId), itemId: Number(newCase.itemId), title: newCase.title.trim(), clientReference: uniqueReference('SC') }, 'Comparison created. Add at least two supplier offers.', result => { setSelectedId(result.comparison.id); setNewCase({ itemId: '', title: '' }); });
  };
  const addQuote = event => {
    event.preventDefault();
    act(`/api/supplier-comparisons/${current.id}/quotes`, {
      supplierId: Number(quote.supplierId), quoteDate: quote.quoteDate, validUntil: quote.validUntil, sourceReference: quote.sourceReference.trim(), paymentTerms: quote.paymentTerms.trim(),
      paidPackQuantity: Number(quote.paidPackQuantity), freePackQuantity: Number(quote.freePackQuantity), unitsPerPackNumerator: Number(quote.unitsPerPackNumerator), unitsPerPackDenominator: Number(quote.unitsPerPackDenominator),
      priceCentsPerPack: toCents(quote.priceRupeesPerPack), taxRateBps: toBps(quote.taxPercent), freightCents: toCents(quote.freightRupees), taxTreatment: quote.taxTreatment, clientReference: uniqueReference('SQ'),
    }, 'Offer saved with its cost assumptions.', () => setQuote(initialQuote()));
  };
  const submit = event => {
    event.preventDefault();
    act(`/api/supplier-comparisons/${current.id}/submit`, { selectedQuoteId: Number(selection.selectedQuoteId), reason: selection.reason.trim() }, 'Selection submitted for independent review.');
  };
  const decide = event => {
    event.preventDefault();
    act(`/api/supplier-comparisons/${current.id}/review`, { decision: review.decision, reason: review.reason.trim() }, review.decision === 'approve' ? 'Supplier choice reviewed and recorded.' : 'Comparison rejected with an audit entry.', () => setReview({ decision: 'approve', reason: '' }));
  };
  const updateQuote = key => event => setQuote(old => ({ ...old, [key]: event.target.value }));
  return <main className="supplier-comparison-page">
    <header className="supplier-comparison-hero"><div><span className="supplier-comparison-kicker">PURCHASING / DECISION DESK</span><h1>Supplier comparison</h1><p>Compare written offers on the same item unit, check approved purchase history, and record a reviewed supplier choice.</p></div><button type="button" onClick={load} disabled={loading || busy}>Refresh data</button></header>
    <div className="supplier-comparison-scope"><strong>{company?.name || 'Company'}</strong><span>{gstin?.gstin || 'GSTIN'}</span><span>{branch?.name || 'Branch'}</span><span>{user?.name || 'User'} · {user?.role || 'role'}</span></div>
    <p className="supplier-comparison-boundary"><strong>Comparison only.</strong> Quoted tax is a cost assumption. It does not establish ITC eligibility, create a purchase order, approve a bill, or file GST.</p>
    {error && <div className="supplier-comparison-alert error" role="alert">{error}</div>}{notice && <div className="supplier-comparison-alert success" role="status">{notice}</div>}
    <div className="supplier-comparison-grid"><div className="supplier-comparison-column">
      {canPrepare && <section className="supplier-comparison-card"><div className="supplier-comparison-card-heading"><span>01 / NEW COMPARISON</span><h2>Start with one item</h2></div><form className="supplier-comparison-form" onSubmit={create}><label>Item and base unit<select required value={newCase.itemId} onChange={event => setNewCase(old => ({ ...old, itemId: event.target.value }))}><option value="">Choose item</option>{masters.items.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.sku} · {row.name} / {row.unit}</option>)}</select></label><label>Purpose or requirement<input required maxLength="160" value={newCase.title} onChange={event => setNewCase(old => ({ ...old, title: event.target.value }))} placeholder="e.g. October replenishment" /></label><button disabled={busy || loading}>Create comparison</button></form></section>}
      <section className="supplier-comparison-card"><div className="supplier-comparison-card-heading"><span>02 / BRANCH QUEUE</span><h2>Comparisons <em>{scoped.length}</em></h2></div>{loading ? <p className="supplier-comparison-empty">Loading comparisons…</p> : scoped.length ? <div className="supplier-comparison-list">{scoped.map(row => <button type="button" className={current?.id === row.id ? 'active' : ''} key={row.id} onClick={() => { setSelectedId(row.id); setSelection({ selectedQuoteId: '', reason: '' }); }}><span><strong>{row.title}</strong><small>#{row.id} · {masters.items.find(x => x.id === row.itemId)?.name || `Item #${row.itemId}`} · {row.quotes.length} offers</small></span><b className={`supplier-comparison-status ${row.status}`}>{row.status}</b></button>)}</div> : <p className="supplier-comparison-empty">No comparisons in this branch yet.</p>}</section>
    </div><div className="supplier-comparison-column">
      {!current ? <section className="supplier-comparison-card supplier-comparison-placeholder"><span>DECISION WORKSPACE</span><h2>Select a comparison to begin</h2><p>Supplier offers, source linked purchasing history, and review events will appear here.</p></section> : <>
        <section className="supplier-comparison-card"><div className="supplier-comparison-card-heading"><span>03 / OFFER BOOK · {item?.unit || current.itemUnitSnapshot} BASIS</span><h2>{current.title}<b className={`supplier-comparison-status ${current.status}`}>{current.status}</b></h2></div><p className="supplier-comparison-muted">Item {item?.sku || current.itemId} · branch {branch?.name} · created by user #{current.createdBy}. One comparison holds fixed written terms.</p>
          {current.quotes.length ? <div className="supplier-comparison-offers">{current.quotes.map(row => <article key={row.id} className={current.selectedQuoteId === row.id ? 'selected' : ''}><div className="supplier-comparison-offer-head"><div><small>OFFER #{row.id} · {row.sourceReference}</small><h3>{row.supplierName}</h3></div>{current.selectedQuoteId === row.id && <span className="supplier-comparison-picked">Selected</span>}</div><div className="supplier-comparison-unit"><strong>{unitMoney(row.cost.landedUnitCost)}</strong><span>per {current.itemUnitSnapshot} · {row.taxTreatment === 'include' ? 'quoted tax included' : 'quoted tax excluded'}</span></div><div className="supplier-comparison-facts"><span>{row.paidPackQuantity} paid + {row.freePackQuantity} free packs</span><span>{row.unitsPerPackNumerator}/{row.unitsPerPackDenominator} {current.itemUnitSnapshot} per pack</span><span>Pack {money(row.priceCentsPerPack)}</span><span>Freight {money(row.freightCents)}</span><span>Quoted tax {(row.taxRateBps / 100).toFixed(2)}%</span><span>{row.paymentTerms}</span></div><small className="supplier-comparison-muted">Quote {row.quoteDate} · valid to {row.validUntil} · delivered {row.cost.equivalentBaseUnits.numerator}/{row.cost.equivalentBaseUnits.denominator} {current.itemUnitSnapshot} · total {money(row.cost.landedTotalCents)}</small></article>)}</div> : <p className="supplier-comparison-empty">No offers captured. Add a written supplier offer below.</p>}
        </section>
        {current.status === 'draft' && canPrepare && Number(current.createdBy) === Number(context.userId) && <section className="supplier-comparison-card"><div className="supplier-comparison-card-heading"><span>04 / CAPTURE OFFER</span><h2>Pack and landed cost assumptions</h2></div><form className="supplier-comparison-form" onSubmit={addQuote}><label>Supplier<select required value={quote.supplierId} onChange={updateQuote('supplierId')}><option value="">Choose supplier</option>{masters.suppliers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><div className="supplier-comparison-fields"><label>Quote date<input required type="date" value={quote.quoteDate} onChange={updateQuote('quoteDate')} /></label><label>Valid until<input required type="date" value={quote.validUntil} onChange={updateQuote('validUntil')} /></label></div><div className="supplier-comparison-fields"><label>Paid packs<input required type="number" min="1" step="1" value={quote.paidPackQuantity} onChange={updateQuote('paidPackQuantity')} /></label><label>Free packs<input required type="number" min="0" step="1" value={quote.freePackQuantity} onChange={updateQuote('freePackQuantity')} /></label></div><div className="supplier-comparison-fields"><label>{current.itemUnitSnapshot} per pack · numerator<input required type="number" min="1" step="1" value={quote.unitsPerPackNumerator} onChange={updateQuote('unitsPerPackNumerator')} /></label><label>Denominator<input required type="number" min="1" step="1" value={quote.unitsPerPackDenominator} onChange={updateQuote('unitsPerPackDenominator')} /></label></div><div className="supplier-comparison-fields"><label>Price per paid pack (₹)<input required type="number" min="0.01" step="0.01" value={quote.priceRupeesPerPack} onChange={updateQuote('priceRupeesPerPack')} /></label><label>Freight total (₹)<input required type="number" min="0" step="0.01" value={quote.freightRupees} onChange={updateQuote('freightRupees')} /></label></div><div className="supplier-comparison-fields"><label>Quoted GST (%)<input required type="number" min="0" max="100" step="0.01" value={quote.taxPercent} onChange={updateQuote('taxPercent')} /></label><label>Cost comparison treatment<select value={quote.taxTreatment} onChange={updateQuote('taxTreatment')}><option value="include">Include quoted tax</option><option value="exclude">Exclude quoted tax</option></select></label></div><label>Supplier document reference<input required maxLength="160" value={quote.sourceReference} onChange={updateQuote('sourceReference')} placeholder="Written offer or quotation number" /></label><label>Payment and delivery terms<input required maxLength="160" value={quote.paymentTerms} onChange={updateQuote('paymentTerms')} placeholder="e.g. 30 days, delivery in 7 days" /></label><button disabled={busy}>Save offer</button></form></section>}
        {current.status === 'draft' && canPrepare && Number(current.createdBy) === Number(context.userId) && <section className="supplier-comparison-card"><div className="supplier-comparison-card-heading"><span>05 / BUYER CHOICE</span><h2>Nominate a supplier</h2></div><form className="supplier-comparison-form" onSubmit={submit}><label>Chosen offer<select required value={selection.selectedQuoteId} onChange={event => setSelection(old => ({ ...old, selectedQuoteId: event.target.value }))}><option value="">Choose offer</option>{current.quotes.map(row => <option key={row.id} value={row.id}>{row.supplierName} · {unitMoney(row.cost.landedUnitCost)} / {current.itemUnitSnapshot}</option>)}</select></label><label>Selection reason<textarea required maxLength="500" rows="3" value={selection.reason} onChange={event => setSelection(old => ({ ...old, reason: event.target.value }))} placeholder="Cost, terms, delivery and any tradeoffs" /></label><button disabled={busy || new Set(current.quotes.map(row => row.supplierId)).size < 2}>Submit for independent review</button><small>At least two different suppliers are required.</small></form></section>}
        {current.status === 'submitted' && canReview && Number(current.createdBy) !== Number(context.userId) && <section className="supplier-comparison-card"><div className="supplier-comparison-card-heading"><span>06 / INDEPENDENT REVIEW</span><h2>Review selection</h2></div>{current.historyChangedSinceSubmit && <p className="supplier-comparison-alert error">Approved purchase history changed after submission. A new comparison is needed for approval.</p>}<p className="supplier-comparison-muted">Buyer reason: {current.selectionReason}</p><form className="supplier-comparison-form" onSubmit={decide}><label>Decision<select value={review.decision} onChange={event => setReview(old => ({ ...old, decision: event.target.value }))}><option value="approve">Approve chosen supplier</option><option value="reject">Reject comparison</option></select></label><label>Review reason<textarea required maxLength="500" rows="3" value={review.reason} onChange={event => setReview(old => ({ ...old, reason: event.target.value }))} /></label><button disabled={busy || (review.decision === 'approve' && current.historyChangedSinceSubmit)}>Record review</button></form></section>}
        {current.status === 'submitted' && Number(current.createdBy) === Number(context.userId) && <p className="supplier-comparison-waiting">Awaiting an independent accountant or admin review.</p>}
        {['approved', 'rejected'].includes(current.status) && <p className="supplier-comparison-waiting">Reviewed by user #{current.reviewedBy}: {current.reviewReason}. This decision is an internal purchasing record only.</p>}
        <section className="supplier-comparison-card"><div className="supplier-comparison-card-heading"><span>07 / SOURCE EVIDENCE</span><h2>Approved purchase history</h2></div><p className="supplier-comparison-muted">Same item and branch. Invoice quantities already use the item base unit. These bills have no captured freight allocation, so the comparison shows both excluding and including their recorded tax.</p>{current.purchaseHistory.length ? <div className="supplier-comparison-table-scroll"><table><thead><tr><th>Approved bill</th><th>Supplier</th><th>Qty</th><th>Excl. tax / {current.itemUnitSnapshot}</th><th>Incl. tax / {current.itemUnitSnapshot}</th></tr></thead><tbody>{current.purchaseHistory.map(row => <tr key={row.invoiceLineId}><td><strong>{row.invoiceNumber}</strong><small>Supplier ref {row.supplierInvoiceNumber || '—'} · {row.invoiceDate}</small><small>Invoice #{row.invoiceId} · line #{row.invoiceLineId}</small>{onOpenInvoice && <button type="button" className="supplier-comparison-source-link" onClick={() => onOpenInvoice(row.invoiceId)}>Open source invoice ↗</button>}</td><td>{row.supplierName}</td><td>{row.quantityBaseUnits}</td><td>{unitMoney(row.unitCostExcludingTax)}</td><td>{unitMoney(row.unitCostIncludingTax)}</td></tr>)}</tbody></table></div> : <p className="supplier-comparison-empty">No approved purchase bills for this item in this branch.</p>}</section>
        <details className="supplier-comparison-card supplier-comparison-audit"><summary>Audit trail · {current.events.length} events</summary><ol>{current.events.map(row => <li key={row.id}><strong>{row.action.replaceAll('_', ' ')}</strong><span>User #{row.actorId} · {row.createdAt}</span></li>)}</ol></details>
      </>}
    </div></div>
  </main>;
}
