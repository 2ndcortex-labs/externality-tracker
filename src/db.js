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
  // One row per notice taken at the open notice address, never replaced; `body` is the post's text as received. The `id`
  // is given a value and read by nothing.
  `CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, item TEXT, state TEXT, what TEXT, body TEXT, received TEXT,
    token_id INTEGER NOT NULL REFERENCES tokens(id))`,
  // The latest third-party outcome, one row for the whole service (id 1), absent until an attempt has settled.
  'CREATE TABLE IF NOT EXISTS thirdparty (id INTEGER PRIMARY KEY CHECK (id = 1), last_delivery_date TEXT, last_delivery_status INTEGER)',
];

export const DROPPED_LINE = 'externality-tracker: dropped old tables externalities, notices, tokens';
// The add store, `externalities`, is gone: a database in today's shape that still holds it drops it at its first start.
export const DROPPED_ADD_LINE = 'externality-tracker: dropped old table externalities';

const TOKEN_COLUMNS = ['id', 'email', 'token', 'authorized_email', 'url', 'date', 'last_delivery_date', 'last_delivery_status'];

// A database made before tokens belonged to emails is known by its tables: `externalities` or `notices` present without
// `token_id`, or `tokens` present without every new column (today's old one has `scope` and no `authorized_email`).
// Its records, notices and tokens are dropped and the tables made new, in one transaction, `thirdparty` left as it is.
// A database in the new shape drops only the add store `externalities`, where it is still found; no later start
// deletes anything.
function isOld(db) {
  const lacks = (table, wanted) => {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    return have.length > 0 && !wanted.every((c) => have.includes(c));
  };
  return lacks('externalities', ['token_id']) || lacks('notices', ['token_id']) || lacks('tokens', TOKEN_COLUMNS);
}

export function openDb(env) {
  const dir = dataDir(env);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  const old = isOld(db);
  const addStore = !old && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'externalities'").get() !== undefined;
  db.exec('BEGIN');
  try {
    if (old) db.exec('DROP TABLE IF EXISTS externalities; DROP TABLE IF EXISTS notices; DROP TABLE IF EXISTS tokens;');
    if (addStore) db.exec('DROP TABLE externalities');
    for (const sql of TABLES) db.exec(sql);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  if (old) console.log(DROPPED_LINE);
  if (addStore) console.log(DROPPED_ADD_LINE);
  return db;
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
