import { useEffect, useMemo, useState } from 'react';
import './gst.css';

const money = (value) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2,
}).format(Number(value || 0));

const label = (value) => String(value ?? '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

function readList(data) {
  if (Array.isArray(data)) return data;
  return data?.periods ?? data?.items ?? data?.data?.periods ?? data?.data ?? [];
}

function readDetail(data) {
  return data?.period ?? data?.summary ?? data?.data ?? data ?? {};
}

function readAmount(source, ...keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return Number(source[key]) || 0;
  }
  return 0;
}

function periodName(period) {
  if (period?.label) return period.label;
  if (period?.name) return period.name;
  if (period?.month && period?.year) return `${period.month} ${period.year}`;
  if (/^\d{4}-\d{2}$/.test(String(period?.period ?? ''))) {
    const [year, month] = period.period.split('-').map(Number);
    return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
  }
  return period?.period ?? period?.id ?? 'Period';
}

function periodId(period) {
  return period?.id ?? period?.periodId ?? period?.period;
}

function periodMetrics(detail) {
  if (detail?.salesTaxableCents !== undefined) return {
    taxableSales: detail.salesTaxableCents / 100,
    taxablePurchases: detail.purchaseTaxableCents / 100,
    output: detail.salesTaxCents / 100,
    input: detail.purchaseTaxCents / 100,
    eligible: (detail.eligibleItcCents ?? 0) / 100,
    payable: (detail.payableEstimateCents ?? Math.max(0, detail.salesTaxCents - (detail.eligibleItcCents ?? 0))) / 100,
    surplus: (detail.surplusReviewedCreditCents ?? Math.max(0, (detail.eligibleItcCents ?? 0) - detail.salesTaxCents)) / 100,
  };
  const sales = detail?.sales ?? detail?.outward ?? {};
  const purchases = detail?.purchases ?? detail?.inward ?? {};
  const tax = detail?.tax ?? detail?.totals ?? detail;
  const taxableSales = readAmount(detail, 'taxableSales', 'taxable_sales') || readAmount(sales, 'taxableValue', 'taxable_value', 'taxable');
  const taxablePurchases = readAmount(detail, 'taxablePurchases', 'taxable_purchases') || readAmount(purchases, 'taxableValue', 'taxable_value', 'taxable');
  const output = readAmount(detail, 'outputTax', 'output_tax') || readAmount(tax, 'outputTax', 'output_tax', 'output');
  const input = readAmount(detail, 'inputTax', 'input_tax', 'eligibleItc', 'eligible_itc') || readAmount(tax, 'inputTax', 'input_tax', 'eligibleItc', 'eligible_itc', 'input');
  return { taxableSales, taxablePurchases, output, input, eligible: 0, payable: Math.max(0, output), surplus: 0 };
}

function getTransactions(detail) {
  const direct = detail?.transactions ?? detail?.documents ?? detail?.entries;
  if (Array.isArray(direct)) return direct;
  const sales = detail?.sales?.transactions ?? detail?.sales?.invoices ?? detail?.outward?.transactions ?? [];
  const purchases = detail?.purchases?.transactions ?? detail?.purchases?.bills ?? detail?.inward?.transactions ?? [];
  return [
    ...sales.map((item) => ({ ...item, direction: 'Sale' })),
    ...purchases.map((item) => ({ ...item, direction: 'Purchase' })),
  ];
}

function reviewInfo(detail) {
  return detail?.review ?? detail?.reviewRecord ?? {};
}

