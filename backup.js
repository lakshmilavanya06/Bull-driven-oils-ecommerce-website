// Automatic SQLite backups: on start and every 24h, keep the newest 14, in DATA_DIR/backups
const fs = require('fs'), path = require('path');
const { db, dbPath } = require('./db');
const dir = path.join(path.dirname(dbPath), 'backups');

async function runBackup() {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `store-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await db.backup(file); // safe online copy, even while orders are coming in
  fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort().reverse().slice(14).forEach(f => fs.unlinkSync(path.join(dir, f)));
  return file;
}
const lastBackup = () => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort().pop() || null; } catch { return null; } };
function schedule() {
  runBackup().catch(e => console.error('[backup] failed', e.message));
  setInterval(() => runBackup().catch(e => console.error('[backup] failed', e.message)), 24 * 3600 * 1000).unref();
}
module.exports = { runBackup, lastBackup, schedule, dbPath };
