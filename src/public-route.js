export function readEntryRoute(location) {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/demo') return 'demo';
  if (path === '/' && !new URLSearchParams(location.search).has('page')) return 'landing';
  return 'workspace';
}
