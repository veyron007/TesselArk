import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkspaceRoute, readWorkspaceScope, resolveWorkspaceScope, workspaceUrl } from '../src/workspace-route.js';

test('workspace routes restore pages and supported source records from direct URLs', () => {
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/orders?record=42')), { page: 'orders', recordId: 42 });
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/operations?record=7')), { page: 'operations', recordId: 7 });
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/documents?record=7')), { page: 'documents', recordId: 7 });
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/invoice-checks?record=7')), { page: 'invoice-checks', recordId: 7 });
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/budgets')), { page: 'budgets', recordId: null });
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/expenses?gstin=1&branch=2')), { page: 'expenses', recordId: null });
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/?page=coverage')), { page: 'coverage', recordId: null });
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/app')), { page: 'dashboard', recordId: null });
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/unknown?record=1')), { page: 'dashboard', recordId: null });
  assert.deepEqual(readWorkspaceRoute(new URL('http://localhost:3001/orders?record=bad')), { page: 'orders', recordId: null });
});

test('workspace URLs are bookmarkable and keep unrelated query settings', () => {
  const current = 'http://localhost:3001/orders?record=42&preview=1#main-content';
  assert.equal(workspaceUrl('operations', 7, current), '/operations?preview=1&record=7');
  assert.equal(workspaceUrl('dashboard', null, current), '/app?preview=1');
  assert.equal(workspaceUrl('coverage', null, current), '/coverage?preview=1');
  assert.equal(workspaceUrl('expenses', null, current, { gstinId: 1, branchId: 2 }), '/expenses?preview=1&gstin=1&branch=2');
  assert.equal(workspaceUrl('invoice-checks', 7, current), '/invoice-checks?preview=1&record=7');
  assert.equal(workspaceUrl('operations', 7, current, { gstinId: 1, branchId: 2 }),
    '/operations?preview=1&record=7&gstin=1&branch=2');
});

test('bookmarked branch scope accepts only positive identifiers', () => {
  assert.deepEqual(readWorkspaceScope(new URL('http://localhost/orders?gstin=1&branch=2')),
    { gstinId: 1, branchId: 2 });
  assert.deepEqual(readWorkspaceScope(new URL('http://localhost/orders?gstin=bad&branch=-1')),
    { gstinId: null, branchId: null });
});

test('history scope restores only a branch belonging to the permitted company', () => {
  const company = { gstins:[{ id:1 }, { id:2 }], branches:[{ id:1, gstinId:1 }, { id:3, gstinId:2 }] };
  assert.deepEqual(resolveWorkspaceScope(company, { gstinId:1, branchId:3 }), { gstinId:2, branchId:3 });
  assert.deepEqual(resolveWorkspaceScope(company, { gstinId:2, branchId:999 }), { gstinId:2, branchId:3 });
  assert.deepEqual(resolveWorkspaceScope(company, { gstinId:999, branchId:999 }), { gstinId:1, branchId:1 });
  assert.deepEqual(resolveWorkspaceScope({ gstins:[{ id:1 }], branches:[{ id:1, gstinId:1 }] },
    { gstinId:2, branchId:3 }), { gstinId:1, branchId:1 });
});
