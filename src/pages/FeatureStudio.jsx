import { useEffect, useMemo, useRef, useState } from 'react';
import features from '../data/features.json';
import './featureStudio.css';

const today = () => new Date().toISOString().slice(0, 10);
const rupees = cents => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);
const dateTime = value => value ? new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z')).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const titleCase = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
const emptyForm = () => ({ title: '', reference: '', date: today(), amount: '', notes: '', evidenceReference: '', fields: {} });
const partlyIntegrated = new Set(['ERP-002','ERP-010','ERP-011','ERP-018','ERP-023','ERP-024','TAX-01','TAX-03','TAX-06','TAX-07','TAX-08','TAX-13','TAX-14','TAX-15','TAX-24']);

const domainInputs = {
  Catalogue: ['Product or category', 'Search terms or substitute rationale'],
  Inventory: ['Item / SKU', 'Location, batch or voucher'],
  Trade: ['Customer or supplier', 'Document or order reference'],
  Finance: ['Account or counterparty', 'Ledger or settlement reference'],
  Reporting: ['Report period', 'Measure or comparison'],
  Access: ['User or role', 'Requested scope'],
  Controls: ['Control or policy', 'Exception or threshold'],
  Documents: ['Document type', 'Source record'],
  Counter: ['Customer or counter', 'Tender or receipt reference'],
  Communication: ['Recipient or audience', 'Message purpose'],
  Fulfilment: ['Order or consignment', 'Route or delivery point'],
  'Data continuity': ['Source system', 'Import batch or backup'],
  'Data exchange': ['Source and target systems', 'Mapping or exchange reference'],
  Commerce: ['Channel or storefront', 'Order or catalogue reference'],
  Distribution: ['Distributor or territory', 'Scheme or route reference'],
  Pharmacy: ['Product or batch', 'Prescription or dispensing reference'],
  Mandi: ['Commodity or lot', 'Market or weighment reference'],
  'Specialist trade': ['Item or specification', 'Trade document reference'],
  Services: ['Client or project', 'Service or milestone reference'],
  Apparel: ['Style or SKU', 'Size or colour matrix'],
  Jewellery: ['Item or lot', 'Weight or purity reference'],
  Hospitality: ['Outlet or table', 'Order or bill reference'],
  Manufacturing: ['Material or finished item', 'Work order or batch'],
  People: ['Employee or team', 'Period or policy reference'],
  Retail: ['Outlet or till', 'Transaction or item reference'],
  GST: ['GSTIN or counterparty', 'Tax period or document'],
  'Shared webapp workflows': ['Person or record', 'Review scope or period'],
};

function featureFields(feature) {
  const defaults = domainInputs[feature.domain] || ['Subject', 'Business reference'];
  const workflow = feature.workflow.toLowerCase();
  const second = /batch|expiry/.test(workflow) ? 'Batch / expiry reference'
    : /period|return|filing/.test(workflow) ? 'Period / return reference'
      : /invoice|bill|voucher|receipt/.test(workflow) ? 'Invoice / document reference'
        : /location|warehouse|rack/.test(workflow) ? 'Location / branch reference'
          : defaults[1];
  return [defaults[0], second].map((label, index) => ({ key: `scope${index + 1}`, label }));
}

