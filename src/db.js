import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function dataDir(env) {
  return env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || './data';
}

// node:sqlite enforces foreign keys by default, so every `token_id` must name a row of `tokens`.
const TABLES = [
  // The list of authorized emails, changed by the two admin endpoints only; `active` is 1 or 0.
  `CREATE TABLE IF NOT EXISTS authorized_emails (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1)`,
  // One token per asking address, the authorized form or a variation, keyed to its authorized email.
  `CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
    authorized_email INTEGER NOT NULL REFERENCES authorized_emails(id), url TEXT, date TEXT NOT NULL,
    last_delivery_date TEXT, last_delivery_status INTEGER)`,
  `CREATE TABLE IF NOT EXISTS externalities (
    id TEXT PRIMARY KEY, org TEXT, atlas TEXT, item TEXT, what TEXT,
    who_acts TEXT, how_observed TEXT, state TEXT, set_date TEXT,
    cleared_date TEXT, cleared_words TEXT, token_id INTEGER NOT NULL REFERENCES tokens(id))`,
  // One row per notice taken at the open notice address, never replaced; `body` is the post's text as received.
  `CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, item TEXT, state TEXT, what TEXT, body TEXT, received TEXT,
    token_id INTEGER NOT NULL REFERENCES tokens(id))`,
  // The latest third-party outcome, one row for the whole service (id 1), absent until an attempt has settled.
  'CREATE TABLE IF NOT EXISTS thirdparty (id INTEGER PRIMARY KEY CHECK (id = 1), last_delivery_date TEXT, last_delivery_status INTEGER)',
];

export const DROPPED_LINE = 'externality-tracker: dropped old tables externalities, notices, tokens';

// A database made before tokens belonged to emails is known by the `scope` column of its `tokens` table: its records,
// notices and tokens are dropped and the tables made new, in one transaction, `thirdparty` left as it is. A database
// without that column drops nothing, so no later start deletes anything.
export function openDb(env) {
  const dir = dataDir(env);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  const old = db.prepare('PRAGMA table_info(tokens)').all().some((c) => c.name === 'scope');
  db.exec('BEGIN');
  try {
    if (old) db.exec('DROP TABLE IF EXISTS externalities; DROP TABLE IF EXISTS notices; DROP TABLE IF EXISTS tokens;');
    for (const sql of TABLES) db.exec(sql);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  if (old) console.log(DROPPED_LINE);
  return db;
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

// A token's own record on the wire: the four fields written out, the token value and its email never among them.
export function toTokenWire(row) {
  return {
    'url': row.url ?? null,
    'date': row.date,
    'last-delivery-date': row.last_delivery_date ?? null,
    'last-delivery-status': row.last_delivery_status ?? null,
  };
}

// Writes the third-party outcome over the last one. A database closed before the attempt settled loses it, nothing else.
export function saveThirdparty(db, date, status) {
  try {
    db.prepare(`INSERT INTO thirdparty (id, last_delivery_date, last_delivery_status) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_delivery_date = excluded.last_delivery_date, last_delivery_status = excluded.last_delivery_status`)
      .run(date, status);
  } catch {
    // the outcome is lost; the notice is unaffected
  }
}

// The third-party outcome on the wire: both fields null until an attempt has settled.
export function toThirdpartyWire(row) {
  return {
    'last-delivery-date': row?.last_delivery_date ?? null,
    'last-delivery-status': row?.last_delivery_status ?? null,
  };
}
