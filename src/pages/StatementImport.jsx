import { useCallback, useEffect, useState } from 'react';
import './statementImport.css';

const TEMPLATE = 'supplier_gstin,invoice_number,invoice_date,taxable_amount,tax_amount\n';
const money = cents => new Intl.NumberFormat('en-IN',{ style:'currency',currency:'INR' }).format((Number(cents) || 0) / 100);
const month = () => new Date().toISOString().slice(0,7);
const dateTime = value => value ? new Date(`${value.replace(' ','T')}Z`).toLocaleString('en-IN',{ dateStyle:'medium',timeStyle:'short' }) : '';

export default function StatementImport({ context = {}, refresh }) {
  const { companyId,gstinId,role,apiFetch } = context;
  const [period,setPeriod] = useState(month());
  const [sourceName,setSourceName] = useState('');
  const [csv,setCsv] = useState('');
  const [preview,setPreview] = useState(null);
  const [imports,setImports] = useState([]);
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const canCommit = ['accountant','admin'].includes(role);
  const chosenGstin = context.bootstrap?.companies?.find(company => String(company.id) === String(companyId))?.gstins?.find(item => String(item.id) === String(gstinId))?.gstin;

  const request = useCallback(async (path,options={}) => {
    const response = await apiFetch(path,options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  },[apiFetch]);
  const load = useCallback(async () => {
    if (!gstinId) return;
    setLoading(true);
    try { const data = await request(`/api/gst/statement-imports?gstinId=${gstinId}`); setImports(data.imports || []); }
    catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  },[gstinId,request]);
  useEffect(() => { setPreview(null); setCsv(''); setSourceName(''); setImports([]); setError(''); setNotice(''); },[companyId,gstinId]);
  useEffect(() => { load(); },[load]);

  const changeCsv = value => { setCsv(value); setPreview(null); setError(''); setNotice(''); };
  const changeSource = value => { setSourceName(value); setPreview(null); };
  const changePeriod = value => { setPeriod(value); setPreview(null); };
  const readFile = async file => {
    if (!file) return;
    setPreview(null); setError(''); setNotice('');
    if (file.size > 128 * 1024) { setError('Choose a CSV no larger than 128 KB.'); return; }
    try {
      const content = new TextDecoder('utf-8',{ fatal:true,ignoreBOM:true }).decode(await file.arrayBuffer());
      setSourceName(file.name.slice(0,120));
      changeCsv(content);
    } catch { setError('The file is not valid UTF-8. Export a UTF-8 CSV and try again.'); }
  };
  const body = () => ({ gstinId:Number(gstinId),period,sourceName:sourceName.trim(),csv });
  const inspect = async event => {
    event.preventDefault(); setBusy(true); setError(''); setNotice(''); setPreview(null);
    try { const data = await request('/api/gst/statement-imports/preview',{ method:'POST',body:JSON.stringify(body()) }); setPreview(data.preview); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview?.canCommit) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await request('/api/gst/statement-imports/commit',{ method:'POST',body:JSON.stringify({ ...body(),expectedSha256:preview.sha256 }) });
      setNotice(data.replayed ? 'This exact statement was already imported. No source rows changed.' : `${data.inserted} row${data.inserted === 1 ? '' : 's'} imported; ${data.skipped} exact repeat${data.skipped === 1 ? '' : 's'} skipped. Matching and ITC review remain separate steps.`);
      setPreview(null); await load(); refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE],{ type:'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'local-purchase-statement-template.csv'; link.click(); URL.revokeObjectURL(url);
  };

  return <section className="statement-page" aria-label="Local purchase statement import">
    <header className="statement-head"><div><span className="statement-kicker">GST SOURCE WORKSPACE</span><h1>Purchase statement import</h1><p>Bring supplier invoice rows into local GST reconciliation.</p></div><span className="statement-scope">{chosenGstin || 'Select a GSTIN'} · local only</span></header>
    <p className="statement-boundary"><strong>Local statement, not portal verification.</strong> Uploaded rows become comparison sources. Matching, ITC eligibility, internal period approval, signing, and filing are separate decisions.</p>
    {error && <p className="statement-message error" role="alert">{error}</p>}{notice && <p className="statement-message success" role="status">{notice}</p>}
    <div className="statement-layout"><section className="statement-card statement-upload"><div className="statement-card-head"><h2>Prepare a source</h2><button type="button" className="statement-link" onClick={downloadTemplate}>Download CSV template</button></div>
      <form onSubmit={inspect}><div className="statement-fields"><label>Source period<input type="month" value={period} onChange={event => changePeriod(event.target.value)} required /></label><label>Source name<input value={sourceName} onChange={event => changeSource(event.target.value)} maxLength={120} placeholder="Purchase statement September 2026.csv" required /></label></div>
        <label className="statement-file">Choose CSV file<input type="file" accept=".csv,text/csv" onChange={event => readFile(event.target.files?.[0])} /></label>
        <label className="statement-csv">Or paste CSV<textarea rows={6} value={csv} onChange={event => changeCsv(event.target.value)} spellCheck="false" placeholder={TEMPLATE} required /></label>
        <p className="statement-help">Five columns: supplier GSTIN, invoice number, invoice date, taxable amount, tax amount. Rupees with up to two decimals. Quoted commas are supported. Maximum 500 rows or 128 KB.</p>
        <button className="statement-primary" type="submit" disabled={busy || !gstinId || !csv.trim()}>Preview and validate</button>
      </form></section>
      <section className="statement-card statement-preview" aria-label="Import preview"><div className="statement-card-head"><h2>Validation preview</h2>{preview && <span>{preview.rowCount} rows</span>}</div>
        {!preview ? <div className="statement-empty">Choose or paste a CSV to see new rows, exact repeats, and conflicts before any data is saved.</div> : <><div className="statement-stats"><span><b>{preview.newCount}</b> new</span><span><b>{preview.repeatCount}</b> exact repeats</span><span className={preview.conflictCount ? 'warn' : ''}><b>{preview.conflictCount}</b> conflicts</span><span className={preview.invalidCount ? 'warn' : ''}><b>{preview.invalidCount}</b> invalid</span></div>
          {preview.periodStatus !== 'open' && preview.periodStatus !== 'not_created' && <p className="statement-message error">This GST period is {preview.periodStatus}; importing into it is closed.</p>}
          <div className="statement-rows">{preview.rows.map(row => <div className="statement-row" key={row.line}><span className={`statement-status ${row.status}`}>{row.status}</span><div><strong>{row.invoiceNumber || `Line ${row.line}`}</strong><small>{row.supplierGstin || row.detail}</small></div><div><strong>{row.taxableCents === undefined ? '—' : money(row.taxableCents)}</strong><small>{row.taxCents === undefined ? '' : `${money(row.taxCents)} tax`}</small></div><p>{row.detail}</p></div>)}</div>
          <div className="statement-commit"><span>{preview.canCommit ? 'Validated for local import. Your source file and user are recorded in the audit.' : 'Resolve conflicts or invalid rows, then preview again.'}</span><button type="button" className="statement-primary" onClick={commit} disabled={!preview.canCommit || !canCommit || busy}>Commit statement</button></div>
          {!canCommit && <small className="statement-role">Accountant or admin demo role required to commit.</small>}</>}
      </section></div>
    <section className="statement-card statement-history"><div className="statement-card-head"><h2>Imported sources</h2><span>{imports.length} recent imports</span></div>{loading ? <p className="statement-empty">Loading source history…</p> : imports.length ? <div className="statement-imports">{imports.map(item => <article key={item.id}><div><strong>{item.sourceName}</strong><small>{item.sourcePeriod} · {item.importedByName} · {dateTime(item.importedAt)}</small></div><div><b>{item.insertedCount} imported</b><small>{item.skippedCount} repeats · CSV text SHA-256 {item.fileSha256.slice(0,12)}…</small></div></article>)}</div> : <p className="statement-empty">No user-provided local statements have been imported for this GSTIN yet. Seeded synthetic comparison rows are separate.</p>}</section>
  </section>;
}
