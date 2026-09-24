const { openDatabase } = require('./db.cjs');
const { provisionCredential } = require('./auth.cjs');

function main() {
  const userId = Number(process.env.ERP_AUTH_USER_ID);
  const email = process.env.ERP_AUTH_EMAIL;
  const password = process.env.ERP_AUTH_PASSWORD;
  if (!Number.isSafeInteger(userId) || userId < 1 || !email || !password) {
    throw new Error('Set ERP_AUTH_USER_ID, ERP_AUTH_EMAIL, and ERP_AUTH_PASSWORD for an existing user');
  }
  const db = openDatabase();
  try {
    provisionCredential(db, { userId, email, password });
    process.stdout.write('Credential provisioned; existing sessions revoked.\n');
  } finally { db.close(); }
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
