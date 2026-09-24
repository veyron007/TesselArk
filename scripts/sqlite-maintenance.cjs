#!/usr/bin/env node
const { backupFile, restoreFile, migrateFile, checkFile } = require('../server/sqlite-maintenance.cjs');

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith('--') || key in result) throw new Error(`Invalid or repeated option: ${key}`);
    if (key === '--offline' || key === '--replace') result[key] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      result[key] = args[++index];
    }
  }
  return result;
}

async function main([command, ...args]) {
  const opts = options(args);
  const allowed = {
    check: ['--db'],
    backup: ['--db', '--output'],
    restore: ['--source', '--db', '--replace', '--recovery', '--offline'],
    migrate: ['--db', '--backup', '--offline'],
  }[command];
  if (!allowed || Object.keys(opts).some(key => !allowed.includes(key))) {
    throw new Error('Usage: check --db FILE | backup --db FILE --output FILE | restore --source FILE --db FILE [--replace --recovery FILE] --offline | migrate --db FILE --backup FILE --offline');
  }
  let result;
  if (command === 'check') result = checkFile(opts['--db']);
  if (command === 'backup') result = await backupFile(opts['--db'], opts['--output']);
  if (command === 'restore') result = await restoreFile(opts['--source'], opts['--db'], {
    replace: opts['--replace'], recoveryFile: opts['--recovery'], offline: opts['--offline'],
  });
  if (command === 'migrate') result = await migrateFile(opts['--db'], {
    backupPath: opts['--backup'], offline: opts['--offline'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { main };
