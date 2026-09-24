function installOrdersSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      party_id INTEGER NOT NULL REFERENCES parties(id),
      party_name_snapshot TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('purchase','sale')),
      number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
      order_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      confirmed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TEXT,
      UNIQUE(company_id,number)
    );
    CREATE TABLE IF NOT EXISTS order_lines (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      item_name_snapshot TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity>0),
      unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),
      gst_rate_bps INTEGER NOT NULL CHECK(gst_rate_bps BETWEEN 0 AND 10000)
    );
    CREATE TABLE IF NOT EXISTS order_fulfillments (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      number TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('receipt','dispatch')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
      event_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      confirmed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TEXT,
      UNIQUE(company_id,number)
    );
    CREATE TABLE IF NOT EXISTS order_fulfillment_lines (
      id INTEGER PRIMARY KEY,
      fulfillment_id INTEGER NOT NULL REFERENCES order_fulfillments(id),
      order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),
      stock_movement_id INTEGER REFERENCES stock_movements(id),
      UNIQUE(fulfillment_id,order_line_id)
    );
    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      fulfillment_id INTEGER REFERENCES order_fulfillments(id),
      action TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_orders_scope ON orders(company_id,gstin_id,branch_id,id);
    CREATE INDEX IF NOT EXISTS idx_order_fulfillment_order ON order_fulfillments(order_id,status);
  `);
}
module.exports = { installOrdersSchema };
