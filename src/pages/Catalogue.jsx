import { useCallback, useEffect, useMemo, useState } from 'react';
import './catalogue.css';

const emptyFilters = { q: '', categoryId: '', tag: '', salt: '', parameterKey: '', parameterValue: '', newOnly: false };
const emptyEditor = { categoryId: '', productKind: 'general', salt: '', tags: '', parameters: '', launchedOn: '', sourceReference: '', changeReason: '' };
const fromItem = item => ({ categoryId: item.categoryId || '', productKind: item.productKind, salt: item.salt || '', tags: item.tags.join(', '), parameters: item.parameters.map(row => `${row.key}: ${row.value}`).join('\n'), launchedOn: item.launchedOn || '', sourceReference: item.sourceReference || '', changeReason: '' });

export default function Catalogue({ context = {}, refresh }) {
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [audit, setAudit] = useState(null);
  const [editor, setEditor] = useState(emptyEditor);
  const [categoryName, setCategoryName] = useState('');
  const [categorySource, setCategorySource] = useState('');
  const [suggestion, setSuggestion] = useState({ substituteItemId: '', reason: '', sourceReference: '' });
  const [candidateQuery, setCandidateQuery] = useState('');
  const [candidateItems, setCandidateItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canCurate = context.role === 'admin';
  const company = context.bootstrap?.companies?.find(row => String(row.id) === String(context.companyId));
  const branch = company?.branches?.find(row => String(row.id) === String(context.branchId));
  const gstin = company?.gstins?.find(row => String(row.id) === String(context.gstinId));
  const request = useCallback(async (path, init = {}) => {
    const response = context.apiFetch ? await context.apiFetch(path, init) : await fetch(path, { ...init, headers: { 'content-type': 'application/json', 'x-company-id': String(context.companyId), 'x-user-id': String(context.userId), ...init.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [context.apiFetch, context.companyId, context.userId]);
  const searchPath = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(applied).forEach(([key, value]) => { if (value !== '' && value !== false) params.set(key, String(value)); });
    return `/api/catalogue/items?${params}`;
  }, [applied]);
  const loadList = useCallback(async () => {
    const [categoryData, itemData] = await Promise.all([request('/api/catalogue/categories'), request(searchPath)]);
    setCategories(categoryData.categories || []);
    setItems(itemData.items || []);
    setTotal(itemData.total || 0);
  }, [request, searchPath]);
  const loadDetail = useCallback(async id => {
    const data = await request(`/api/catalogue/items/${id}`);
    setDetail(data);
    setEditor(fromItem(data.item));
  }, [request]);
  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    Promise.all([request('/api/catalogue/categories'), request(searchPath)]).then(([categoryData, itemData]) => {
      if (!live) return;
      setCategories(categoryData.categories || []); setItems(itemData.items || []); setTotal(itemData.total || 0);
    }).catch(cause => { if (live) setError(cause.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [request, searchPath]);
  useEffect(() => { setSelectedId(null); setDetail(null); setAudit(null); setFilters(emptyFilters); setApplied(emptyFilters); }, [context.companyId, context.userId]);
  useEffect(() => {
    if (!canCurate || !detail) { setCandidateItems([]); return; }
    let live = true;
    request(`/api/catalogue/items?q=${encodeURIComponent(candidateQuery)}`).then(data => { if (live) setCandidateItems(data.items || []); }).catch(cause => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [canCurate, detail?.item.id, candidateQuery, request]);
  const select = async id => {
    setSelectedId(id); setDetail(null); setAudit(null); setCandidateQuery(''); setSuggestion({ substituteItemId: '', reason: '', sourceReference: '' }); setError('');
    try { await loadDetail(id); } catch (cause) { setError(cause.message); }
  };
  const mutate = async (path, method, body, message, after) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(path, { method, body: JSON.stringify(body) });
      await loadList();
      if (selectedId) { await loadDetail(selectedId); if (audit) setAudit((await request(`/api/catalogue/audit?itemId=${selectedId}`)).events); }
      setNotice(message); refresh?.(); after?.(result);
      return result;
    } catch (cause) { setError(cause.message); return null; }
    finally { setBusy(false); }
  };
  const saveMetadata = async event => {
    event.preventDefault();
    try {
      const tags = editor.tags.split(',').map(value => value.trim()).filter(Boolean);
      const parameters = editor.parameters.split('\n').map(value => value.trim()).filter(Boolean).map(line => {
        const colon = line.indexOf(':');
        if (colon < 1 || colon === line.length - 1) throw new Error('Each parameter must use “name: value”.');
        return { key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
      });
      await mutate(`/api/catalogue/items/${selectedId}`, 'PUT', { categoryId: editor.categoryId ? Number(editor.categoryId) : null, productKind: editor.productKind, salt: editor.salt, tags, parameters, launchedOn: editor.launchedOn || null, sourceReference: editor.sourceReference, changeReason: editor.changeReason }, 'Catalogue metadata saved with its source and audit record.');
    } catch (cause) { setError(cause.message); }
  };
  const alternatives = candidateItems.filter(item => item.id !== selectedId && item.active && item.productKind === detail?.item.productKind);
  const update = (setter, key, value) => setter(previous => ({ ...previous, [key]: value }));

  return <section className="catalogue-page">
    <header className="catalogue-header"><div><span className="eyebrow">ITEM DISCOVERY · ERP-001</span><h1>Catalogue</h1><p>Find the exact item record, review its source, and inspect curated suggestions before any order change.</p></div><div className="catalogue-scope"><strong>{company?.name || 'Selected company'}</strong><span>{gstin?.gstin || 'GSTIN scope'} · {branch?.name || 'Branch scope'}</span><small>{canCurate ? 'Company admin · catalogue steward' : `${context.role || 'Reader'} · view only`}</small></div></header>
    <p className="catalogue-safety" role="note"><strong>Product safety:</strong> Suggestions are not clinical equivalence or permission to replace an ordered item. Confirm product identity and obtain appropriate human approval before changing an order.</p>
    {error && <div className="catalogue-error" role="alert">{error}</div>}
    {notice && <div className="catalogue-notice" role="status">{notice}</div>}
    <form className="catalogue-search" onSubmit={event => { event.preventDefault(); setApplied({ ...filters }); }}>
      <div className="catalogue-search-title"><h2>Find items</h2><span>Search by name, SKU, category, label ingredient, tag, or parameter.</span></div>
      <label className="catalogue-wide">Search<input value={filters.q} maxLength="100" onChange={event => update(setFilters, 'q', event.target.value)} placeholder="Name, SKU, category, tag, parameter…" /></label>
      <label>Category<select value={filters.categoryId} onChange={event => update(setFilters, 'categoryId', event.target.value)}><option value="">All categories</option>{categories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label>Exact tag<input value={filters.tag} maxLength="40" onChange={event => update(setFilters, 'tag', event.target.value)} placeholder="e.g. Diabetes" /></label>
      <label>Label ingredient / salt<input value={filters.salt} maxLength="160" onChange={event => update(setFilters, 'salt', event.target.value)} placeholder="Label text" /></label>
      <label>Parameter name<input value={filters.parameterKey} maxLength="50" onChange={event => update(setFilters, 'parameterKey', event.target.value)} placeholder="e.g. pack size" /></label>
      <label>Parameter value<input value={filters.parameterValue} maxLength="120" onChange={event => update(setFilters, 'parameterValue', event.target.value)} placeholder="Contains…" /></label>
      <label className="catalogue-check"><input type="checkbox" checked={filters.newOnly} onChange={event => update(setFilters, 'newOnly', event.target.checked)} /> New in the last 90 days</label>
      <div className="catalogue-actions"><button type="submit" disabled={loading}>Apply filters</button><button type="button" className="catalogue-secondary" onClick={() => { setFilters(emptyFilters); setApplied(emptyFilters); }}>Clear</button></div>
    </form>
    <div className="catalogue-layout"><section className="catalogue-results" aria-label="Catalogue results"><div className="catalogue-section-head"><h2>Results</h2><span>{loading ? 'Loading…' : `${total} matching item${total === 1 ? '' : 's'}${total > 100 ? ' · first 100 shown' : ''}`}</span></div>
      {!loading && items.length === 0 && <p className="catalogue-empty">No items match these filters. Try a broader term or clear a filter.</p>}
      <div className="catalogue-result-list">{items.map(item => <button type="button" key={item.id} className={`catalogue-result ${selectedId === item.id ? 'selected' : ''}`} onClick={() => select(item.id)} aria-pressed={selectedId === item.id}><span><strong>{item.name}</strong><small>{item.sku} · Item #{item.id} · {item.unit}</small></span><span className="catalogue-badges">{item.categoryName && <em>{item.categoryName}</em>}{item.launchedOn && Date.now() - Date.parse(`${item.launchedOn}T00:00:00Z`) <= 90 * 86400000 && <em>New</em>}{item.productKind === 'medicinal' && <em>Medicine label</em>}</span></button>)}</div>
    </section><section className="catalogue-detail" aria-label="Selected item"><div className="catalogue-section-head"><h2>Selected item</h2>{selectedId && <span>Identity retained as item #{selectedId}</span>}</div>
      {!selectedId && <p className="catalogue-empty">Select a result to inspect its identity and curated suggestions.</p>}
      {selectedId && !detail && <p className="catalogue-empty">Loading item…</p>}
      {detail && <><div className="catalogue-identity"><span className="catalogue-kicker">{detail.item.sku} · #{detail.item.id}</span><h3>{detail.item.name}</h3><p>{detail.item.categoryName || 'Uncategorised'} · {detail.item.productKind === 'medicinal' ? 'Medicinal label' : 'General item'}</p><dl><div><dt>HSN</dt><dd>{detail.item.hsn || '—'}</dd></div><div><dt>Unit</dt><dd>{detail.item.unit}</dd></div><div><dt>Launched</dt><dd>{detail.item.launchedOn || 'Not recorded'}</dd></div><div><dt>Source</dt><dd>{detail.item.sourceReference || 'No catalogue metadata yet'}</dd></div></dl></div>
        {detail.item.salt && <p><strong>Label ingredient / salt:</strong> {detail.item.salt}</p>}
        {!!detail.item.tags.length && <p><strong>Tags:</strong> {detail.item.tags.join(' · ')}</p>}
        {!!detail.item.parameters.length && <div><strong>Parameters</strong><ul>{detail.item.parameters.map(row => <li key={row.key}>{row.key}: {row.value}</li>)}</ul></div>}
        <div className="catalogue-suggestions"><h3>Curated suggestions</h3><p>For manual review only. The ordered item stays #{detail.item.id} until a user explicitly edits an order.</p>{detail.substitutes.filter(row => row.active).length === 0 ? <p className="catalogue-empty">No active suggestions are recorded.</p> : <ul>{detail.substitutes.filter(row => row.active).map(row => <li key={row.id}><strong>{row.substitute.sku} · {row.substitute.name}</strong><span>Item #{row.substituteItemId} · {row.reason}</span><small>Source: {row.sourceReference} · Steward #{row.updatedBy}</small>{canCurate && <button type="button" disabled={busy} onClick={() => mutate(`/api/catalogue/substitutes/${row.id}`, 'PATCH', { active: false, sourceReference: row.sourceReference, changeReason: 'Retired in catalogue' }, 'Suggestion retired; the source item identity remains unchanged.')}>Retire suggestion</button>}</li>)}</ul>}</div>
        {canCurate && <details className="catalogue-steward"><summary>Steward tools and audit</summary><form onSubmit={saveMetadata}><h3>Edit discovery metadata</h3><label>Category<select value={editor.categoryId} onChange={event => update(setEditor, 'categoryId', event.target.value)}><option value="">Uncategorised</option>{categories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>Product kind<select value={editor.productKind} onChange={event => update(setEditor, 'productKind', event.target.value)}><option value="general">General item</option><option value="medicinal">Medicinal label</option></select></label><label>Label ingredient / salt<input value={editor.salt} disabled={editor.productKind !== 'medicinal'} onChange={event => update(setEditor, 'salt', event.target.value)} maxLength="160" /></label><label>Tags, comma separated<input value={editor.tags} onChange={event => update(setEditor, 'tags', event.target.value)} /></label><label>Parameters, one name: value per line<textarea value={editor.parameters} onChange={event => update(setEditor, 'parameters', event.target.value)} rows="3" /></label><label>Launch date<input type="date" max={new Date().toISOString().slice(0, 10)} value={editor.launchedOn} onChange={event => update(setEditor, 'launchedOn', event.target.value)} /></label><label>Source reference<input required maxLength="200" value={editor.sourceReference} onChange={event => update(setEditor, 'sourceReference', event.target.value)} placeholder="Supplier label or internal review reference" /></label><label>Reason for change<input required maxLength="500" value={editor.changeReason} onChange={event => update(setEditor, 'changeReason', event.target.value)} /></label><button disabled={busy}>Save metadata</button></form>
          <form onSubmit={event => { event.preventDefault(); mutate('/api/catalogue/substitutes', 'POST', { itemId: selectedId, substituteItemId: Number(suggestion.substituteItemId), reason: suggestion.reason, sourceReference: suggestion.sourceReference }, 'Suggestion recorded for manual review.', () => setSuggestion({ substituteItemId: '', reason: '', sourceReference: '' })); }}><h3>Add a curated suggestion</h3><label>Find suggested item<input value={candidateQuery} maxLength="100" onChange={event => setCandidateQuery(event.target.value)} placeholder="Search name, SKU, tag, parameter…" /></label><label>Suggested item<select required value={suggestion.substituteItemId} onChange={event => update(setSuggestion, 'substituteItemId', event.target.value)}><option value="">Choose same-kind item</option>{alternatives.map(item => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></label><label>Reason<input required maxLength="500" value={suggestion.reason} onChange={event => update(setSuggestion, 'reason', event.target.value)} placeholder="Why staff should review this item" /></label><label>Source reference<input required maxLength="200" value={suggestion.sourceReference} onChange={event => update(setSuggestion, 'sourceReference', event.target.value)} /></label><button disabled={busy || !alternatives.length}>Record suggestion</button></form>
          <button type="button" className="catalogue-secondary" onClick={async () => { try { const result = await request(`/api/catalogue/audit?itemId=${selectedId}`); setAudit(result.events); } catch (cause) { setError(cause.message); } }}>View audit trail</button>{audit && (audit.length ? <ol className="catalogue-audit">{audit.map(row => <li key={row.id}><strong>{row.action.replaceAll('_', ' ')}</strong><span>{row.changeReason}</span><small>Source: {row.sourceReference} · Steward #{row.actorId} · {row.createdAt}</small></li>)}</ol> : <p className="catalogue-empty">No catalogue changes recorded for this item.</p>)}</details>}
      </>}
    </section></div>
    {canCurate && <details className="catalogue-category-tools"><summary>Create a category</summary><form onSubmit={event => { event.preventDefault(); mutate('/api/catalogue/categories', 'POST', { name: categoryName, sourceReference: categorySource }, 'Category created with its source.', () => { setCategoryName(''); setCategorySource(''); }); }}><label>Category name<input required maxLength="80" value={categoryName} onChange={event => setCategoryName(event.target.value)} /></label><label>Source reference<input required maxLength="200" value={categorySource} onChange={event => setCategorySource(event.target.value)} /></label><button disabled={busy}>Create category</button></form></details>}
  </section>;
}
