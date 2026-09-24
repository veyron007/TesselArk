const pages = new Set([
  'dashboard', 'orders', 'delivery', 'order-crm', 'catalogue', 'operations', 'documents', 'master-import', 'batches', 'locations',
  'conversion', 'counts', 'consignment', 'pricing', 'price-adjustments',
  'supplier-comparison', 'bundles', 'credit', 'finance', 'accounting', 'bank',
  'cashier', 'reporting', 'budgets', 'returns', 'return-inspection',
  'return-settlement', 'return-tax', 'evidence', 'gst', 'invoice-checks', 'statement-import',
  'simulator', 'access-grants', 'coverage',
]);

const detailPages = new Set(['orders', 'operations', 'documents', 'invoice-checks']);

function validRecord(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function readWorkspaceRoute(location) {
  const pathname = location.pathname.replace(/^\/+|\/+$/g, '');
  const requested = pathname === 'app' ? 'dashboard' : pathname || new URLSearchParams(location.search).get('page') || 'dashboard';
  const page = pages.has(requested) ? requested : 'dashboard';
  const recordId = detailPages.has(page)
    ? validRecord(new URLSearchParams(location.search).get('record')) : null;
  return { page, recordId };
}

export function readWorkspaceScope(location) {
  const query = new URLSearchParams(location.search);
  return { gstinId: validRecord(query.get('gstin')), branchId: validRecord(query.get('branch')) };
}

export function resolveWorkspaceScope(company, preferred = {}) {
  const gstins = company?.gstins ?? [];
  const branches = company?.branches ?? [];
  const preferredBranch = branches.find(item => String(item.id) === String(preferred.branchId));
  const preferredGstin = gstins.find(item => String(item.id) === String(preferred.gstinId));
  const gstinId = preferredBranch?.gstinId ?? preferredGstin?.id ?? gstins[0]?.id ?? '';
  const branchId = preferredBranch?.id ?? branches.find(item => String(item.gstinId) === String(gstinId))?.id ?? '';
  return { gstinId, branchId };
}

export function workspaceUrl(page, recordId, currentUrl, scope = null) {
  const destination = new URL(currentUrl);
  const selectedPage = pages.has(page) ? page : 'dashboard';
  destination.pathname = selectedPage === 'dashboard' ? '/app' : `/${selectedPage}`;
  destination.searchParams.delete('page');
  destination.searchParams.delete('record');
  destination.searchParams.delete('gstin');
  destination.searchParams.delete('branch');
  const id = validRecord(String(recordId ?? ''));
  if (detailPages.has(selectedPage) && id !== null) destination.searchParams.set('record', String(id));
  const gstinId = validRecord(String(scope?.gstinId ?? ''));
  const branchId = validRecord(String(scope?.branchId ?? ''));
  if (gstinId !== null) destination.searchParams.set('gstin', String(gstinId));
  if (branchId !== null) destination.searchParams.set('branch', String(branchId));
  destination.hash = '';
  return `${destination.pathname}${destination.search}`;
}
