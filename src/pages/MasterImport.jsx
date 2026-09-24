import { useCallback, useEffect, useState } from 'react';
import './MasterImport.css';

const TEMPLATE = 'sku,name,hsn,unit,gst_rate_bps,reorder_level,track_stock\n';
const dateTime = value => value ? new Date(`${value.replace(' ','T')}Z`).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) : '';

export default function MasterImport({context={},refresh}) {
  const {apiFetch,companyId,gstinId,branchId,role} = context;
  const company = context.bootstrap?.companies?.find(row => String(row.id) === String(companyId));
  const gstin = company?.gstins?.find(row => String(row.id) === String(gstinId));
  const branch = company?.branches?.find(row => String(row.id) === String(branchId));
  const [sourceName,setSourceName] = useState('');
  const [csv,setCsv] = useState('');
  const [preview,setPreview] = useState(null);
  const [imports,setImports] = useState([]);
  const [selected,setSelected] = useState(null);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const mayCommit = ['accountant','admin'].includes(role);

  const request = useCallback(async (path,options={}) => {
    const response = await apiFetch(path,options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  },[apiFetch]);
  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try { setImports((await request('/api/master-imports')).imports || []); }
    catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  },[companyId,request]);
  useEffect(() => { setSourceName(''); setCsv(''); setPreview(null); setSelected(null); setImports([]); setError(''); setNotice(''); },[companyId,gstinId,branchId]);
  useEffect(() => { load(); },[load]);

  const clearPreview = () => { setPreview(null); setNotice(''); };
  const readFile = async file => {
    if (!file) return;
    clearPreview(); setError('');
    if (file.size > 128*1024) { setError('Choose a CSV no larger than 128 KB.'); return; }
    try {
      const content = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());
      setSourceName(file.name.slice(0,120)); setCsv(content);
    } catch { setError('The file is not valid UTF-8. Export a UTF-8 CSV and try again.'); }
  };
  const body = () => ({gstinId:Number(gstinId),branchId:Number(branchId),sourceName:sourceName.trim(),csv});
  const inspect = async event => {
    event.preventDefault(); setBusy(true); setError(''); setNotice(''); setPreview(null);
    try { setPreview((await request('/api/master-imports/preview',{method:'POST',body:JSON.stringify(body())})).preview); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await request('/api/master-imports/commit',{method:'POST',body:JSON.stringify({...body(),expectedSha256:preview.sha256})});
      setNotice(data.replayed ? `Exact replay of import #${data.import.id}. No item changed.` : `Import #${data.import.id}: ${data.accepted} item${data.accepted === 1 ? '' : 's'} created; ${data.rejected} row${data.rejected === 1 ? '' : 's'} rejected with reasons.`);
      setSelected({import:data.import,rows:data.rows}); setPreview(null); await load(); refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const show = async id => {
    setBusy(true); setError('');
    try { setSelected(await request(`/api/master-imports/${id}`)); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const downloadSource = async id => {
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/master-imports/${id}/source`);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Download failed (${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = `item-master-import-${id}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE],{type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = 'item-master-template.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  };

  return <main className="master-import-page">
    <header className="master-import-head"><div><span className="master-import-eyebrow">DATA EXCHANGE · ITEM MASTERS</span><h1>Item master import</h1><p>Review a local CSV before creating company item records.</p></div><div className="master-import-context"><strong>{company?.name || 'Select a company'}</strong><span>{gstin?.gstin || 'GSTIN unavailable'}</span><span>{branch?.name || 'Branch unavailable'} · {role || 'role'}</span></div></header>
    <p className="master-import-boundary">This creates item masters only. It does not post opening stock, purchases, invoices, tax decisions, or filing. Because items are shared across the company, the operator needs grants to every company GSTIN and branch.</p>
    {error && <p className="master-import-alert error" role="alert">{error}</p>}{notice && <p className="master-import-alert success" role="status">{notice}</p>}
    <div className="master-import-layout"><section className="master-import-card"><div className="master-import-card-head"><h2>Prepare source</h2><button type="button" className="master-import-link" onClick={downloadTemplate}>Download template</button></div>
      <form onSubmit={inspect} className="master-import-form"><label>Source name<input value={sourceName} onChange={event => { setSourceName(event.target.value); clearPreview(); }} maxLength={120} placeholder="Item list September 2026.csv" required /></label>
        <label className="master-import-file">Choose a UTF-8 CSV<input type="file" accept=".csv,text/csv" onChange={event => readFile(event.target.files?.[0])} /></label>
        <label>Or paste CSV<textarea value={csv} onChange={event => { setCsv(event.target.value); clearPreview(); }} rows={7} spellCheck="false" placeholder={TEMPLATE} required /></label>
        <p className="master-import-help">Exact columns: <code>{TEMPLATE.trim()}</code>. One SKU per company. GST rate is basis points (1800 = 18%). Tracking accepts true or false. Up to 500 rows or 128 KB.</p>
        <button type="submit" className="master-import-primary" disabled={busy || !gstinId || !branchId || !csv.trim()}>Preview rows</button></form></section>
      <section className="master-import-card"><div className="master-import-card-head"><h2>Validation preview</h2>{preview && <span>{preview.rowCount} rows</span>}</div>
        {!preview ? <p className="master-import-empty">Choose or paste a CSV to see which items can be created and why other rows will be rejected.</p> : <><div className="master-import-totals"><span><b>{preview.readyCount}</b> ready</span><span><b>{preview.rejectedCount}</b> rejected</span>{preview.replayOf && <span><b>#{preview.replayOf}</b> exact replay</span>}</div>
          <div className="master-import-table-wrap"><table><thead><tr><th>Line</th><th>SKU / name</th><th>Outcome</th><th>Reason</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.line}><td>{row.line}</td><td><strong>{row.sku || '—'}</strong><small>{row.name || row.rawValues?.[1] || ''}</small></td><td><span className={`master-import-status ${row.status}`}>{row.status}</span></td><td>{row.reason}</td></tr>)}</tbody></table></div>
          <div className="master-import-commit"><p>{preview.replayOf ? 'This exact source and scope were already committed; replay returns the original result.' : 'Rejected rows will be saved with their source line and reason. Ready rows create items once.'}</p><button type="button" className="master-import-primary" onClick={commit} disabled={busy || !mayCommit}>{preview.replayOf ? 'Replay import' : 'Commit import'}</button></div>
          {!mayCommit && <p className="master-import-help">Accountant or admin role is required to commit.</p>}</>}
      </section></div>
    <section className="master-import-card master-import-history"><div className="master-import-card-head"><h2>Source history</h2><span>{imports.length} recent imports</span></div>
      {loading ? <p className="master-import-empty">Loading import history…</p> : !imports.length ? <p className="master-import-empty">No item master CSV has been committed for this company.</p> : <div className="master-import-list">{imports.map(row => <button type="button" key={row.id} onClick={() => show(row.id)} disabled={busy}><span><strong>#{row.id} · {row.sourceName}</strong><small>{row.importedByName} · {dateTime(row.importedAt)} · GSTIN #{row.gstinId} / branch #{row.branchId}</small></span><span><b>{row.acceptedCount} created · {row.rejectedCount} rejected</b><small>SHA-256 {row.fileSha256.slice(0,12)}…</small></span></button>)}</div>}
    </section>
    {selected && <section className="master-import-card master-import-detail"><div className="master-import-card-head"><div><h2>Import #{selected.import.id} · source rows</h2><p>{selected.import.sourceName} · {selected.import.importedByName} · {dateTime(selected.import.importedAt)}</p></div><button type="button" className="master-import-link" disabled={busy} onClick={() => downloadSource(selected.import.id)}>Download exact CSV</button></div>
      <div className="master-import-table-wrap"><table><thead><tr><th>Source line</th><th>SKU</th><th>Result</th><th>Linked item</th><th>Reason</th></tr></thead><tbody>{selected.rows.map(row => <tr key={row.sourceLine}><td>{row.sourceLine}</td><td>{row.sku || '—'}</td><td><span className={`master-import-status ${row.status}`}>{row.status}</span></td><td>{row.itemId ? `Item #${row.itemId}` : '—'}</td><td>{row.reason}</td></tr>)}</tbody></table></div>
      <p className="master-import-foot">Source CSV SHA-256: <code>{selected.import.fileSha256}</code></p></section>}
  </main>;
}
