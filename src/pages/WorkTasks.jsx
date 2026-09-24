import { useCallback, useEffect, useMemo, useState } from 'react';
import './WorkTasks.css';

const currentPeriod = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};
const localToday = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const dateText = (value) => value ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not set';
const periodText = (value) => /^\d{4}-\d{2}$/.test(String(value || '')) ? new Date(`${value}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : value || 'No period';
const statusText = (value) => ({ open: 'In preparation', submitted: 'Ready for review', closed: 'Closed locally', draft: 'Draft', approved: 'Approved', pending: 'Pending review', rejected: 'Rejected', reviewed: 'Locally reviewed' })[value] || String(value || 'Unknown');
const gstPeriodStatusText = (value) => ({ open: 'Open', reviewed: 'Locally reviewed', approved: 'Locally approved' })[value] || String(value || 'Unknown');
const clean = (value) => String(value || '').trim();
const taskEvidence = (task) => Array.isArray(task?.evidence) ? task.evidence : [];
const checklist = (task) => Array.isArray(task?.checklist) ? task.checklist : [];
const templateScope = (item, branchId) => item.scopeType === 'gstin' || String(item.branchId) === String(branchId);
const describeScope = (item, branchName) => item.scopeType === 'gstin' ? 'Registration-wide' : branchName || 'Branch';
const isPastDue = (item) => item.status !== 'closed' && Boolean(item.internalTargetDate && item.internalTargetDate < localToday());
const fileContent = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('Could not read the selected file.'));
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.readAsDataURL(file);
});
const checklistFromText = (value) => clean(value).split('\n').map(clean).filter(Boolean).map((label, index) => ({ key: `step-${index + 1}`, label }));
const checklistToText = (items) => (items || []).map((item) => item.label).join('\n');
const mimeForFile = (file) => ({ pdf: 'application/pdf', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' })[file.name.split('.').pop()?.toLowerCase()] || file.type;
const emptyTemplate = () => ({ scopeType: 'gstin', title: '', obligationKey: '', recurrence: 'monthly', checklistText: '', dependencyTemplateIds: [] });
const emptyGeneration = () => ({ period: currentPeriod(), preparerUserId: '', reviewerUserId: '', internalTargetDate: '', statutoryDueDate: '', sourceTitle: '', sourceUrl: '', effectiveDate: '', verifiedAt: '', appliesTo: '' });

function Badge({ status }) { return <span className={`wt-badge ${status || 'unknown'}`}>{statusText(status)}</span>; }

export default function WorkTasks({ context = {}, refresh, initialTaskId, onNavigate }) {
  const { companyId, gstinId, branchId, userId, role, bootstrap, apiFetch } = context;
  const company = bootstrap?.companies?.find((item) => String(item.id) === String(companyId));
  const gstin = company?.gstins?.find((item) => String(item.id) === String(gstinId));
  const branch = company?.branches?.find((item) => String(item.id) === String(branchId));
  const bootstrapUsers = (bootstrap?.users || []).filter((item) => !item.companyId || String(item.companyId) === String(companyId));
  const [scopedUsers, setScopedUsers] = useState({ branch: [], gstin: [] });
  const [assigneeErrors, setAssigneeErrors] = useState({ branch: '', gstin: '' });
  const [assigneeLoading, setAssigneeLoading] = useState(true);
  const users = [...new Map([...bootstrapUsers, ...scopedUsers.gstin, ...scopedUsers.branch].map((item) => [item.id, item])).values()];
  const nameFor = (id) => users.find((item) => String(item.id) === String(id))?.name || (id ? `User #${id}` : 'Unassigned');
  const isReviewer = role === 'accountant' || role === 'admin';
  const canManageTemplates = isReviewer;
  const [view, setView] = useState('tasks');
  const [tasks, setTasks] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [taskId, setTaskId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [templateId, setTemplateId] = useState(null);
  const [templateForm, setTemplateForm] = useState(emptyTemplate);
  const [generation, setGeneration] = useState(emptyGeneration);
  const [checked, setChecked] = useState([]);
  const [reassign, setReassign] = useState({ preparerUserId: '', reviewerUserId: '', reason: '' });
  const [evidenceFile, setEvidenceFile] = useState(null);
  const [reason, setReason] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('active');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [overlaps, setOverlaps] = useState([]);

  const request = useCallback(async (path, options = {}) => {
    const response = await apiFetch(path, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const issue = new Error(result.error || result.message || `Work request failed (${response.status})`);
      issue.overlaps = result.overlaps || [];
      throw issue;
    }
    return result;
  }, [apiFetch]);

  useEffect(() => {
    const controller = new AbortController();
    if (!gstinId || !branchId) { setScopedUsers({ branch: [], gstin: [] }); setAssigneeLoading(false); return () => controller.abort(); }
    setAssigneeLoading(true);
    setAssigneeErrors({ branch: '', gstin: '' });
    const branchQuery = new URLSearchParams({ scopeType: 'branch', gstinId: String(gstinId), branchId: String(branchId) });
    const gstinQuery = new URLSearchParams({ scopeType: 'gstin', gstinId: String(gstinId) });
    Promise.allSettled([
      request(`/api/work/assignees?${branchQuery}`, { signal: controller.signal }),
      request(`/api/work/assignees?${gstinQuery}`, { signal: controller.signal }),
    ]).then(([branchResult, gstinResult]) => {
      if (controller.signal.aborted) return;
      setScopedUsers({
        branch: branchResult.status === 'fulfilled' && Array.isArray(branchResult.value.users) ? branchResult.value.users : [],
        gstin: gstinResult.status === 'fulfilled' && Array.isArray(gstinResult.value.users) ? gstinResult.value.users : [],
      });
      setAssigneeErrors({
        branch: branchResult.status === 'rejected' ? branchResult.reason.message : '',
        gstin: gstinResult.status === 'rejected' ? gstinResult.reason.message : '',
      });
      setAssigneeLoading(false);
    });
    return () => controller.abort();
  }, [companyId, gstinId, branchId, userId, request]);

  const reload = useCallback(async (signal) => {
    if (!gstinId || !branchId) { setTasks([]); setTemplates([]); setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ gstinId: String(gstinId) });
      const [taskResult, templateResult] = await Promise.all([
        request(`/api/work/tasks?${params}`, { signal }), request(`/api/work/templates?${params}`, { signal }),
      ]);
      if (signal?.aborted) return;
      if (!Array.isArray(taskResult.tasks) || !Array.isArray(templateResult.templates)) throw new Error('Task data is unavailable. Try again.');
      const inScopeTasks = taskResult.tasks.filter((item) => templateScope(item, branchId));
      const inScopeTemplates = templateResult.templates.filter((item) => templateScope(item, branchId));
      setTasks(inScopeTasks);
      setTemplates(inScopeTemplates);
      setTaskId((previous) => inScopeTasks.some((item) => item.id === previous) ? previous
        : initialTaskId ? (inScopeTasks.some((item) => item.id === initialTaskId) ? initialTaskId : null)
          : inScopeTasks[0]?.id ?? null);
      if (initialTaskId && !inScopeTasks.some((item) => item.id === initialTaskId)) setError('This task is not visible in the selected company, GSTIN and branch scope.');
      setTemplateId((previous) => inScopeTemplates.some((item) => item.id === previous) ? previous : inScopeTemplates[0]?.id ?? null);
    } catch (issue) {
      if (!signal?.aborted) { setError(issue.message || 'Could not load work tasks.'); setTasks([]); setTemplates([]); }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [gstinId, branchId, initialTaskId, request]);

  const loadDetail = useCallback(async (id, signal) => {
    if (!id) { setDetail(null); return; }
    setDetailLoading(true);
    try {
      const result = await request(`/api/work/tasks/${id}`, { signal });
      if (!signal?.aborted) setDetail(result.task || null);
    } catch (issue) {
      if (!signal?.aborted) { setDetail(null); setError(issue.message || 'Could not load task details.'); }
    } finally { if (!signal?.aborted) setDetailLoading(false); }
  }, [request]);

  useEffect(() => {
    const controller = new AbortController();
    setTaskId(null); setTemplateId(null); setDetail(null); setNotice(''); setOverlaps([]);
    reload(controller.signal);
    return () => controller.abort();
  }, [companyId, userId, initialTaskId, reload]);
  useEffect(() => { if (initialTaskId) setView('tasks'); }, [initialTaskId]);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    loadDetail(taskId, controller.signal);
    return () => controller.abort();
  }, [taskId, loadDetail]);
  useEffect(() => {
    setChecked(detail?.completedChecklistKeys || []);
    setReassign({ preparerUserId: detail?.preparerUserId || '', reviewerUserId: detail?.reviewerUserId || '', reason: '' });
    setReason(''); setEvidenceFile(null);
  }, [detail?.id, detail?.version]);
  useEffect(() => {
    if (detail?.id === initialTaskId && detail?.status === 'closed' && filter === 'active') setFilter('all');
  }, [detail?.id, detail?.status, initialTaskId, filter]);

  const selectedTemplate = templates.find((item) => item.id === templateId) || null;
  const generationUsers = scopedUsers[selectedTemplate?.scopeType] || [];
  const reassignUsers = scopedUsers[detail?.scopeType] || [];
  useEffect(() => {
    if (!selectedTemplate) return;
    setTemplateForm({ scopeType: selectedTemplate.scopeType, title: selectedTemplate.title, obligationKey: selectedTemplate.obligationKey,
      recurrence: selectedTemplate.recurrence, checklistText: checklistToText(selectedTemplate.checklist),
      dependencyTemplateIds: selectedTemplate.dependencyTemplateIds || [] });
  }, [selectedTemplate?.id, selectedTemplate?.version]);
  const visibleTasks = useMemo(() => tasks.filter((item) => {
    if (filter === 'active' && item.status === 'closed') return false;
    if (filter === 'closed' && item.status !== 'closed') return false;
    return `${item.title} ${item.obligationKey} ${item.period} ${nameFor(item.preparerUserId)}`.toLowerCase().includes(query.toLowerCase().trim());
  }), [tasks, filter, query, users]);
  const activeCount = tasks.filter((item) => item.status !== 'closed').length;
  const reviewCount = tasks.filter((item) => item.status === 'submitted').length;
  const overdueCount = tasks.filter(isPastDue).length;

  const perform = async (label, action, success) => {
    if (busy) return;
    setBusy(label); setError(''); setNotice(''); setOverlaps([]);
    try {
      const result = await action();
      await reload();
      const nextId = result?.task?.id || taskId;
      if (nextId) { setTaskId(nextId); await loadDetail(nextId); }
      if (result?.task?.id && result.task.id !== initialTaskId) onNavigate?.('work-tasks', result.task.id);
      if (result?.template?.id) setTemplateId(result.template.id);
      if (result?.overlaps?.length) setOverlaps(result.overlaps);
      setNotice(typeof success === 'function' ? success(result) : success);
      refresh?.();
    } catch (issue) { setError(issue.message || 'The action could not be completed.'); setOverlaps(issue.overlaps || []); }
    finally { setBusy(''); }
  };

  const saveTemplate = (event) => {
    event.preventDefault();
    const payload = {
      scopeType: templateForm.scopeType, gstinId: Number(gstinId),
      branchId: templateForm.scopeType === 'branch' ? Number(branchId) : null,
      title: clean(templateForm.title), obligationKey: clean(templateForm.obligationKey),
      recurrence: templateForm.recurrence, checklist: checklistFromText(templateForm.checklistText),
      dependencyTemplateIds: templateForm.dependencyTemplateIds.map(Number),
    };
    perform('save-template', async () => {
      const result = await request('/api/work/templates', { method: 'POST', body: JSON.stringify(payload) });
      setTemplateForm(emptyTemplate());
      return result;
    }, 'Draft template created. A different admin must approve it before period work can be generated.');
  };
  const versionTemplate = () => {
    if (!selectedTemplate) return;
    const payload = {
      expectedVersion: selectedTemplate.version, title: clean(templateForm.title),
      obligationKey: clean(templateForm.obligationKey), recurrence: templateForm.recurrence,
      checklist: checklistFromText(templateForm.checklistText),
      dependencyTemplateIds: templateForm.dependencyTemplateIds.map(Number),
    };
    perform('version-template', () => request(`/api/work/templates/${selectedTemplate.id}/versions`, { method: 'POST', body: JSON.stringify(payload) }), 'New draft version created. Existing period tasks retain their original template snapshot.');
  };
  const approveTemplate = () => {
    if (!selectedTemplate) return;
    perform('approve-template', () => request(`/api/work/templates/${selectedTemplate.id}/approve`, { method: 'POST', body: JSON.stringify({ expectedVersion: selectedTemplate.version, reason: clean(reason) }) }), 'Template version approved for period generation.');
  };
  const generateTask = (event) => {
    event.preventDefault();
    if (!selectedTemplate) return;
    const statutoryBasis = generation.statutoryDueDate ? {
      sourceTitle: clean(generation.sourceTitle), sourceUrl: clean(generation.sourceUrl),
      effectiveDate: generation.effectiveDate, verifiedAt: generation.verifiedAt, appliesTo: clean(generation.appliesTo),
    } : null;
    const payload = {
      templateId: selectedTemplate.id, period: generation.period,
      preparerUserId: Number(generation.preparerUserId), reviewerUserId: Number(generation.reviewerUserId),
      internalTargetDate: generation.internalTargetDate, statutoryDueDate: generation.statutoryDueDate || null, statutoryBasis,
    };
    perform('generate', () => request('/api/work/tasks/generate', { method: 'POST', body: JSON.stringify(payload) }), (result) => result.replayed
      ? 'This exact obligation and period already exists. The existing task is shown.'
      : 'Period task generated from the approved template snapshot.');
  };
  const taskAction = (action, payload, success) => {
    if (!detail) return;
    perform(action, () => request(`/api/work/tasks/${detail.id}/${action}`, { method: 'POST', body: JSON.stringify({ expectedVersion: detail.version, ...payload }) }), success);
  };
  const uploadEvidence = async (event) => {
    event.preventDefault();
    if (!detail || !evidenceFile) return;
    perform('upload', async () => {
      if (!evidenceFile.size || evidenceFile.size > 128 * 1024) throw new Error('Choose a nonempty file up to 128 KB.');
      const contentBase64 = await fileContent(evidenceFile);
      return request(`/api/work/tasks/${detail.id}/evidence`, { method: 'POST', body: JSON.stringify({ fileName: evidenceFile.name, mimeType: mimeForFile(evidenceFile), contentBase64 }) });
    }, 'Evidence attached to this task. A separate local review is required before closure.');
  };
  const reviewEvidence = (item, decision) => {
    if (!detail) return;
    perform(`evidence-${decision}`, () => request(`/api/work/tasks/${detail.id}/evidence/${item.id}/review`, { method: 'POST', body: JSON.stringify({ expectedVersion: item.version, expectedSha256: item.sha256, decision, reason: clean(reason) }) }), `Evidence ${decision} in the local task record.`);
  };
  const downloadEvidence = async (item) => {
    if (!detail) return;
    setError('');
    try {
      const result = await request(`/api/work/tasks/${detail.id}/evidence/${item.id}/download`);
      const bytes = Uint8Array.from(atob(result.contentBase64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.evidence.mimeType }));
      const link = document.createElement('a'); link.href = url; link.download = result.evidence.fileName; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (issue) { setError(issue.message || 'Could not download evidence.'); }
  };
  const closeTask = (item) => taskAction('close', { evidenceId: item.id, expectedEvidenceVersion: item.version, expectedEvidenceSha256: item.sha256, reason: clean(reason) }, 'Task closed locally with reviewed evidence. This does not sign or file a return.');
  const chosenEvidence = taskEvidence(detail)[0]?.status === 'approved' ? taskEvidence(detail)[0] : null;
  const evidenceIsFresh = Boolean(chosenEvidence && chosenEvidence.version > Number(detail?.reopenEvidenceVersion || 0));
  const canReviewTask = isReviewer && String(detail?.reviewerUserId) === String(userId) && String(detail?.preparerUserId) !== String(userId);
  const canApproveTemplate = role === 'admin' && selectedTemplate?.status === 'draft' && String(selectedTemplate.createdBy) !== String(userId);
  const scopeLabel = `${gstin?.gstin || 'GSTIN'} · ${branch?.name || 'Branch'}`;

  return <div className="wt-page">
    <header className="wt-hero">
      <div><span className="wt-kicker">WORKSPACE / WORK-02</span><h1>Work tasks</h1><p>Turn approved checklists into scoped period work. Keep owners, evidence, local review and source dates visible at every step.</p></div>
      <div className="wt-hero-context"><span>CURRENT CONTEXT</span><strong>{company?.name || 'Company'}</strong><small>{scopeLabel}</small><small>{nameFor(userId)} · {role || 'role'}</small></div>
    </header>
    <div className="wt-boundary"><span aria-hidden="true">◇</span><p>Task completion and GST period review are internal states. A statutory date is shown only with its recorded source basis. No task action signs or files a return.</p></div>
    {error && <div className="wt-message error" role="alert">{error} <button type="button" onClick={() => reload()}>Retry</button></div>}
    {notice && <div className="wt-message success" role="status">{notice}</div>}
    {overlaps.length > 0 && <div className="wt-overlaps" role="alert"><strong>Overlapping engagement</strong><p>Another obligation already covers this scope and period. Review the existing work before creating a new task.</p><ul>{overlaps.map((item) => <li key={item.id}>#{item.id} · {item.title} · {periodText(item.period)} · {statusText(item.status)}</li>)}</ul></div>}
    <div className="wt-stats" aria-label="Work task summary">
      <div><span>IN SCOPE</span><strong>{loading ? '—' : tasks.length}</strong><small>Registration and branch work</small></div>
      <div><span>ACTIVE</span><strong>{loading ? '—' : activeCount}</strong><small>Still being prepared or reviewed</small></div>
      <div><span>READY FOR REVIEW</span><strong>{loading ? '—' : reviewCount}</strong><small>Submitted checklists</small></div>
      <div><span>PAST INTERNAL TARGET</span><strong>{loading ? '—' : overdueCount}</strong><small>Not a statutory filing status</small></div>
    </div>
    <div className="wt-view-tabs" role="tablist" aria-label="Work task views">
      <button type="button" role="tab" aria-selected={view === 'tasks'} onClick={() => setView('tasks')}>Period tasks <span>{tasks.length}</span></button>
      <button type="button" role="tab" aria-selected={view === 'templates'} onClick={() => setView('templates')}>Task templates <span>{templates.filter((item) => item.approvedVersion).length}</span></button>
      <button type="button" className="wt-refresh" onClick={() => reload()} disabled={loading || Boolean(busy)}>↻ Refresh</button>
    </div>
    {view === 'tasks' ? <div className="wt-workspace">
      <section className="wt-panel wt-list-panel" aria-label="Period tasks">
        <div className="wt-panel-head"><div><span className="wt-kicker">01 / REGISTER</span><h2>Period work</h2></div><span>{visibleTasks.length} shown</span></div>
        <div className="wt-list-controls"><label className="wt-search"><span className="sr-only">Search tasks</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, period or owner" /></label><select aria-label="Task status" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="active">Active</option><option value="all">All tasks</option><option value="closed">Closed</option></select></div>
        {loading ? <p className="wt-empty" role="status">Loading scoped period work…</p> : visibleTasks.length ? <div className="wt-task-list">{visibleTasks.map((item) => <button type="button" key={item.id} className={`wt-task-row ${taskId === item.id ? 'selected' : ''}`} aria-current={taskId === item.id ? 'true' : undefined} onClick={() => { setTaskId(item.id); onNavigate?.('work-tasks', item.id); setNotice(''); }}><span className="wt-task-top"><span>{periodText(item.period)}</span><Badge status={item.status} /></span><strong>{item.title}</strong><small>{describeScope(item, branch?.name)} · v{item.templateVersion}</small><span className="wt-task-foot"><span>{nameFor(item.preparerUserId)}</span><span className={isPastDue(item) ? 'past-due' : ''}>Target {dateText(item.internalTargetDate)}</span></span></button>)}</div> : <div className="wt-empty"><strong>{tasks.length ? 'No tasks match this view' : 'No period tasks yet'}</strong><p>{tasks.length ? 'Change the status or search.' : 'Approve a template, then generate a task for a selected period.'}</p></div>}
      </section>
      <section className="wt-panel wt-detail-panel" aria-label="Task details">
        {detailLoading ? <p className="wt-empty" role="status">Loading task details…</p> : !detail ? <div className="wt-empty"><strong>Select a period task</strong><p>Its exact checklist, source state and review history will appear here.</p></div> : <>
          <div className="wt-detail-title"><div><span className="wt-kicker">TASK #{detail.id} · {periodText(detail.period)} · TEMPLATE V{detail.templateVersion}</span><h2>{detail.title}</h2><p>{describeScope(detail, branch?.name)} obligation · {detail.obligationKey}</p></div><Badge status={detail.status} /></div>
          <div className="wt-facts"><div><span>PREPARER</span><strong>{nameFor(detail.preparerUserId)}</strong></div><div><span>REVIEWER</span><strong>{nameFor(detail.reviewerUserId)}</strong></div><div><span>INTERNAL TARGET</span><strong className={isPastDue(detail) ? 'past-due' : ''}>{dateText(detail.internalTargetDate)}</strong></div><div><span>STATUTORY DATE</span><strong>{dateText(detail.statutoryDueDate)}</strong></div></div>
          {detail.statutoryDueDate ? <div className="wt-source-basis"><span className="wt-kicker">RECORDED DUE DATE BASIS</span><strong>{detail.statutoryBasis?.sourceTitle || 'Source title unavailable'}</strong><p>{detail.statutoryBasis?.appliesTo || 'Applicability not recorded'} · effective {dateText(detail.statutoryBasis?.effectiveDate)} · verified {dateText(detail.statutoryBasis?.verifiedAt)}</p>{/^https:\/\//.test(detail.statutoryBasis?.sourceUrl || '') && <a href={detail.statutoryBasis.sourceUrl} target="_blank" rel="noopener noreferrer">Open recorded source ↗</a>}</div> : <div className="wt-source-basis quiet"><strong>Internal target only</strong><p>No statutory date is attached to this task.</p></div>}
          {detail.scopeType === 'gstin' && <div className="wt-source-card"><div><span className="wt-kicker">SOURCE-LINKED STATE</span><h3>GST period · {periodText(detail.period)}</h3><p>{detail.source?.status ? `Local GST period: ${gstPeriodStatusText(detail.source.status)}.` : 'No matching local GST period record is currently linked.'} This task does not change the period’s review, signing or filing state.</p></div><a href={`/gst?gstin=${encodeURIComponent(gstinId)}&branch=${encodeURIComponent(branchId)}`}>Open GST workspace ↗</a></div>}
          {detail.scopeType === 'branch' && <div className="wt-source-basis quiet"><strong>Branch-local work</strong><p>This task has no linked GST period source. Its internal target and review do not affect registration-wide filing status.</p></div>}
          {Array.isArray(detail.dependencies) && detail.dependencies.length > 0 && <div className="wt-section"><span className="wt-kicker">DEPENDENCIES</span><ul className="wt-dependencies">{detail.dependencies.map((item, index) => <li key={item.id || index}>{item.title || `Template #${item.templateId || item.id}`} <small>{item.status ? statusText(item.status) : 'Dependency'}</small></li>)}</ul></div>}
          <div className="wt-section"><div className="wt-section-head"><div><span className="wt-kicker">02 / PREPARE</span><h3>Exact checklist</h3></div><small>{checked.length} / {checklist(detail).length} checked</small></div><div className="wt-checklist">{checklist(detail).map((item) => <label key={item.key} className={checked.includes(item.key) ? 'done' : ''}><input type="checkbox" checked={checked.includes(item.key)} disabled={detail.status !== 'open' || String(detail.preparerUserId) !== String(userId) || Boolean(busy)} onChange={() => setChecked((current) => current.includes(item.key) ? current.filter((key) => key !== item.key) : [...current, item.key])} /><span>{item.label}</span></label>)}</div>{detail.status === 'open' && <div className="wt-inline-actions"><button type="button" disabled={String(detail.preparerUserId) !== String(userId) || checked.length !== checklist(detail).length || Boolean(busy)} onClick={() => taskAction('submit', { completedChecklistKeys: checked }, 'Checklist submitted for independent local review.')}>Submit completed checklist</button><small>Only the assigned preparer can submit all steps.</small></div>}</div>
          <div className="wt-section"><div className="wt-section-head"><div><span className="wt-kicker">03 / VERIFY</span><h3>Evidence and review</h3></div><small>{taskEvidence(detail).length} attachment{taskEvidence(detail).length === 1 ? '' : 's'}</small></div><form className="wt-evidence-upload" onSubmit={uploadEvidence}><label>Attach local evidence file<input type="file" accept=".pdf,.txt,.png,.jpg,.jpeg" onChange={(event) => setEvidenceFile(event.target.files?.[0] || null)} /></label><button type="submit" disabled={!evidenceFile || String(detail.preparerUserId) !== String(userId) || detail.status === 'closed' || Boolean(busy)}>Attach evidence</button></form><p className="wt-help">Maximum 128 KB. Uploaded evidence needs a separate review before it can support closure.</p>{taskEvidence(detail).length ? <div className="wt-evidence-list">{taskEvidence(detail).map((item) => <div key={item.id}><div><strong>{item.fileName}</strong><small>Version {item.version} · {statusText(item.status)}</small><button className="wt-download" type="button" onClick={() => downloadEvidence(item)}>Download file</button></div>{item.status === 'pending' && item.id === taskEvidence(detail)[0]?.id && canReviewTask && String(item.uploadedBy) !== String(userId) && <div className="wt-evidence-actions"><button type="button" disabled={Boolean(busy)} onClick={() => reviewEvidence(item, 'approved')}>Approve</button><button className="secondary" type="button" disabled={Boolean(busy) || !clean(reason)} onClick={() => reviewEvidence(item, 'rejected')}>Reject</button></div>}</div>)}</div> : <p className="wt-empty compact">No evidence attached to this task.</p>}</div>
          <div className="wt-section wt-decision"><span className="wt-kicker">04 / DECIDE</span><h3>Review and ownership</h3><label>Reason for review, reassignment or reopening<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Record the decision or change" maxLength={500} /></label><div className="wt-inline-actions">{detail.status === 'submitted' && <button type="button" disabled={!canReviewTask || !evidenceIsFresh || !clean(reason) || Boolean(busy)} onClick={() => closeTask(chosenEvidence)}>Close with approved evidence</button>}{detail.status === 'closed' && <button type="button" disabled={role !== 'admin' || !clean(reason) || Boolean(busy)} onClick={() => taskAction('reopen', { reason: clean(reason) }, 'Task reopened locally. Attach and review a fresh evidence version before closing again; earlier decisions remain in history.')}>Reopen task</button>}<small>{detail.reopenEvidenceVersion && !evidenceIsFresh ? `A fresh evidence version after v${detail.reopenEvidenceVersion} must be uploaded and reviewed before closure.` : 'Closure requires the assigned independent reviewer and latest approved evidence.'}</small></div>{detail.status !== 'closed' && <div className="wt-reassign">{assigneeErrors[detail.scopeType] && <p className="wt-assignee-error" role="alert">Could not load permitted assignees: {assigneeErrors[detail.scopeType]}</p>}<label>Preparer<select value={reassign.preparerUserId} onChange={(event) => setReassign((current) => ({ ...current, preparerUserId: event.target.value }))}>{reassignUsers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><label>Reviewer<select value={reassign.reviewerUserId} onChange={(event) => setReassign((current) => ({ ...current, reviewerUserId: event.target.value }))}>{reassignUsers.filter((item) => ['accountant', 'admin'].includes(item.role)).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><button className="secondary" type="button" disabled={!isReviewer || assigneeLoading || Boolean(assigneeErrors[detail.scopeType]) || !clean(reason) || Boolean(busy)} onClick={() => taskAction('reassign', { preparerUserId: Number(reassign.preparerUserId), reviewerUserId: Number(reassign.reviewerUserId), reason: clean(reason) }, 'Task ownership changed. A fresh evidence version must be reviewed before closure; the decision is in history.')}>Reassign</button></div>}</div>
          <div className="wt-section wt-history"><span className="wt-kicker">AUDIT TRAIL</span><h3>Task history</h3>{detail.events?.length ? <ol>{detail.events.map((item) => <li key={item.id}><strong>{String(item.action).replaceAll('_', ' ')}</strong><span>{item.createdAt} · {nameFor(item.actorId)}</span>{item.details && <p>{typeof item.details === 'string' ? item.details : JSON.stringify(item.details)}</p>}</li>)}</ol> : <p className="wt-empty compact">No events recorded.</p>}</div>
        </>}
      </section>
    </div> : <div className="wt-workspace wt-template-workspace">
      <section className="wt-panel wt-list-panel" aria-label="Task templates"><div className="wt-panel-head"><div><span className="wt-kicker">01 / LIBRARY</span><h2>Template versions</h2></div><span>{templates.length} in scope</span></div>{loading ? <p className="wt-empty" role="status">Loading templates…</p> : templates.length ? <div className="wt-task-list">{templates.map((item) => <button type="button" key={item.id} className={`wt-task-row ${templateId === item.id ? 'selected' : ''}`} aria-current={templateId === item.id ? 'true' : undefined} onClick={() => { setTemplateId(item.id); setNotice(''); }}><span className="wt-task-top"><span>VERSION {item.version}</span><Badge status={item.status} /></span><strong>{item.title}</strong><small>{item.obligationKey} · {describeScope(item, branch?.name)}</small><span className="wt-task-foot"><span>{item.recurrence}</span><span>{item.checklist?.length || 0} steps</span></span></button>)}</div> : <div className="wt-empty"><strong>No templates in this scope</strong><p>Create a checklist draft to begin.</p></div>}</section>
      <div className="wt-template-main"><section className="wt-panel wt-template-detail" aria-label="Selected template"><div className="wt-panel-head"><div><span className="wt-kicker">02 / VERSION CONTROL</span><h2>{selectedTemplate?.title || 'Select a template'}</h2></div>{selectedTemplate && <Badge status={selectedTemplate.status} />}</div>{selectedTemplate ? <><p className="wt-help">{describeScope(selectedTemplate, branch?.name)} · {selectedTemplate.recurrence} · version {selectedTemplate.version}. Generated tasks retain the approved version used at creation.</p><ol className="wt-template-steps">{selectedTemplate.checklist?.map((item) => <li key={item.key}>{item.label}</li>)}</ol>{selectedTemplate.dependencyTemplateIds?.length > 0 && <p className="wt-help">Depends on template IDs: {selectedTemplate.dependencyTemplateIds.join(', ')}</p>}{selectedTemplate.status === 'draft' && selectedTemplate.approvedSnapshot && <div className="wt-approved-snapshot"><span className="wt-kicker">GENERATION SNAPSHOT · APPROVED V{selectedTemplate.approvedSnapshot.version}</span><strong>{selectedTemplate.approvedSnapshot.title}</strong><ol>{selectedTemplate.approvedSnapshot.checklist.map((item) => <li key={item.key}>{item.label}</li>)}</ol></div>}{selectedTemplate.status === 'draft' && <div className="wt-inline-actions"><button type="button" disabled={!canApproveTemplate || !clean(reason) || Boolean(busy)} onClick={approveTemplate}>Approve version</button><small>A different admin must approve with a reason.</small></div>}{selectedTemplate.status === 'draft' && <label className="wt-approval-reason">Approval reason<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Record approval basis" /></label>}{selectedTemplate.status === 'approved' && <p className="wt-approved-note">Approved by {nameFor(selectedTemplate.approvedBy)} · {selectedTemplate.approvedAt || 'date unavailable'}</p>}</> : <p className="wt-empty compact">Choose a version to inspect and generate period work.</p>}</section>
      {Boolean(selectedTemplate?.approvedVersion) && <section className="wt-panel wt-template-detail" aria-label="Generate period task"><span className="wt-kicker">03 / GENERATE · APPROVED V{selectedTemplate.approvedVersion}</span><h2>Create period work</h2>{selectedTemplate.status === 'draft' && <p className="wt-draft-note">Version {selectedTemplate.version} is a draft. This action uses approved version {selectedTemplate.approvedVersion}; the draft checklist above is not used.</p>}{assigneeErrors[selectedTemplate.scopeType] && <p className="wt-assignee-error" role="alert">Could not load permitted assignees: {assigneeErrors[selectedTemplate.scopeType]}</p>}<p className="wt-help">One approved obligation creates one active task per period and scope. Repeating the same request returns its existing task. Quarterly periods begin in January, April, July or October; annual periods begin in January.</p><form className="wt-form" onSubmit={generateTask}><label>Return period<input type="month" required value={generation.period} onChange={(event) => setGeneration((current) => ({ ...current, period: event.target.value }))} /></label><label>Internal target<input type="date" required value={generation.internalTargetDate} onChange={(event) => setGeneration((current) => ({ ...current, internalTargetDate: event.target.value }))} /></label><label>Preparer<select required value={generation.preparerUserId} onChange={(event) => setGeneration((current) => ({ ...current, preparerUserId: event.target.value }))}><option value="">Choose preparer</option>{generationUsers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><label>Independent reviewer<select required value={generation.reviewerUserId} onChange={(event) => setGeneration((current) => ({ ...current, reviewerUserId: event.target.value }))}><option value="">Choose reviewer</option>{generationUsers.filter((item) => ['accountant', 'admin'].includes(item.role)).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><label>Statutory due date, if applicable<input type="date" value={generation.statutoryDueDate} onChange={(event) => setGeneration((current) => ({ ...current, statutoryDueDate: event.target.value }))} /></label>{generation.statutoryDueDate && <><label>Source title<input required value={generation.sourceTitle} onChange={(event) => setGeneration((current) => ({ ...current, sourceTitle: event.target.value }))} /></label><label>Source URL<input type="url" required value={generation.sourceUrl} onChange={(event) => setGeneration((current) => ({ ...current, sourceUrl: event.target.value }))} placeholder="https://" /></label><label>Effective date<input type="date" required value={generation.effectiveDate} onChange={(event) => setGeneration((current) => ({ ...current, effectiveDate: event.target.value }))} /></label><label>Verified date<input type="date" required value={generation.verifiedAt} onChange={(event) => setGeneration((current) => ({ ...current, verifiedAt: event.target.value }))} /></label><label className="wide">Why this source applies<input required value={generation.appliesTo} onChange={(event) => setGeneration((current) => ({ ...current, appliesTo: event.target.value }))} /></label></>}<button type="submit" disabled={!canManageTemplates || assigneeLoading || Boolean(assigneeErrors[selectedTemplate.scopeType]) || Boolean(busy)}>Generate period task</button></form></section>}
      <section className="wt-panel wt-template-detail" aria-label="Create task template"><span className="wt-kicker">04 / AUTHOR</span><h2>{selectedTemplate?.status === 'approved' ? 'Create a new version or draft' : 'Create a draft template'}</h2><p className="wt-help">Write one checklist step per line. Approved versions are immutable; a new version starts as a draft. Registration-wide tasks use an exact monthly GST period source; longer recurrence belongs to branch-local internal work.</p><form className="wt-form" onSubmit={saveTemplate}><label>Scope<select value={templateForm.scopeType} onChange={(event) => setTemplateForm((current) => ({ ...current, scopeType: event.target.value, recurrence: event.target.value === 'gstin' && ['quarterly', 'annual'].includes(current.recurrence) ? 'monthly' : current.recurrence, dependencyTemplateIds: [] }))}><option value="gstin">Registration-wide GSTIN</option><option value="branch">Current branch</option></select></label><label>Recurrence<select value={templateForm.recurrence} onChange={(event) => setTemplateForm((current) => ({ ...current, recurrence: event.target.value, dependencyTemplateIds: [] }))}><option value="none">One period</option><option value="monthly">Monthly</option><option value="quarterly" disabled={templateForm.scopeType === 'gstin'}>Quarterly</option><option value="annual" disabled={templateForm.scopeType === 'gstin'}>Annual</option></select></label><label className="wide">Template title<input required maxLength={160} value={templateForm.title} onChange={(event) => setTemplateForm((current) => ({ ...current, title: event.target.value }))} placeholder="e.g. GST period preparation" /></label><label className="wide">Obligation key<input required maxLength={80} value={templateForm.obligationKey} onChange={(event) => setTemplateForm((current) => ({ ...current, obligationKey: event.target.value }))} placeholder="e.g. gst-period-review" /></label><label className="wide">Checklist steps<textarea required rows={5} value={templateForm.checklistText} onChange={(event) => setTemplateForm((current) => ({ ...current, checklistText: event.target.value }))} placeholder={'Confirm source period\nReview exception list\nAttach evidence'} /></label><fieldset className="wide wt-dependency-pick"><legend>Dependencies, if any</legend>{templates.filter((item) => item.status === 'approved' && item.id !== selectedTemplate?.id && item.scopeType === templateForm.scopeType && item.recurrence === templateForm.recurrence && (item.scopeType === 'gstin' || String(item.branchId) === String(branchId))).map((item) => <label key={item.id}><input type="checkbox" checked={templateForm.dependencyTemplateIds.includes(item.id)} onChange={(event) => setTemplateForm((current) => ({ ...current, dependencyTemplateIds: event.target.checked ? [...current.dependencyTemplateIds, item.id] : current.dependencyTemplateIds.filter((id) => id !== item.id) }))} />{item.title} · v{item.version}</label>)}{!templates.some((item) => item.status === 'approved' && item.id !== selectedTemplate?.id && item.scopeType === templateForm.scopeType && item.recurrence === templateForm.recurrence && (item.scopeType === 'gstin' || String(item.branchId) === String(branchId))) && <small>No other approved templates in scope.</small>}</fieldset><div className="wt-form-actions wide"><button type="submit" disabled={!canManageTemplates || Boolean(busy)}>Save new draft</button><button className="secondary" type="button" onClick={() => setTemplateForm(emptyTemplate())}>Clear editor</button>{selectedTemplate?.status === 'approved' && <button className="secondary" type="button" disabled={!canManageTemplates || !clean(templateForm.title) || !clean(templateForm.checklistText) || templateForm.obligationKey !== selectedTemplate.obligationKey || Boolean(busy)} onClick={versionTemplate}>Create next version from selected</button>}{selectedTemplate?.status === 'approved' && templateForm.obligationKey !== selectedTemplate.obligationKey && <small>Obligation key is fixed for a version. Save a separate draft for a new key.</small>}</div></form></section></div>
    </div>}
  </div>;
}
