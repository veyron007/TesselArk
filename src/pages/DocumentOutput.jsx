import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './DocumentOutput.css';

const money = cents => `₹${(Number(cents || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
const languages = [{ code:'en', name:'English' }, { code:'hi', name:'हिन्दी' }, { code:'mr', name:'मराठी' }];
const templates = [{ id:'invoice-standard', name:'Standard · A4' }, { id:'invoice-compact', name:'Compact · A4' }];
const title = type => type === 'purchase' ? 'Purchase bill copy' : 'Sales invoice copy';

export default function DocumentOutput({ context = {}, initialInvoiceId }) {
  const companyId = context.companyId || context.bootstrap?.currentCompanyId || '';
  const userId = context.userId || context.bootstrap?.currentUserId || '';
  const branchId = context.branchId || '';
  const gstinId = context.gstinId || '';
  const company = context.bootstrap?.companies?.find(row => row.id === Number(companyId));
  const branch = company?.branches?.find(row => row.id === Number(branchId));
  const gstin = company?.gstins?.find(row => row.id === Number(gstinId));
  const scopeKey = `${companyId}:${gstinId}:${branchId}:${userId}`;
  const [invoices, setInvoices] = useState([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [versions, setVersions] = useState([]);
  const [document, setDocument] = useState(null);
  const [language, setLanguage] = useState('en');
  const [templateId, setTemplateId] = useState('invoice-standard');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestNumber = useRef(0);
  const detailNumber = useRef(0);
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;

  const api = useCallback(async (path, init = {}) => {
    const response = context.apiFetch ? await context.apiFetch(path, init) : await fetch(path, {
      ...init,
      headers:{ 'Content-Type':'application/json', 'x-company-id':companyId, 'x-user-id':userId, ...init.headers },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [companyId, userId, context.apiFetch]);

  useEffect(() => {
    const sequence = ++requestNumber.current;
    const targetScope = scopeKey;
    setLoading(true); setError(''); setNotice(''); setInvoices([]); setInvoiceId(''); setVersions([]); setDocument(null);
    if (!companyId || !branchId || !gstinId) { setLoading(false); return; }
    api(`/api/document-output/invoices?branchId=${encodeURIComponent(branchId)}&gstinId=${encodeURIComponent(gstinId)}`)
      .then(data => {
        if (sequence !== requestNumber.current || activeScope.current !== targetScope) return;
        const rows = data.invoices || [];
        setInvoices(rows);
        const requested = Number(initialInvoiceId);
        setInvoiceId(String(rows.some(row => row.id === requested) ? requested : rows[0]?.id || ''));
      })
      .catch(cause => { if (sequence === requestNumber.current && activeScope.current === targetScope) setError(cause.message); })
      .finally(() => { if (sequence === requestNumber.current && activeScope.current === targetScope) setLoading(false); });
  }, [api, branchId, companyId, gstinId, initialInvoiceId, scopeKey]);

  const reloadVersions = useCallback(async (id, selectLatest = false) => {
    const sequence = ++detailNumber.current;
    const targetScope = scopeKey;
    setDetailLoading(true); setError(''); setVersions([]); setDocument(null);
    try {
      const data = await api(`/api/document-output/invoices/${id}/versions`);
      if (sequence !== detailNumber.current || activeScope.current !== targetScope) return;
      const rows = data.versions || [];
      setVersions(rows);
      if (selectLatest && rows.length) {
        const opened = await api(`/api/document-output/invoices/${id}/versions/${rows[0].version}`);
        if (sequence === detailNumber.current && activeScope.current === targetScope) setDocument(opened.document);
      }
    } catch (cause) {
      if (sequence === detailNumber.current && activeScope.current === targetScope) setError(cause.message);
    } finally {
      if (sequence === detailNumber.current && activeScope.current === targetScope) setDetailLoading(false);
    }
  }, [api, scopeKey]);

  useEffect(() => {
    ++detailNumber.current;
    setVersions([]); setDocument(null); setNotice('');
    if (invoiceId) reloadVersions(invoiceId, true);
  }, [invoiceId, reloadVersions]);

  const chosen = useMemo(() => invoices.find(row => String(row.id) === invoiceId), [invoices, invoiceId]);
  const createVersion = async () => {
    if (!invoiceId || busy) return;
    const selected = invoiceId, targetScope = scopeKey;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await api(`/api/document-output/invoices/${selected}/versions`, {
        method:'POST', body:JSON.stringify({ templateId, language }),
      });
      if (activeScope.current !== targetScope || invoiceId !== selected) return;
      setDocument(data.document);
      const listing = await api(`/api/document-output/invoices/${selected}/versions`);
      if (activeScope.current !== targetScope || invoiceId !== selected) return;
      setVersions(listing.versions || []);
      setNotice(data.replayed ? 'Opened the existing version for this exact source and template.' : `Saved print version ${data.document.version}.`);
    } catch (cause) {
      if (activeScope.current === targetScope) setError(cause.message);
    } finally { setBusy(false); }
  };
  const openVersion = async version => {
    const selected = invoiceId, targetScope = scopeKey;
    setDetailLoading(true); setError(''); setNotice('');
    try {
      const data = await api(`/api/document-output/invoices/${selected}/versions/${version}`);
      if (activeScope.current === targetScope && invoiceId === selected) setDocument(data.document);
    } catch (cause) {
      if (activeScope.current === targetScope) setError(cause.message);
    } finally { setDetailLoading(false); }
  };

  const snap = document?.snapshot;
  const labels = document?.labels || {};
  const isDraftPrint = document?.sourceStatus !== 'approved';
  return <main className="document-output-page">
    <header className="document-output-hero">
      <div><span className="document-output-eyebrow">DOCUMENTS / ERP-025</span><h1>Invoice print studio</h1><p>Capture a version of a real invoice, review its item identity and language, then print the saved copy.</p></div>
      <div className="document-output-context"><small>SELECTED SCOPE</small><strong>{context.companyName || company?.name || `Company #${companyId}`}</strong><span>{gstin?.gstin || `GSTIN #${gstinId}`} · {branch?.name || `Branch #${branchId}`}</span></div>
    </header>
    <p className="document-output-boundary">Local operational copy. No statutory signing, government filing, barcode scanning guarantee or legal format validation is performed here.</p>
    {error && <div className="document-output-alert error" role="alert">{error}</div>}
    {notice && <div className="document-output-alert success" role="status">{notice}</div>}
    <div className="document-output-layout">
      <section className="document-output-panel document-output-controls" aria-label="Print selection">
        <div className="document-output-panel-head"><span>01 / SOURCE</span><h2>Select invoice</h2></div>
        {loading ? <p className="document-output-empty">Loading scoped invoices…</p> : invoices.length ? <label>Invoice<select value={invoiceId} onChange={event => setInvoiceId(event.target.value)}>{invoices.map(row => <option value={row.id} key={row.id}>{row.number} · {row.status} · {row.branchName}</option>)}</select></label> : <p className="document-output-empty">No invoices in this branch. Create one in Operations first.</p>}
        {chosen && <div className="document-output-source"><strong>{title(chosen.type)}</strong><span>{chosen.number} · {chosen.invoiceDate}</span><span>{chosen.partyName} · {money(chosen.totalCents)}</span><b className={`document-output-status ${chosen.status}`}>{chosen.status}</b></div>}
        <div className="document-output-panel-head"><span>02 / FORMAT</span><h2>Prepare copy</h2></div>
        <div className="document-output-fields"><label>Layout<select value={templateId} onChange={event => setTemplateId(event.target.value)}>{templates.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label><label>Print language<select value={language} onChange={event => setLanguage(event.target.value)}>{languages.map(row => <option value={row.code} key={row.code}>{row.name}</option>)}</select></label></div>
        <button type="button" disabled={!chosen || busy || loading} onClick={createVersion}>{busy ? 'Saving…' : 'Capture print version'}</button>
        <small className="document-output-hint">A version freezes the current invoice status, line values, item names, SKUs and template labels. Repeating an unchanged selection opens that same version.</small>
        <div className="document-output-panel-head document-output-history-head"><span>03 / HISTORY</span><h2>Saved versions</h2></div>
        {detailLoading && <p className="document-output-empty">Loading versions…</p>}
        {!detailLoading && !versions.length && <p className="document-output-empty">No saved print versions for this invoice.</p>}
        <div className="document-output-history">{versions.map(row => <button type="button" className={document?.version === row.version ? 'selected' : ''} onClick={() => openVersion(row.version)} key={row.version}><span><strong>Version {row.version}</strong><small>{row.templateId} v{row.templateVersion} · {row.language.toUpperCase()}</small></span><span><b className={`document-output-status ${row.sourceStatus}`}>{row.sourceStatus}</b><small>{row.createdAt}</small></span></button>)}</div>
      </section>
      <section className="document-output-panel document-output-preview-panel" aria-label="Print preview">
        <div className="document-output-preview-heading"><div><span>04 / PRINT PREVIEW</span><h2>{document ? `Version ${document.version} · ${document.templateId} v${document.templateVersion}` : 'Choose a saved copy'}</h2></div><button type="button" disabled={!document || detailLoading} onClick={() => window.print()}>Print selected version</button></div>
        {!document && <div className="document-output-preview-empty">Select an invoice and capture its print version to see the exact saved copy.</div>}
        {document && <>
          {document.sourceChangedSinceVersion && <p className="document-output-alert warning">Historical copy. The current invoice differs from this saved version. Source status now: {document.currentSourceStatus}.</p>}
          {snap.lines.some(line => line.itemIdentitySource === 'legacy_master_backfill') && <p className="document-output-alert warning">One or more item descriptions were recovered from the item master when an older invoice was migrated. Check the original source document before external use.</p>}
          <article className={`document-output-paper ${document.templateId === 'invoice-compact' ? 'compact' : ''}`} lang={document.language}>
            <div className="document-output-paper-top"><div><small>TESSELARK · LOCAL DOCUMENT COPY</small><h2>{labels.heading}</h2><p>{snap.companyName}<br />{snap.branchName} · {snap.gstin}</p></div><div className="document-output-paper-serial"><strong>{snap.number}</strong><span>{labels.date}: {snap.invoiceDate}</span><span>Print version {document.version} · Template {document.templateId} v{document.templateVersion}</span></div></div>
            <div className={`document-output-paper-state ${isDraftPrint ? 'unapproved' : ''}`}>{labels[document.sourceStatus]} · {document.sourceStatus.toUpperCase()}</div>
            <div className="document-output-paper-parties"><div><small>{snap.type === 'purchase' ? labels.buyer : labels.seller}</small><strong>{snap.companyName}</strong><span>GSTIN {snap.gstin}</span></div><div><small>{snap.type === 'purchase' ? labels.supplier : labels.buyer}</small><strong>{snap.partyName}</strong><span>{snap.partyGstin ? `GSTIN ${snap.partyGstin}` : 'GSTIN not recorded'}</span>{snap.partyAddress && <span>{snap.partyAddress}</span>}</div></div>
            <div className="document-output-table-scroll"><table><thead><tr><th>{labels.item}</th><th>{labels.quantity}</th><th>{labels.rate}</th><th>{labels.tax}</th><th>{labels.total}</th></tr></thead><tbody>{snap.lines.map(line => <tr key={line.invoiceLineId}><td><strong>{line.name}</strong><small>{labels.sku}: {line.sku} · {labels.hsn}: {line.hsn || '—'}</small><small>Item #{line.itemId} · Identity {line.barcodePayload}</small></td><td>{line.quantity} {line.unit}</td><td>{money(line.unitPriceCents)}</td><td>{money(line.taxCents)}</td><td><strong>{money(line.totalCents)}</strong></td></tr>)}</tbody></table></div>
            <div className="document-output-paper-bottom"><div>{snap.notes && <p><strong>{labels.notes}</strong><br />{snap.notes}</p>}<small>Identity codes use company and item IDs. They are text references, not tested scannable barcodes.</small></div><dl><div><dt>{labels.subtotal}</dt><dd>{money(snap.subtotalCents)}</dd></div><div><dt>{labels.tax}</dt><dd>{money(snap.taxCents)}</dd></div><div className="total"><dt>{labels.total}</dt><dd>{money(snap.totalCents)}</dd></div></dl></div>
            <footer>Local copy · Source invoice #{snap.invoiceId} · Source status at capture: {document.sourceStatus} · SHA-256 {document.sourceHash.slice(0, 16)}…</footer>
          </article>
        </>}
      </section>
    </div>
  </main>;
}
