const STORAGE_KEY = 'tesselark-demo-selection';

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function readDemoSelection(storage) {
  try {
    const saved = JSON.parse((storage || globalThis.sessionStorage).getItem(STORAGE_KEY) || 'null');
    const companyId = positiveId(saved?.companyId);
    const userId = positiveId(saved?.userId);
    return companyId && userId ? { companyId, userId } : null;
  } catch {
    return null;
  }
}

export function saveDemoSelection(selection, storage) {
  const companyId = positiveId(selection?.companyId);
  const userId = positiveId(selection?.userId);
  if (!companyId || !userId) return false;
  try {
    (storage || globalThis.sessionStorage).setItem(STORAGE_KEY, JSON.stringify({ companyId, userId }));
    return true;
  } catch {
    return false;
  }
}
