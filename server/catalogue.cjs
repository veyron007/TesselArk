const { installCatalogueSchema } = require('./catalogue-db.cjs');
const { assertCompanyWideAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const safetyNotice = 'Curated catalogue suggestions are not clinical equivalence or permission to replace an ordered item. Confirm product identity and obtain appropriate human approval before changing an order.';
const newnessDays = 90;
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const words = (value, name, max = 160, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(`${name} is invalid`);
  return value.trim();
};
const id = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw fail(`${name} must be a positive integer`);
  return number;
};
const day = value => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fail('launchedOn must be a valid YYYY-MM-DD date');
  return value;
};
const atomic = (db, action) => {
  db.exec('SAVEPOINT catalogue_action');
  try { const result = action(); db.exec('RELEASE catalogue_action'); return result; }
  catch (error) { db.exec('ROLLBACK TO catalogue_action'); db.exec('RELEASE catalogue_action'); throw error; }
};

function registerCatalogueRoutes(app, db) {
  installCatalogueSchema(db);
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const canRead = req => { if (!req.scopes.branchIds.length) throw fail('A branch grant is required for catalogue data', 403); };
  const steward = req => {
    canRead(req);
    if (req.user.role !== 'admin') throw fail('Company admin role required for catalogue curation', 403);
    assertCompanyWideAccess(db, { companyId: req.company.id, userId: req.user.id });
  };
  const itemRow = (req, value) => {
    const row = db.prepare('SELECT * FROM items WHERE id=? AND company_id=?').get(id(value, 'itemId'), req.company.id);
    if (!row) throw fail('Item not found in selected company', 404);
    return row;
  };
  const categoryRow = (req, value) => {
    const row = db.prepare('SELECT * FROM catalogue_categories WHERE id=? AND company_id=?').get(id(value, 'categoryId'), req.company.id);
    if (!row) throw fail('Category not found in selected company', 404);
    return row;
  };
  const detail = item => {
    const metadata = db.prepare('SELECT * FROM catalogue_item_details WHERE item_id=? AND company_id=?').get(item.id, item.company_id);
    const tags = db.prepare('SELECT tag FROM catalogue_item_tags WHERE item_id=? AND company_id=? ORDER BY tag').all(item.id, item.company_id).map(row => row.tag);
    const parameters = db.prepare('SELECT key,value FROM catalogue_item_parameters WHERE item_id=? AND company_id=? ORDER BY key').all(item.id, item.company_id);
    const categoryName = metadata?.category_id ? db.prepare('SELECT name FROM catalogue_categories WHERE id=? AND company_id=?').get(metadata.category_id, item.company_id)?.name || null : null;
    return { ...camel(item), categoryId: metadata?.category_id || null, categoryName, productKind: metadata?.product_kind || 'general', salt: metadata?.salt || '', launchedOn: metadata?.launched_on || null, sourceReference: metadata?.source_reference || null, updatedAt: metadata?.updated_at || null, tags, parameters };
  };
  const mapping = row => ({ ...camel(row), active: Boolean(row.active), safetyNotice });
  const event = (req, itemId, action, sourceReference, changeReason, snapshot) => db.prepare(`INSERT INTO catalogue_item_events
    (company_id,item_id,action,source_reference,change_reason,snapshot_json,actor_id) VALUES (?,?,?,?,?,?,?)`)
    .run(req.company.id, itemId, action, sourceReference, changeReason, JSON.stringify(snapshot), req.user.id);
  const normalizeList = (value, name, maxCount, convert) => {
    if (!Array.isArray(value) || value.length > maxCount) throw fail(`${name} must be an array of at most ${maxCount}`);
    return value.map(convert);
  };
  const uniqueBy = (array, key, name) => {
    const values = array.map(key);
    if (new Set(values).size !== values.length) throw fail(`${name} contains duplicates`);
    return array;
  };
  const parseMetadata = (req, body) => {
    const productKind = body.productKind;
    if (!['general', 'medicinal'].includes(productKind)) throw fail('productKind must be general or medicinal');
    const categoryId = body.categoryId === null || body.categoryId === undefined || body.categoryId === '' ? null : categoryRow(req, body.categoryId).id;
    const salt = words(body.salt ?? '', 'salt', 160, false);
    if (productKind === 'general' && salt) throw fail('Salt label requires medicinal productKind');
    const tags = uniqueBy(normalizeList(body.tags, 'tags', 12, tag => words(tag, 'tag', 40)), tag => tag.toLowerCase(), 'tags');
    const parameters = uniqueBy(normalizeList(body.parameters, 'parameters', 12, parameter => ({ key: words(parameter?.key, 'parameter key', 50), value: words(parameter?.value, 'parameter value', 120) })), parameter => parameter.key.toLowerCase(), 'parameters');
    const launchedOn = day(body.launchedOn ?? null);
    if (launchedOn && launchedOn > new Date().toISOString().slice(0, 10)) throw fail('launchedOn cannot be in the future');
    return { productKind, categoryId, salt, tags, parameters, launchedOn, sourceReference: words(body.sourceReference, 'sourceReference', 200), changeReason: words(body.changeReason, 'changeReason', 500) };
  };

  app.get('/api/catalogue/categories', route(req => {
    canRead(req);
    return { categories: db.prepare('SELECT * FROM catalogue_categories WHERE company_id=? ORDER BY name').all(req.company.id).map(camel) };
  }));
  app.post('/api/catalogue/categories', route(req => {
    steward(req);
    const name = words(req.body?.name, 'name', 80), sourceReference = words(req.body?.sourceReference, 'sourceReference', 200);
    const result = db.prepare('INSERT INTO catalogue_categories(company_id,name,source_reference,created_by) VALUES (?,?,?,?)').run(req.company.id, name, sourceReference, req.user.id);
    return { category: camel(db.prepare('SELECT * FROM catalogue_categories WHERE id=?').get(result.lastInsertRowid)) };
  }));
  app.get('/api/catalogue/items', route(req => {
    canRead(req);
    const query = words(req.query.q ?? '', 'q', 100, false).toLowerCase();
    const tag = words(req.query.tag ?? '', 'tag', 40, false).toLowerCase();
    const salt = words(req.query.salt ?? '', 'salt', 160, false).toLowerCase();
    const parameterKey = words(req.query.parameterKey ?? '', 'parameterKey', 50, false).toLowerCase();
    const parameterValue = words(req.query.parameterValue ?? '', 'parameterValue', 120, false).toLowerCase();
    const newOnly = req.query.newOnly === 'true';
    if (req.query.newOnly !== undefined && !['true', 'false'].includes(req.query.newOnly)) throw fail('newOnly must be true or false');
    const includeInactive = req.query.includeInactive === 'true';
    if (req.query.includeInactive !== undefined && !['true', 'false'].includes(req.query.includeInactive)) throw fail('includeInactive must be true or false');
    if (includeInactive) steward(req);
    const categoryId = req.query.categoryId === undefined ? null : categoryRow(req, req.query.categoryId).id;
    const substituteFor = req.query.substituteFor === undefined ? null : itemRow(req, req.query.substituteFor).id;
    const allowedSubstitutes = substituteFor === null ? null : new Set(db.prepare('SELECT substitute_item_id FROM catalogue_substitutes WHERE company_id=? AND item_id=? AND active=1').all(req.company.id, substituteFor).map(row => row.substitute_item_id));
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.parse(`${today}T00:00:00Z`) - newnessDays * 86400000).toISOString().slice(0, 10);
    const all = db.prepare('SELECT * FROM items WHERE company_id=? ORDER BY name,id').all(req.company.id).map(detail);
    const matched = all.filter(item => {
      if ((!includeInactive && !item.active) || (categoryId !== null && item.categoryId !== categoryId) || (allowedSubstitutes && !allowedSubstitutes.has(item.id))) return false;
      if (newOnly && (!item.launchedOn || item.launchedOn < start || item.launchedOn > today)) return false;
      if (tag && !item.tags.some(value => value.toLowerCase() === tag)) return false;
      if (salt && !item.salt.toLowerCase().includes(salt)) return false;
      if (parameterKey && !item.parameters.some(value => value.key.toLowerCase() === parameterKey && (!parameterValue || value.value.toLowerCase().includes(parameterValue)))) return false;
      if (!parameterKey && parameterValue && !item.parameters.some(value => value.value.toLowerCase().includes(parameterValue))) return false;
      const haystack = [item.sku, item.name, item.categoryName || '', item.salt, ...item.tags, ...item.parameters.flatMap(value => [value.key, value.value])].join(' ').toLowerCase();
      return !query || query.split(/\s+/).every(token => haystack.includes(token));
    });
    return { items: matched.slice(0, 100), total: matched.length, resultLimit: 100, newnessDays, safetyNotice };
  }));
  app.get('/api/catalogue/items/:id', route(req => {
    canRead(req);
    const item = detail(itemRow(req, req.params.id));
    const substitutes = db.prepare('SELECT * FROM catalogue_substitutes WHERE company_id=? AND item_id=? ORDER BY active DESC,id DESC').all(req.company.id, item.id)
      .map(row => ({ ...mapping(row), substitute: detail(itemRow(req, row.substitute_item_id)) }));
    return { item, substitutes, safetyNotice, newnessDays };
  }));
  app.put('/api/catalogue/items/:id', route(req => {
    steward(req);
    const item = itemRow(req, req.params.id), data = parseMetadata(req, req.body || {});
    return atomic(db, () => {
      const linked = db.prepare(`SELECT item_id,substitute_item_id FROM catalogue_substitutes
        WHERE company_id=? AND active=1 AND (item_id=? OR substitute_item_id=?)`).all(req.company.id, item.id, item.id);
      if (linked.some(row => {
        const otherId = row.item_id === item.id ? row.substitute_item_id : row.item_id;
        return detail(itemRow(req, otherId)).productKind !== data.productKind;
      })) throw fail('Retire active suggestions before changing this item productKind', 409);
      db.prepare(`INSERT INTO catalogue_item_details(item_id,company_id,category_id,product_kind,salt,launched_on,source_reference,updated_by)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET category_id=excluded.category_id,product_kind=excluded.product_kind,
        salt=excluded.salt,launched_on=excluded.launched_on,source_reference=excluded.source_reference,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
        .run(item.id, req.company.id, data.categoryId, data.productKind, data.salt, data.launchedOn, data.sourceReference, req.user.id);
      db.prepare('DELETE FROM catalogue_item_tags WHERE item_id=? AND company_id=?').run(item.id, req.company.id);
      db.prepare('DELETE FROM catalogue_item_parameters WHERE item_id=? AND company_id=?').run(item.id, req.company.id);
      for (const tag of data.tags) db.prepare('INSERT INTO catalogue_item_tags(item_id,company_id,tag) VALUES (?,?,?)').run(item.id, req.company.id, tag);
      for (const parameter of data.parameters) db.prepare('INSERT INTO catalogue_item_parameters(item_id,company_id,key,value) VALUES (?,?,?,?)').run(item.id, req.company.id, parameter.key, parameter.value);
      const result = detail(item);
      event(req, item.id, 'metadata_updated', data.sourceReference, data.changeReason, result);
      return { item: result, safetyNotice };
    });
  }));
  app.post('/api/catalogue/substitutes', route(req => {
    steward(req);
    const item = itemRow(req, req.body?.itemId), substitute = itemRow(req, req.body?.substituteItemId);
    if (item.id === substitute.id) throw fail('An item cannot substitute itself');
    if (!item.active || !substitute.active) throw fail('Both items must be active');
    const sourceKind = detail(item).productKind, targetKind = detail(substitute).productKind;
    if (sourceKind !== targetKind) throw fail('Both items must have the same catalogue productKind');
    const reason = words(req.body?.reason, 'reason', 500), sourceReference = words(req.body?.sourceReference, 'sourceReference', 200);
    return atomic(db, () => {
      const result = db.prepare('INSERT INTO catalogue_substitutes(company_id,item_id,substitute_item_id,reason,source_reference,updated_by) VALUES (?,?,?,?,?,?)')
        .run(req.company.id, item.id, substitute.id, reason, sourceReference, req.user.id);
      const row = mapping(db.prepare('SELECT * FROM catalogue_substitutes WHERE id=?').get(result.lastInsertRowid));
      event(req, item.id, 'substitute_added', sourceReference, reason, row);
      return { substitute: row, safetyNotice };
    });
  }));
  app.patch('/api/catalogue/substitutes/:id', route(req => {
    steward(req);
    const row = db.prepare('SELECT * FROM catalogue_substitutes WHERE id=? AND company_id=?').get(id(req.params.id, 'substituteId'), req.company.id);
    if (!row) throw fail('Substitute mapping not found in selected company', 404);
    if (typeof req.body?.active !== 'boolean') throw fail('active must be boolean');
    const sourceReference = words(req.body.sourceReference, 'sourceReference', 200), changeReason = words(req.body.changeReason, 'changeReason', 500);
    if (req.body.active) {
      const source = itemRow(req, row.item_id), target = itemRow(req, row.substitute_item_id);
      if (!source.active || !target.active) throw fail('Both items must be active');
      if (detail(source).productKind !== detail(target).productKind) throw fail('Both items must have the same catalogue productKind');
    }
    return atomic(db, () => {
      db.prepare('UPDATE catalogue_substitutes SET active=?,source_reference=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(Number(req.body.active), sourceReference, req.user.id, row.id);
      const updated = mapping(db.prepare('SELECT * FROM catalogue_substitutes WHERE id=?').get(row.id));
      event(req, row.item_id, req.body.active ? 'substitute_reactivated' : 'substitute_retired', sourceReference, changeReason, updated);
      return { substitute: updated, safetyNotice };
    });
  }));
  app.get('/api/catalogue/audit', route(req => {
    steward(req);
    const item = itemRow(req, req.query.itemId);
    return { events: db.prepare('SELECT * FROM catalogue_item_events WHERE company_id=? AND item_id=? ORDER BY id DESC LIMIT 100').all(req.company.id, item.id).map(row => ({ ...camel(row), snapshot: JSON.parse(row.snapshot_json), snapshotJson: undefined })) };
  }));
}

module.exports = { registerCatalogueRoutes };
