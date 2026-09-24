const ACCOUNT_DEFINITIONS = Object.freeze([
  ['1000','Cash on hand','asset','debit'],
  ['1100','Bank clearing','asset','debit'],
  ['1150','Undeposited collections','asset','debit'],
  ['1200','Trade receivables','asset','debit'],
  ['1300','Purchase GST control','asset','debit'],
  ['2100','Trade payables','liability','credit'],
  ['2200','Sales GST control','liability','credit'],
  ['2300','Uncleared disbursements','liability','credit'],
  ['4000','Sales revenue','revenue','credit'],
  ['4100','Sales returns','revenue','debit'],
  ['5000','Purchases','expense','debit'],
  ['5100','Purchase returns','expense','credit'],
]);

function installLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('asset','liability','revenue','expense')),
      normal_side TEXT NOT NULL CHECK(normal_side IN ('debit','credit')),
      UNIQUE(company_id,code)
    );
    CREATE TABLE IF NOT EXISTS journals (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER REFERENCES gstins(id),
      branch_id INTEGER REFERENCES branches(id),
      party_id INTEGER REFERENCES parties(id),
      party_name_snapshot TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL CHECK(source_type IN ('invoice','payment','return_settlement')),
      source_id INTEGER NOT NULL,
      document_number TEXT NOT NULL,
      journal_date TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,source_type,source_id)
    );
    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY,
      journal_id INTEGER NOT NULL REFERENCES journals(id),
      account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
      debit_cents INTEGER NOT NULL DEFAULT 0 CHECK(debit_cents >= 0),
      credit_cents INTEGER NOT NULL DEFAULT 0 CHECK(credit_cents >= 0),
      CHECK((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
    );
    CREATE INDEX IF NOT EXISTS idx_journals_scope_date ON journals(company_id,journal_date,id);
    CREATE INDEX IF NOT EXISTS idx_journals_party ON journals(company_id,party_id,journal_date);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id,journal_id);
  `);
  if (!db.prepare('PRAGMA table_info(journals)').all().some(row => row.name === 'party_name_snapshot')) {
    db.exec("ALTER TABLE journals ADD COLUMN party_name_snapshot TEXT NOT NULL DEFAULT ''");
  }
  const journalSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='journals'").get()?.sql || '';
  if (!journalSql.includes("'return_settlement'")) {
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE journals_next (
          id INTEGER PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id),
          gstin_id INTEGER REFERENCES gstins(id),
          branch_id INTEGER REFERENCES branches(id),
          party_id INTEGER REFERENCES parties(id),
          party_name_snapshot TEXT NOT NULL DEFAULT '',
          source_type TEXT NOT NULL CHECK(source_type IN ('invoice','payment','return_settlement')),
          source_id INTEGER NOT NULL,
          document_number TEXT NOT NULL,
          journal_date TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(company_id,source_type,source_id)
        );
        INSERT INTO journals_next(id,company_id,gstin_id,branch_id,party_id,party_name_snapshot,source_type,source_id,document_number,journal_date,description,created_at)
          SELECT id,company_id,gstin_id,branch_id,party_id,party_name_snapshot,source_type,source_id,document_number,journal_date,description,created_at FROM journals;
        DROP TABLE journals;
        ALTER TABLE journals_next RENAME TO journals;
        CREATE INDEX idx_journals_scope_date ON journals(company_id,journal_date,id);
        CREATE INDEX idx_journals_party ON journals(company_id,party_id,journal_date);
      `);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys=ON');
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error('Ledger schema migration failed foreign key check');
  }
}

function ensureLedgerAccounts(db, companyId) {
  const insert = db.prepare('INSERT OR IGNORE INTO ledger_accounts(company_id,code,name,kind,normal_side) VALUES (?,?,?,?,?)');
  for (const account of ACCOUNT_DEFINITIONS) insert.run(companyId,...account);
}

module.exports = { installLedgerSchema, ensureLedgerAccounts, ACCOUNT_DEFINITIONS };
