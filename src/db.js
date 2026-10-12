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
    id TEXT PRIMARY KEY, org TEXT, nav TEXT, item TEXT, what TEXT,
    who_acts TEXT, how_observed TEXT, state TEXT, set_date TEXT,
    cleared_date TEXT, cleared_words TEXT)`);
  return db;
}

export function toWire(row) {
  return {
    'id': row.id,
    'org-slug': row.org,
    'nav-slug': row.nav,
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