export default function FeatureStudio({ context, refresh, selectedFeatureId }) {
  const { companyId, gstinId, branchId, role, apiFetch, bootstrap } = context;
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('All domains');
  const [selectedId, setSelectedId] = useState(features[0]?.id);
  const [cases, setCases] = useState([]);
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [composer, setComposer] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [revision, setRevision] = useState(0);
  const [rejectionReason, setRejectionReason] = useState('');
  const indexListRef = useRef(null);
  const indexPaneRef = useRef(null);
  const detailRef = useRef(null);

  const domains = useMemo(() => ['All domains', ...new Set(features.map(feature => feature.domain))], []);
  const visible = useMemo(() => features.filter(feature =>
    (domain === 'All domains' || feature.domain === domain)
    && `${feature.id} ${feature.domain} ${feature.capability} ${feature.workflow}`.toLowerCase().includes(query.trim().toLowerCase())
  ), [domain, query]);
  const grouped = useMemo(() => {
    const groups = new Map();
    for (const feature of visible) groups.set(feature.domain, [...(groups.get(feature.domain) || []), feature]);
    return [...groups];
  }, [visible]);
  const selected = features.find(feature => feature.id === selectedId) || features[0];
  const activeCase = cases.find(item => item.id === selectedCaseId);
  const company = bootstrap?.companies?.find(item => String(item.id) === String(companyId));
  const selectedGstin = company?.gstins?.find(item => String(item.id) === String(gstinId));
  const selectedBranch = company?.branches?.find(item => String(item.id) === String(branchId));
  const canReview = role === 'accountant' || role === 'admin';
  const inputs = featureFields(selected);

  useEffect(() => {
    if (selectedFeatureId && features.some(feature => feature.id === selectedFeatureId)) {
      setDomain('All domains'); setQuery(''); setSelectedId(selectedFeatureId);
      if (window.matchMedia('(max-width: 850px)').matches) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    }
  }, [selectedFeatureId]);
  function chooseFeature(id) {
    setSelectedId(id);
    if (window.matchMedia('(max-width: 850px)').matches) setTimeout(() => {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }, 0);
  }
  useEffect(() => {
    const list = indexListRef.current;
    const item = list?.querySelector(`[data-feature-id="${selected.id}"]`);
    if (list && item) list.scrollTop += item.getBoundingClientRect().top - list.getBoundingClientRect().top - 12;
  }, [selected.id, query, domain]);

  async function request(path, init) {
    const response = await apiFetch(path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  useEffect(() => {
    setCases([]); setSelectedCaseId(null); setEvents([]); setComposer(false); setEditingId(null); setError(''); setNotice('');
  }, [selected.id, companyId, gstinId, branchId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const params = new URLSearchParams({ featureId: selected.id, gstinId: String(gstinId), branchId: String(branchId) });
    request(`/api/workflows/cases?${params}`).then(data => { if (active) setCases(data.cases || []); })
      .catch(issue => { if (active) setError(issue.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selected.id, companyId, gstinId, branchId, apiFetch, refresh, revision]);
  useEffect(() => {
    if (!selectedCaseId) { setEvents([]); return undefined; }
    let active = true;
    setEventsLoading(true); setEvents([]);
    request(`/api/workflows/cases/${selectedCaseId}/events`).then(data => { if (active) setEvents(data.events || []); })
      .catch(issue => { if (active) setError(issue.message); })
      .finally(() => { if (active) setEventsLoading(false); });
    return () => { active = false; };
  }, [selectedCaseId, apiFetch, revision]);

  function startDraft(record) {
    setError(''); setNotice(''); setComposer(true); setEditingId(record?.id || null);
    setForm(record ? {
      title: record.title || '', reference: record.reference || '', date: record.date || today(),
      amount: record.amountCents == null ? '' : String(record.amountCents / 100), notes: record.notes || '',
      evidenceReference: record.evidenceReference || '', fields: record.fields || {},
    } : emptyForm());
  }
  async function save(event) {
    event.preventDefault(); setError(''); setNotice('');
    const amount = form.amount.trim() === '' ? 0 : Number(form.amount);
    if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100))) { setError('Enter a valid nonnegative amount.'); return; }
    setBusy(true);
    try {
      const payload = {
        featureId: selected.id, gstinId: Number(gstinId), branchId: Number(branchId),
        title: form.title.trim(), reference: form.reference.trim(), date: form.date,
        amountCents: Math.round(amount * 100), notes: form.notes.trim(), evidenceReference: form.evidenceReference.trim(),
        fields: Object.fromEntries(inputs.map(field => [field.key, String(form.fields[field.key] || '').trim()])),
      };
      const data = await request(editingId ? `/api/workflows/cases/${editingId}` : '/api/workflows/cases', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setComposer(false); setEditingId(null); setSelectedCaseId(data.case?.id || null); setRevision(value => value + 1);
      setNotice(`${data.case?.title || 'Case'} saved as draft. It is ready for review when submitted.`);
    } catch (issue) { setError(issue.message); }
    finally { setBusy(false); }
  }
  async function transition(action) {
    if (!activeCase) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await request(`/api/workflows/cases/${activeCase.id}/${action}`, { method: 'POST', body: JSON.stringify(action === 'reject' ? { reason: rejectionReason.trim() } : {}) });
      setNotice(`${data.case?.title || 'Case'} ${action === 'submit' ? 'submitted for review' : action === 'approve' ? 'approved' : 'returned with a review reason'}. This prototype records the decision without posting specialist effects.`);
      setRejectionReason(''); setRevision(value => value + 1);
    } catch (issue) { setError(issue.message); }
    finally { setBusy(false); }
  }

  return <div className="studio-page">
    <header className="studio-heading"><div><p className="studio-eyebrow">EXPLORE THE FULL WORKSPACE</p><h1>All modules</h1><p>Find a capability, open its brief, and work through a saved case.</p></div><div className="studio-heading-stats"><strong>{features.length}</strong><span>capability groups</span></div></header>
    <div className="studio-disclosure" role="note"><strong>Prototype case records across all modules</strong><span>These records persist and support human review. They are scaffolding for future domain workflows, not evidence that each researched capability is implemented. Specialist calculations, legal rules, filings and downstream postings are not automated here.</span></div>
    {error && <div className="studio-alert error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {notice && <div className="studio-alert success" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss message">×</button></div>}
    <div className="studio-layout">
      <aside className="studio-index" aria-label="Capability browser" ref={indexPaneRef}><div className="studio-index-controls"><label className="studio-search"><span className="sr-only">Search modules</span><span aria-hidden="true">⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search 85 capabilities" /></label><select aria-label="Filter module domain" value={domain} onChange={event => setDomain(event.target.value)}>{domains.map(item => <option key={item}>{item}</option>)}</select><small>{visible.length} results across {grouped.length} domains</small></div>
        <div className="studio-index-list" ref={indexListRef}>{grouped.map(([group, items]) => <section key={group} className="studio-domain"><h2>{group}<span>{items.length}</span></h2>{items.map(feature => <button type="button" key={feature.id} data-feature-id={feature.id} className={`studio-feature ${selected.id === feature.id ? 'selected' : ''}`} aria-current={selected.id === feature.id ? 'true' : undefined} onClick={() => chooseFeature(feature.id)}><span className="studio-feature-id">{feature.id}</span><span className="studio-feature-name">{feature.capability}<small>{partlyIntegrated.has(feature.id) ? 'Partial domain workflow' : 'Planned · prototype case only'}</small></span><span className="studio-feature-arrow" aria-hidden="true">→</span></button>)}</section>)}{!visible.length && <div className="studio-index-empty">No matching capability. Try another term or domain.</div>}</div>
      </aside>
      <div className="studio-detail" ref={detailRef} tabIndex={-1}>
        <button type="button" className="studio-mobile-back" onClick={() => indexPaneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>← Browse modules</button>
        <section className="studio-brief"><div className="studio-brief-top"><div><div className="studio-kicker"><span>{selected.domain}</span><span className="studio-dot">·</span><code>{selected.id}</code></div><h2>{selected.capability}</h2><p className="studio-feature-coverage">{partlyIntegrated.has(selected.id) ? 'Partial domain workflow exists elsewhere in this app. The case register below is a prototype.' : 'Planned capability. The case register below is a prototype, not the specialist workflow.'}</p></div><button className="studio-primary" type="button" onClick={() => startDraft()}>＋ New case</button></div><div className="studio-brief-grid"><div><h3>Workflow brief</h3><p>{selected.workflow}</p></div><div><h3>Check for completion</h3><p>{selected.acceptance}</p></div></div><div className="studio-scope"><span>ACTIVE SCOPE</span><strong>{company?.name || 'Company'} · {selectedGstin?.gstin || 'GSTIN'} · {selectedBranch?.name || 'Branch'}</strong></div></section>
        {composer && <section className="studio-composer" aria-label={editingId ? 'Edit case' : 'New case'}><div className="studio-section-title"><div><span className="studio-step">01</span><div><h2>{editingId ? 'Edit draft' : 'Create a working case'}</h2><p>Capture the business facts and link a source for review.</p></div></div><button type="button" className="studio-quiet" onClick={() => setComposer(false)}>Cancel</button></div><form onSubmit={save} className="studio-form"><label><span>Case title <em>*</em></span><input required maxLength="160" value={form.title} onChange={event => setForm(current => ({ ...current, title: event.target.value }))} placeholder={`e.g. ${selected.capability} review`} /></label><label><span>Business reference <em>*</em></span><input required maxLength="100" value={form.reference} onChange={event => setForm(current => ({ ...current, reference: event.target.value }))} placeholder="Invoice, period, batch or request ID" /></label><label><span>Relevant date</span><input type="date" required value={form.date} onChange={event => setForm(current => ({ ...current, date: event.target.value }))} /></label><label><span>Indicative value (₹)</span><input inputMode="decimal" type="number" min="0" step="0.01" value={form.amount} onChange={event => setForm(current => ({ ...current, amount: event.target.value }))} placeholder="Optional" /></label>{inputs.map(field => <label key={field.key}><span>{field.label}</span><input maxLength="200" value={form.fields[field.key] || ''} onChange={event => setForm(current => ({ ...current, fields: { ...current.fields, [field.key]: event.target.value } }))} placeholder={`Enter ${field.label.toLowerCase()}`} /></label>)}<label className="studio-wide"><span>Evidence reference</span><input maxLength="300" value={form.evidenceReference} onChange={event => setForm(current => ({ ...current, evidenceReference: event.target.value }))} placeholder="File name, document link, register ID or source reference" /><small>Reference only. No document is uploaded from this prototype.</small></label><label className="studio-wide"><span>Facts, exception or proposed next step <em>*</em></span><textarea required maxLength="2000" rows="4" value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} placeholder={`Describe the ${selected.domain.toLowerCase()} facts, what needs checking, and the expected handoff.`} /></label><div className="studio-form-footer"><span>Saving creates a draft; no specialist transaction is posted.</span><button type="submit" className="studio-primary" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Save draft case'}</button></div></form></section>}
        <section className="studio-cases"><div className="studio-section-title"><div><span className="studio-step">02</span><div><h2>Case register</h2><p>Persisted work for this capability and selected business scope.</p></div></div><span className="studio-case-count">{cases.length} cases</span></div>{loading ? <div className="studio-empty">Loading saved cases…</div> : !cases.length ? <div className="studio-empty"><span aria-hidden="true">▤</span><strong>No cases in this scope yet</strong><p>Open a case to demonstrate this workflow with its own facts and evidence.</p><button className="studio-secondary" type="button" onClick={() => startDraft()}>Create first case</button></div> : <div className="studio-case-list">{cases.map(record => <button type="button" className={`studio-case-row ${selectedCaseId === record.id ? 'active' : ''}`} key={record.id} onClick={() => setSelectedCaseId(record.id)}><span className="studio-case-icon">{record.status === 'approved' ? '✓' : record.status === 'rejected' ? '↶' : record.status === 'submitted' ? '↗' : '▤'}</span><span className="studio-case-main"><strong>{record.title}</strong><small>{record.reference} · {record.date || 'No date'}</small></span><span className={`studio-status ${record.status}`}>{titleCase(record.status)}</span><span className="studio-case-open">View →</span></button>)}</div>}</section>
        {activeCase && <section className="studio-case-detail"><div className="studio-section-title"><div><span className="studio-step">03</span><div><h2>{activeCase.title}</h2><p>{activeCase.reference} · Created {dateTime(activeCase.createdAt)}</p></div></div><button className="studio-quiet" type="button" onClick={() => setSelectedCaseId(null)}>Close</button></div><div className="studio-detail-summary"><span className={`studio-status ${activeCase.status}`}>{titleCase(activeCase.status)}</span><span>Case #{activeCase.id}</span><span>{rupees(activeCase.amountCents)} indicative</span></div><div className="studio-facts"><div><span>Business reference</span><strong>{activeCase.reference}</strong></div><div><span>Relevant date</span><strong>{activeCase.date || '—'}</strong></div>{inputs.map(field => <div key={field.key}><span>{field.label}</span><strong>{activeCase.fields?.[field.key] || '—'}</strong></div>)}<div className="studio-wide"><span>Evidence reference</span><strong>{activeCase.evidenceReference || 'No evidence reference recorded'}</strong></div><div className="studio-wide"><span>Facts and proposed next step</span><p>{activeCase.notes}</p></div>{activeCase.reviewReason && <div className="studio-wide studio-review-reason"><span>Review reason</span><p>{activeCase.reviewReason}</p></div>}</div><div className="studio-actions">{activeCase.status === 'draft' && <><button type="button" className="studio-secondary" onClick={() => startDraft(activeCase)}>Edit draft</button><button type="button" className="studio-primary" disabled={busy} onClick={() => transition('submit')}>Submit for review</button></>}{activeCase.status === 'submitted' && canReview && <><button type="button" className="studio-primary" disabled={busy} onClick={() => transition('approve')}>Approve case</button><label className="studio-reject"><span className="sr-only">Rejection reason</span><input value={rejectionReason} onChange={event => setRejectionReason(event.target.value)} placeholder="Reason for rejection" maxLength="500" /><button type="button" disabled={busy || !rejectionReason.trim()} onClick={() => transition('reject')}>Reject with reason</button></label></>}{activeCase.status === 'submitted' && !canReview && <span className="studio-awaiting">Waiting for accountant or admin review.</span>}{['approved', 'rejected'].includes(activeCase.status) && <span className="studio-awaiting">Review recorded. This prototype has not posted specialist effects.</span>}</div><div className="studio-history"><h3>Activity history</h3>{eventsLoading ? <p>Loading history…</p> : events.length ? <ol>{events.map(event => <li key={event.id}><span className="studio-history-dot" /><div><strong>{titleCase(event.action || event.type)}</strong><p>{event.details || event.reason || 'Status changed'}</p><small>{dateTime(event.createdAt)} · Demo user #{event.actorId || event.userId || '—'}</small></div></li>)}</ol> : <p>History will appear as this case progresses.</p>}</div></section>}
      </div>
    </div>
  </div>;
}
