// tests/fixtures/read-intents.mjs
// Standalone reader used to prove WAL cross-process visibility (V22).
import { DatabaseSync } from 'node:sqlite';

const [, , dbPath, runId] = process.argv;
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 3000');

const rows = db
  .prepare('SELECT kind, watermark FROM control_intents WHERE run_id = ? ORDER BY watermark ASC')
  .all(runId);

for (const row of rows) {
  process.stdout.write(`watermark=${row.watermark} kind=${row.kind}\n`);
}
db.close();
