import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function dataDir(env) {
  return env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || './data';
}

export function openDb(env) {
  const dir = dataDir(env);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS externalities (
    id TEXT PRIMARY KEY, org TEXT, atlas TEXT, item TEXT, what TEXT,
    who_acts TEXT, how_observed TEXT, state TEXT, set_date TEXT,
    cleared_date TEXT, cleared_words TEXT)`);
  db.exec('CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, scope TEXT, url TEXT, date TEXT, last_delivery_date TEXT, last_delivery_status INTEGER)');
  migrate(db);
  return db;
}

// A database made before 2026-10-19 keys its records by the old column: renamed in place to `atlas`,
// values kept; a second start finds `atlas` and does nothing.
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(externalities)').all().map((c) => c.name);
  if (columns.includes('nav') && !columns.includes('atlas')) {
    db.exec('ALTER TABLE externalities RENAME COLUMN nav TO atlas');
  }
}

export function toWire(row) {
  return {
    'id': row.id,
    'org-slug': row.org,
    'atlas-slug': row.atlas,
    'item-slug': row.item,
    'what': row.what,
    'who-acts': row.who_acts,
    'how-observed': row.how_observed,
    'state': row.state,
    'set-date': row.set_date,
    'cleared-date': row.cleared_date || null,
    'cleared-words': row.cleared_words || null,
  };
}

// A token's own record on the wire: the five fields written out, the token value never among them.
export function toTokenWire(row) {
  return {
    'scope': row.scope,
    'url': row.url ?? null,
    'date': row.date,
    'last-delivery-date': row.last_delivery_date ?? null,
    'last-delivery-status': row.last_delivery_status ?? null,
  };
}
