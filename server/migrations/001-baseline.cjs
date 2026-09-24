// Records the existing demo schema as a baseline. Historical CREATE/ALTER
// statements still run in db.cjs; later schema changes belong in new files.
const required = {
  companies: ['id', 'name'],
  gstins: ['id', 'company_id', 'gstin'],
  branches: ['id', 'company_id', 'gstin_id'],
  users: ['id', 'company_id', 'role'],
  items: ['id', 'company_id', 'sku'],
  invoices: ['id', 'company_id', 'gstin_id', 'branch_id', 'fulfillment_id'],
  invoice_lines: ['id', 'invoice_id', 'fulfillment_line_id'],
  purchase_evidence: ['invoice_id', 'claim_period'],
  journals: ['id', 'company_id', 'party_name_snapshot'],
  user_gstin_grants: ['id', 'company_id', 'gstin_id'],
  user_branch_grants: ['id', 'company_id', 'branch_id'],
};

module.exports = {
  id: '001-baseline',
  up(db) {
    for (const [table, columns] of Object.entries(required)) {
      const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const column of columns) {
        if (!actual.has(column)) throw new Error(`Existing schema lacks ${table}.${column}`);
      }
    }
  },
};
