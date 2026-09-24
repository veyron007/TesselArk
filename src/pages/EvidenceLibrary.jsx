import { useEffect, useMemo, useRef, useState } from 'react';
import './evidenceLibrary.css';

const readableDate = value => value ? new Date(`${value.replace(' ','T')}Z`).toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
const size = bytes => `${Math.ceil(bytes / 1024)} KB`;
const readFile = file => new Promise((resolve,reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('Could not read the selected file.'));
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.readAsDataURL(file);
});

export default function EvidenceLibrary({ context = {}, refresh = 0 }) {
  const { companyId,gstinId,branchId,role,apiFetch } = context;
  const [documents,setDocuments] = useState([]);
  const [targets,setTargets] = useState([]);
  const [targetType,setTargetType] = useState('invoice');
  const [targetId,setTargetId] = useState('');
  const [title,setTitle] = useState('');
  const [audience,setAudience] = useState('internal');
  const [file,setFile] = useState(null);
  const [selectedId,setSelectedId] = useState(null);
  const [detail,setDetail] = useState(null);
  const [replacement,setReplacement] = useState(null);
  const [reason,setReason] = useState('');
  const [query,setQuery] = useState('');
  const [statusFilter,setStatusFilter] = useState('all');
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const formRef = useRef(null);
  const detailRef = useRef(null);
  const request = async (path, options = {}) => {
    const response = await apiFetch(path,options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  };
  const filters = useMemo(() => new URLSearchParams({ gstinId:String(gstinId), branchId:String(branchId) }),[gstinId,branchId]);
  const reload = async () => {
    const result = await request(`/api/evidence?${filters}`);
    setDocuments(result.documents || []);
  };
  useEffect(() => {
    let active = true;
    setDocuments([]); setTargets([]); setDetail(null); setSelectedId(null); setLoading(true); setError(''); setNotice('');
    if (!companyId || !gstinId || !branchId) { setLoading(false); return undefined; }
    request(`/api/evidence?${filters}`).then(data => { if (active) setDocuments(data.documents || []); })
      .catch(issue => { if (active) setError(issue.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  },[companyId,gstinId,branchId,apiFetch,refresh]);
  useEffect(() => {
    let active = true;
    setTargets([]); setTargetId('');
    if (!companyId || !gstinId || !branchId) return undefined;
    const path = targetType === 'invoice' ? `/api/invoices?${filters}` : `/api/workflows/cases?${filters}`;
    request(path).then(data => { if (active) setTargets(targetType === 'invoice' ? data.invoices || [] : data.cases || []); })
      .catch(issue => { if (active) setError(issue.message); });
    return () => { active = false; };
  },[companyId,gstinId,branchId,targetType,apiFetch]);
  useEffect(() => {
    let active = true; setDetail(null); setReason('');
    if (!selectedId) return undefined;
    request(`/api/evidence/${selectedId}`).then(data => { if (active) setDetail(data.document); })
      .catch(issue => { if (active) setError(issue.message); });
    return () => { active = false; };
  },[selectedId,apiFetch]);
  useEffect(() => {
    if (!selectedId || window.innerWidth > 920) return undefined;
    const frame = window.requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior:'smooth', block:'start' }));
    return () => window.cancelAnimationFrame(frame);
  },[selectedId,detail]);
  const run = async (action, success) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); await reload(); setNotice(success); }
    catch (issue) { setError(issue.message || 'The request could not be completed.'); }
    finally { setBusy(false); }
  };
  const upload = event => {
    event.preventDefault();
    run(async () => {
      if (!file || file.size > 128 * 1024 || file.size === 0) throw new Error('Choose a nonempty file up to 128 KB.');
      const contentBase64 = await readFile(file);
      const result = await request('/api/evidence',{method:'POST',body:JSON.stringify({gstinId:Number(gstinId),branchId:Number(branchId),targetType,targetId:Number(targetId),title,audience,fileName:file.name,mimeType:file.type || 'text/plain',contentBase64})});
      setSelectedId(result.document.id); setDetail(result.document); setTitle(''); setFile(null);
    },'Evidence uploaded. It is pending local review.');
  };
  const addVersion = () => run(async () => {
    if (!replacement || replacement.size > 128 * 1024 || replacement.size === 0) throw new Error('Choose a nonempty file up to 128 KB.');
    const contentBase64 = await readFile(replacement);
    const result = await request(`/api/evidence/${selectedId}/versions`,{method:'POST',body:JSON.stringify({fileName:replacement.name,mimeType:replacement.type || 'text/plain',contentBase64})});
    setDetail(result.document); setReplacement(null);
  },'New version uploaded. Its review is pending.');
  const review = decision => run(async () => {
    const observed = detail?.versions?.[0];
    if (!observed) throw new Error('Open the evidence version before reviewing it.');
    try {
      const result = await request(`/api/evidence/${selectedId}/review`,{method:'POST',body:JSON.stringify({decision,reason,expectedVersion:observed.version,expectedSha256:observed.sha256})});
      setDetail(result.document); setReason('');
    } catch (issue) {
      const current = await request(`/api/evidence/${selectedId}`).catch(() => null);
      if (current?.document) setDetail(current.document);
      throw issue;
    }
  },`Latest version ${decision} in this local workspace.`);
  const download = async version => {
    setError('');
    try {
      const response = await apiFetch(`/api/evidence/${selectedId}/download?version=${version.version}`);
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Download failed.'); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = version.fileName; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    } catch (issue) { setError(issue.message); }
  };
  const canReview = role === 'accountant' || role === 'admin';
  const latest = detail?.versions?.[0];
  const userName = id => context.bootstrap?.users?.find(user => Number(user.id) === Number(id))?.name || `User #${id}`;
  const targetLabel = type => type === 'workflow_case' ? 'Module case' : 'Invoice';
  const visibleDocuments = documents.filter(item => (statusFilter === 'all' || item.status === statusFilter)
    && `${item.title} ${item.fileName} ${item.targetType} ${item.targetId}`.toLowerCase().includes(query.toLowerCase().trim()));
  const openDetail = (id) => setSelectedId(id);
  return <div className="evidence-page">
    <div className="evidence-heading"><div><p className="evidence-eyebrow">CONTROLLED SOURCE FILES</p><h1>Evidence library</h1><p>Keep small supporting files linked to a document or prototype case, with version history and local review.</p></div><span className="evidence-count">{documents.length} records</span></div>
    <div className="evidence-note">Review here is internal. Upload checks file size and basic format signatures; it does not verify document integrity or authenticity. A file or approval does not establish GST portal acceptance, statutory eligibility, or client access.</div>
    <button className="evidence-jump" type="button" onClick={() => formRef.current?.scrollIntoView({ behavior:'smooth', block:'start' })}>+ Add evidence</button>
    {error && <div className="evidence-alert error" role="alert">{error}</div>}{notice && <div className="evidence-alert success" role="status">{notice}</div>}
    <div className="evidence-grid">
      <section className="evidence-card evidence-upload" ref={formRef}><div className="evidence-card-head"><h2>Add evidence</h2><span>PDF, PNG, JPEG or TXT · max 128 KB</span></div>
        <form onSubmit={upload} className="evidence-form">
          <label>Linked record type<select value={targetType} onChange={event => setTargetType(event.target.value)}><option value="invoice">Invoice or purchase bill</option><option value="workflow_case">Module prototype case</option></select></label>
          <label>Linked record<select value={targetId} onChange={event => setTargetId(event.target.value)} required><option value="">Select a record</option>{targets.map(item => <option key={item.id} value={item.id}>{item.number || item.reference || `#${item.id}`} · {item.partyName || item.title || item.status}</option>)}</select></label>
          <label>Evidence title<input value={title} onChange={event => setTitle(event.target.value)} maxLength="160" placeholder="Signed delivery note" required /></label>
          <label>Audience<select value={audience} onChange={event => setAudience(event.target.value)}><option value="internal">Internal</option><option value="client">Client labelled (demo only)</option></select></label>
          <label>File<input type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" onChange={event => setFile(event.target.files?.[0] || null)} required /></label>
          <button className="evidence-primary" disabled={busy || !targetId || !file}>{busy ? 'Working…' : 'Upload evidence'}</button>
        </form>
      </section>
      <section className="evidence-card evidence-register"><div className="evidence-card-head"><h2>Evidence register</h2><span>Current company · GSTIN · branch</span></div>
        <div className="evidence-filters"><input aria-label="Search evidence" placeholder="Search files or linked records" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="Filter review status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All states</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></div>
        {loading ? <div className="evidence-empty">Loading evidence…</div> : !documents.length ? <div className="evidence-empty"><strong>No files yet</strong><p>Upload a supporting document against a record to start its review trail.</p></div> : !visibleDocuments.length ? <div className="evidence-empty">No evidence matches these filters.</div> : <div className="evidence-list">{visibleDocuments.map(item => <button key={item.id} type="button" className={`evidence-row ${selectedId === item.id ? 'selected' : ''}`} onClick={() => openDetail(item.id)}><span className="evidence-row-icon">↳</span><span className="evidence-row-main"><strong>{item.title}</strong><small>{item.targetType === 'invoice' ? 'Invoice' : 'Prototype case'} #{item.targetId} · v{item.version} · {item.fileName}</small></span><span className={`evidence-status ${item.status}`}>{item.status}</span></button>)}</div>}
      </section>
    </div>
    {selectedId && <section className="evidence-card evidence-detail" ref={detailRef}><div className="evidence-card-head"><div><p className="evidence-eyebrow">VERSION HISTORY</p><h2>{detail?.title || 'Loading record…'}</h2></div><button className="evidence-close" onClick={() => setSelectedId(null)} aria-label="Close evidence detail">×</button></div>
      {detail && <><div className="evidence-facts"><span><b>Scope</b> GSTIN #{detail.gstinId} · branch #{detail.branchId}</span><span><b>Link</b> {targetLabel(detail.targetType)} #{detail.targetId}</span><span><b>Audience</b> {detail.audience} label</span><span><b>Added</b> {readableDate(detail.createdAt)}</span></div>
        <div className="evidence-versions">{detail.versions.map(version => <div className="evidence-version" key={version.id}><div><strong>Version {version.version} · {version.fileName}</strong><small>{size(version.byteSize)} · SHA-256 {version.sha256} · uploaded by {userName(version.uploadedBy)} on {readableDate(version.uploadedAt)}</small><small>{version.reviewedAt ? `Reviewed by ${userName(version.reviewedBy)} on ${readableDate(version.reviewedAt)}${version.reviewReason ? ` · ${version.reviewReason}` : ''}` : 'Awaiting local review'}</small></div><span className={`evidence-status ${version.status}`}>{version.status}</span><button type="button" onClick={() => download(version)}>Download</button></div>)}</div>
        <div className="evidence-actions"><label>Upload replacement version<input type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" onChange={event => setReplacement(event.target.files?.[0] || null)} /></label><button type="button" onClick={addVersion} disabled={busy || !replacement}>Add version</button></div>
        {canReview && latest?.status === 'pending' && <div className="evidence-review"><label>Review note<input value={reason} onChange={event => setReason(event.target.value)} maxLength="500" placeholder="Reason required for rejection" /></label><div><button type="button" onClick={() => review('approved')} disabled={busy}>Approve evidence</button><button type="button" onClick={() => review('rejected')} disabled={busy || !reason.trim()}>Reject</button></div></div>}
      </>}
    </section>}
  </div>;
}