export default function Gst({ context = {}, refresh = 0, onNavigate }) {
  const { companyId, gstinId, branchId, userId, role, apiFetch } = context;
  const [periods, setPeriods] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [notes, setNotes] = useState('');
  const [direction, setDirection] = useState('all');
  const [transaction, setTransaction] = useState(null);
  const [transactionLoading, setTransactionLoading] = useState(false);
  const [evidence, setEvidence] = useState([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  const [evidenceBusyId, setEvidenceBusyId] = useState(null);
  const [decisionReasons, setDecisionReasons] = useState({});
  const [returnTaxPreview, setReturnTaxPreview] = useState(null);
  const [returnTaxLoading, setReturnTaxLoading] = useState(false);
  const [returnTaxError, setReturnTaxError] = useState('');

  const request = async (path, options = {}) => {
    const response = await (apiFetch
      ? apiFetch(path, options)
      : fetch(path, { ...options, headers: { 'x-company-id': companyId, 'x-user-id': userId, ...options.headers } }));
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || failure.message || `Request failed (${response.status})`);
    }
    return response.json();
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setPeriods([]);
    setDetail(null);
    setSelectedId(null);
    if (!companyId) { setLoading(false); return undefined; }
    const params = new URLSearchParams();
    if (gstinId) params.set('gstinId', gstinId);
    if (branchId) params.set('branchId', branchId);
    request(`/api/gst/periods${params.size ? `?${params}` : ''}`)
      .then((result) => {
        if (!active) return;
        const list = readList(result);
        setPeriods(list);
        setSelectedId((current) => list.some((period) => String(periodId(period)) === String(current)) ? current : periodId(list[0]) ?? null);
      })
      .catch((cause) => { if (active) setError(cause.message || 'Could not load GST periods.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId, gstinId, branchId, userId, refresh]);

  useEffect(() => {
    if (!selectedId || !companyId) return undefined;
    let active = true;
    setDetailLoading(true);
    setDetail(null);
    setError('');
    setTransaction(null);
    const params = new URLSearchParams();
    if (gstinId) params.set('gstinId', gstinId);
    if (branchId) params.set('branchId', branchId);
    request(`/api/gst/periods/${encodeURIComponent(selectedId)}${params.size ? `?${params}` : ''}`)
      .then((result) => { if (active) setDetail(readDetail(result)); })
      .catch((cause) => { if (active) setError(cause.message || 'Could not load period details.'); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId, companyId, gstinId, branchId, userId, refresh]);

  const selected = periods.find((period) => String(periodId(period)) === String(selectedId));
  const selectedPeriod = detail?.period ?? selected?.period;
  const selectedGstinId = detail?.gstinId ?? selected?.gstinId ?? gstinId;

  useEffect(() => {
    if (!selectedPeriod || !selectedGstinId) { setReturnTaxPreview(null); return undefined; }
    let active = true;
    setReturnTaxLoading(true);
    setReturnTaxPreview(null);
    setReturnTaxError('');
    const params = new URLSearchParams({ gstinId: String(selectedGstinId), period: String(selectedPeriod) });
    request(`/api/return-tax/preview?${params}`)
      .then((result) => { if (active) setReturnTaxPreview(result.preview ?? result); })
      .catch((cause) => { if (active) setReturnTaxError(cause.message || 'Could not load return note arithmetic.'); })
      .finally(() => { if (active) setReturnTaxLoading(false); });
    return () => { active = false; };
  }, [selectedPeriod, selectedGstinId, companyId, userId, refresh]);

  useEffect(() => {
    if (!selectedId || !selectedPeriod || !selectedGstinId) { setEvidence([]); return undefined; }
    let active = true;
    setEvidenceLoading(true);
    setEvidenceError('');
    setEvidence([]);
    const params = new URLSearchParams({ gstinId: String(selectedGstinId), period: String(selectedPeriod) });
    request(`/api/gst/purchase-evidence?${params}`)
      .then((result) => { if (active) setEvidence(result.evidence ?? []); })
      .catch((cause) => { if (active) setEvidenceError(cause.message || 'Could not load purchase evidence.'); })
      .finally(() => { if (active) setEvidenceLoading(false); });
    return () => { active = false; };
  }, [selectedId, selectedPeriod, selectedGstinId, companyId, userId, refresh]);

  const data = detail ?? selected ?? {};
  const metrics = periodMetrics(data);
  const review = reviewInfo(data);
  const status = data.reviewStatus ?? data.review_status ?? review.status ?? data.status ?? 'draft';
  const reviewer = review.reviewerName ?? review.reviewedBy ?? data.reviewedBy;
  const transactions = getTransactions(data);
  const visibleTransactions = useMemo(() => transactions.filter((item) => {
    const kind = String(item.direction ?? item.type ?? item.kind ?? '').toLowerCase();
    return direction === 'all' || (direction === 'sales' ? /sale|outward|invoice/.test(kind) : /purchase|inward|bill/.test(kind));
  }), [transactions, direction]);
  const canReview = /accountant|ca|admin|owner/i.test(String(role ?? ''));
  const isApproved = String(status).toLowerCase() === 'approved';
  const isReviewed = String(status).toLowerCase() === 'reviewed';
  const pendingEvidence = evidence.filter((item) => item.eligibilityStatus === 'pending');

  async function refreshPeriodPreview() {
    const latest = await request(`/api/gst/periods/${encodeURIComponent(selectedId)}`);
    const updated = readDetail(latest);
    setDetail(updated);
    setPeriods((current) => current.map((period) => String(periodId(period)) === String(selectedId) ? { ...period, ...updated } : period));
  }

  async function decideEvidence(item, action, decision) {
    setEvidenceBusyId(item.invoiceId);
    setEvidenceError('');
    setNotice('');
    try {
      const reason = decisionReasons[item.invoiceId]?.trim() ?? '';
      const options = action === 'match' ? { method: 'POST' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, reason }),
      };
      const result = await request(`/api/gst/purchase-evidence/${encodeURIComponent(item.invoiceId)}/${action}`, options);
      const updated = result.evidence ?? result;
      setEvidence((current) => current.map((entry) => entry.invoiceId === item.invoiceId ? updated : entry));
      await refreshPeriodPreview();
      setNotice(action === 'match' ? 'Local fixture comparison recorded.' : `Purchase credit marked ${decision} for this local review.`);
    } catch (cause) {
      setEvidenceError(cause.message || 'Could not update purchase evidence.');
    } finally {
      setEvidenceBusyId(null);
    }
  }

  async function recordReview(action) {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request(`/api/gst/periods/${encodeURIComponent(selectedId)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: notes.trim(), gstinId, branchId }),
      });
      if (result?.period || result?.summary || result?.data) {
        const updated = readDetail(result);
        setDetail(updated);
        setPeriods((current) => current.map((period) => String(periodId(period)) === String(selectedId) ? { ...period, ...updated } : period));
      }
      else {
        const latest = await request(`/api/gst/periods/${encodeURIComponent(selectedId)}`);
        setDetail(readDetail(latest));
      }
      setNotice(action === 'approve' ? 'Internal period approval recorded.' : 'Internal review recorded.');
      setNotes('');
    } catch (cause) {
      setError(cause.message || 'Could not record review.');
    } finally {
      setBusy(false);
    }
  }

  async function openTransaction(id) {
    if (!id) return;
    if (transaction?.id === id) { setTransaction(null); return; }
    setTransactionLoading(true);
    setError('');
    try {
      const result = await request(`/api/invoices/${encodeURIComponent(id)}`);
      setTransaction(result.invoice ?? result);
    } catch (cause) {
      setError(cause.message || 'Could not load transaction.');
    } finally {
      setTransactionLoading(false);
    }
  }

  return <div className="gst-page">
    <header className="gst-header"><div><p className="gst-eyebrow">TAX CONTROL / LOCAL PREVIEW</p><h1>GST workspace</h1><p className="gst-muted">Review recorded tax, supplier evidence, and internal period decisions for this GSTIN.</p></div></header>
    <div className="gst-local-notice" role="note"><span className="gst-mode-dot" /> Local GST preview only. No portal connection, filing, or government acknowledgement.</div>
    {error && <div className="gst-alert gst-error" role="alert">{error}</div>}
    {notice && <div className="gst-alert gst-success" role="status">{notice}</div>}

    <div className="gst-layout">
      <aside className="gst-periods gst-panel">
        <h2>Periods</h2>
        {loading ? <p className="gst-muted">Loading periods…</p> : periods.length === 0 ? <p className="gst-muted">No GST periods for this company yet. Record a sale or purchase to begin.</p> : (
          <div className="gst-period-list">{periods.map((period) => <button key={periodId(period)} type="button" className={`gst-period ${String(periodId(period)) === String(selectedId) ? 'active' : ''}`} onClick={() => { setSelectedId(periodId(period)); setNotes(''); setNotice(''); }}>
            <span>{periodName(period)}</span><small>{label(period.reviewStatus ?? period.status ?? 'draft')}</small>
          </button>)}</div>
        )}
      </aside>

      <div className="gst-main">
        {!selectedId ? <section className="gst-panel gst-empty"><h2>Select a period</h2><p className="gst-muted">GST summaries appear after transactions are recorded.</p></section> : detailLoading ? <section className="gst-panel gst-empty">Loading period summary…</section> : <>
          <section className="gst-panel gst-period-heading">
            <div><p className="gst-eyebrow">Selected period</p><h2>{periodName(data) === 'Period' ? periodName(selected) : periodName(data)}</h2><p className="gst-muted">{data.gstin ?? selected?.gstin ?? 'Selected company GSTIN'} · all branches under this GSTIN</p></div>
            <span className={`gst-status gst-status-${String(status).toLowerCase().replace(/[^a-z]/g, '')}`}>{label(status)}</span>
          </section>

          <section className="gst-metrics" aria-label="GST period totals">
            <div className="gst-metric"><small>Taxable sales</small><strong>{money(metrics.taxableSales)}</strong></div>
            <div className="gst-metric"><small>Taxable purchases</small><strong>{money(metrics.taxablePurchases)}</strong></div>
            <div className="gst-metric"><small>Output tax</small><strong>{money(metrics.output)}</strong></div>
            <div className="gst-metric"><small>Purchase GST · before ITC review</small><strong>{money(metrics.input)}</strong></div>
            <div className="gst-metric"><small>Reviewed eligible ITC · claim period</small><strong>{money(metrics.eligible)}</strong></div>
            <div className="gst-metric gst-net"><small>Indicative payable · local estimate</small><strong>{money(metrics.payable)}</strong></div>
            <div className="gst-metric gst-surplus"><small>Surplus reviewed credit · not a refund</small><strong>{money(metrics.surplus)}</strong></div>
          </section>
          <p className="gst-period-basis">Sales and purchase totals follow the books invoice period. Reviewed eligible ITC follows its separately recorded local claim period. Estimates do not model tax-head use or statutory adjustments.</p>

          <section className="gst-panel gst-return-tax" aria-label="Separate return note arithmetic">
            <div className="gst-section-heading"><div><p className="gst-eyebrow">Separate local review</p><h2>Return note arithmetic</h2><p className="gst-muted">Credit and debit notes remain outside the approved GST period totals above. This is an indicative local adjustment view, not a filed return.</p></div>{onNavigate && <button type="button" className="gst-button secondary" onClick={() => onNavigate('return-tax')}>Open return tax review →</button>}</div>
            {returnTaxLoading ? <p className="gst-muted">Loading return notes…</p> : returnTaxError ? <p className="gst-muted" role="alert">{returnTaxError}</p> : <div className="gst-return-tax-grid"><div><small>Sales credit note tax</small><strong>{money((returnTaxPreview?.salesCreditTaxCents ?? 0) / 100)}</strong></div><div><small>Purchase debit note tax</small><strong>{money((returnTaxPreview?.purchaseDebitTaxCents ?? 0) / 100)}</strong></div><div><small>Indicative net adjustment</small><strong>{money((returnTaxPreview?.indicativeNetAdjustmentCents ?? 0) / 100)}</strong></div><span>{returnTaxPreview?.documentCount ?? 0} local note{Number(returnTaxPreview?.documentCount ?? 0) === 1 ? '' : 's'}</span></div>}
          </section>

          <section className="gst-panel gst-evidence">
            <div className="gst-section-heading"><div><p className="gst-eyebrow">Inward tax control</p><h2>Purchase evidence review</h2><p className="gst-muted">Compare approved purchase bills with local supplier-statement rows. A match alone does not establish ITC eligibility.</p></div>{onNavigate && <button type="button" className="gst-button secondary" onClick={() => onNavigate('statement-import')}>Import local statement →</button>}<span className="gst-evidence-count">{pendingEvidence.length} pending</span></div>
            <div className="gst-fixture-note">Seeded statement rows are synthetic. Imported rows are local, user-provided evidence; neither indicates GST portal access, a verified GSTR-2B, or government verification.</div>
            {evidenceError && <div className="gst-alert gst-error" role="alert">{evidenceError}</div>}
            {evidenceLoading ? <p className="gst-muted">Loading purchase evidence…</p> : evidence.length === 0 ? <p className="gst-muted">No approved purchase bills for this GSTIN and period.</p> : <div className="gst-evidence-list">{evidence.map((item) => {
              const working = evidenceBusyId === item.invoiceId;
              const canDecide = canReview && !isApproved && !isReviewed;
              const matchStatus = item.matchStatus ?? 'unmatched';
              const eligibilityStatus = item.eligibilityStatus ?? 'pending';
              const source = item.source ?? item.candidateSource;
              return <article className="gst-evidence-row" key={item.invoiceId}>
                <div className="gst-evidence-top"><div><strong>{item.number}</strong><span>{item.partyName} · {item.invoiceDate}</span><small>Supplier bill ref: {item.supplierInvoiceNumber || 'not recorded'} · GSTIN: {item.supplierGstin || 'not recorded'}</small></div><div className="gst-evidence-taxes"><small>Purchase GST</small><strong>{money(item.taxCents / 100)}</strong></div></div>
                <div className="gst-period-line"><span>Books invoice period: <strong>{item.period ?? '—'}</strong></span><span>Statement period: <strong>{source?.sourcePeriod ?? 'not evidenced'}</strong></span><span>Local claim period: <strong>{item.claimPeriod ?? 'not assigned'}</strong></span></div>
                <div className="gst-evidence-comparison"><div><span>Books</span><strong>{money(item.subtotalCents / 100)} taxable · {money(item.taxCents / 100)} GST</strong></div><div><span>{item.source ? 'Linked local statement row' : 'Candidate local statement row'}</span>{source ? <><strong>{source.invoiceNumber} · {money(source.taxableCents / 100)} taxable · {money(source.taxCents / 100)} GST</strong><small>{source.sourceName} · {source.sourcePeriod} · imported {source.importedAt ? new Date(source.importedAt).toLocaleDateString('en-IN') : 'date unavailable'} · row {source.fixtureId}</small></> : <strong>No local statement row found</strong>}</div></div>
                <div className="gst-evidence-footer"><div className="gst-evidence-statuses"><span className={`gst-chip gst-chip-${matchStatus}`}>Match: {label(matchStatus)}</span><span className={`gst-chip gst-chip-${eligibilityStatus}`}>Credit: {label(eligibilityStatus)}</span>{item.reviewReason && <span className="gst-evidence-reason">Reason: {item.reviewReason}</span>}</div>
                  {canDecide && <div className="gst-evidence-actions"><button type="button" className="gst-button secondary" disabled={working || matchStatus === 'matched'} onClick={() => decideEvidence(item, 'match')}>{working ? 'Saving…' : 'Check statement match'}</button><input aria-label={`Credit decision reason for ${item.number}`} value={decisionReasons[item.invoiceId] ?? ''} onChange={(event) => setDecisionReasons((current) => ({ ...current, [item.invoiceId]: event.target.value }))} placeholder="Decision reason" maxLength={500} disabled={working} /><button type="button" className="gst-button secondary" disabled={working || matchStatus !== 'matched' || !decisionReasons[item.invoiceId]?.trim()} onClick={() => decideEvidence(item, 'eligibility', 'eligible')}>Mark eligible</button><button type="button" className="gst-button danger" disabled={working || !decisionReasons[item.invoiceId]?.trim()} onClick={() => decideEvidence(item, 'eligibility', 'blocked')}>Block credit</button></div>}
                  {item.events?.length > 0 && <small className="gst-evidence-history">Latest audit entry: {item.events.at(-1).details} · {item.events.at(-1).createdAt}</small>}
                </div>
              </article>;
            })}</div>}
          </section>

          <section className="gst-panel gst-review">
            <div><h2>Accountant / CA period review</h2><p className="gst-muted">Internal assessment of this local period preview. All approved purchases need a recorded eligibility decision before the period can be reviewed.</p>{pendingEvidence.length > 0 && <p className="gst-review-warning">{pendingEvidence.length} purchase credit decision{pendingEvidence.length === 1 ? '' : 's'} pending.</p>}
              {reviewer && <p className="gst-review-meta">Reviewed by {reviewer}{review.reviewedAt ? ` · ${new Date(review.reviewedAt).toLocaleString('en-IN')}` : ''}</p>}{data.reviewNotes && <p className="gst-review-meta">Review note: {data.reviewNotes}</p>}{data.approvedBy && <p className="gst-review-meta">Approved by {data.approvedBy}</p>}</div>
            {canReview ? <div className="gst-review-actions"><label htmlFor="gst-review-notes">Review notes</label><textarea id="gst-review-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Checks and exceptions for this review" rows="2" disabled={busy || isReviewed || isApproved} />
              <div className="gst-action-row"><button type="button" className="gst-button secondary" onClick={() => recordReview('review')} disabled={busy || isApproved || isReviewed || evidenceLoading || Boolean(evidenceError) || pendingEvidence.length > 0}>{busy ? 'Saving…' : isReviewed ? 'Reviewed internally' : 'Record review'}</button><button type="button" className="gst-button" onClick={() => recordReview('approve')} disabled={busy || !isReviewed || String(data.reviewedBy) === String(context.userId)}>{isApproved ? 'Approved internally' : 'Approve internally'}</button></div>{isReviewed && String(data.reviewedBy) === String(context.userId) && <p className="gst-muted gst-role-note">A different accountant or admin must approve this review.</p>}</div> : <p className="gst-muted gst-role-note">An accountant or admin can record review and a different accountant or admin can approve it.</p>}
          </section>

          <section className="gst-panel gst-transactions">
            <div className="gst-section-heading"><div><h2>Source transactions</h2><p className="gst-muted">The same business records used by sales and purchasing.</p></div><label>Show <select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="all">All</option><option value="sales">Sales</option><option value="purchases">Purchases</option></select></label></div>
            <div className="gst-table-wrap"><table><thead><tr><th>Document</th><th>Date</th><th>Party</th><th>Type</th><th>Taxable value</th><th>Tax</th></tr></thead><tbody>{visibleTransactions.length ? visibleTransactions.map((item, index) => <tr key={item.id ?? `${item.number}-${index}`}><td><button type="button" className="gst-document-link" onClick={() => openTransaction(item.id)} aria-expanded={transaction?.id === item.id}>{item.number ?? item.invoiceNumber ?? item.billNumber ?? item.reference ?? item.id ?? '—'}</button></td><td>{item.date ?? item.invoiceDate ?? item.billDate ?? '—'}</td><td>{item.partyName ?? item.customerName ?? item.supplierName ?? item.party ?? '—'}</td><td>{label(item.direction ?? item.type ?? item.kind ?? 'Transaction')}</td><td>{money(item.subtotalCents !== undefined ? item.subtotalCents / 100 : readAmount(item, 'taxableValue', 'taxable_value', 'subtotal'))}</td><td>{money(item.taxCents !== undefined ? item.taxCents / 100 : readAmount(item, 'taxAmount', 'tax_amount', 'gstAmount', 'gst_amount', 'tax'))}</td></tr>) : <tr><td colSpan="6" className="gst-no-transactions">No transactions in this view.</td></tr>}</tbody></table></div>
            {transactionLoading && <p className="gst-muted gst-detail-loading">Loading document…</p>}
            {transaction && !transactionLoading && <div className="gst-document-detail"><div className="gst-section-heading"><div><p className="gst-eyebrow">Source document</p><h2>{transaction.number}</h2><p className="gst-muted">{transaction.partyName} · {transaction.invoiceDate} · {label(transaction.status)}</p></div><button type="button" className="gst-close" onClick={() => setTransaction(null)} aria-label="Close document details">×</button></div><div className="gst-table-wrap"><table><thead><tr><th>Item</th><th>Quantity</th><th>Tax rate</th><th>Taxable value</th><th>Tax</th></tr></thead><tbody>{transaction.lines?.map((line) => <tr key={line.id}><td>{line.itemName ?? line.sku}</td><td>{line.quantity}</td><td>{((line.gstRateBps ?? 0) / 100).toFixed(2)}%</td><td>{money(line.subtotalCents / 100)}</td><td>{money(line.taxCents / 100)}</td></tr>)}</tbody></table></div></div>}
          </section>
        </>}
      </div>
    </div>
  </div>;
}
