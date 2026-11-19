import { randomBytes, randomUUID } from 'node:crypto';
import { toWire, toTokenWire, toThirdpartyWire } from './db.js';
import { HttpError, safeEqual } from './auth.js';

export { HttpError };

const TEXT = { 'what': 'what', 'who-acts': 'who_acts', 'how-observed': 'how_observed' };
const STATES = ['open', 'cleared'];
const URL_REASON = 'url must be an absolute http or https URL';
const ADDRESS_REASON = 'email must be one address: one @, text on both sides, no space and no +';

function isText(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function needSlugs(call) {
  if (!call.atlas) throw new HttpError(400, 'atlas-slug is required');
  if (!call.item) throw new HttpError(400, 'item-slug is required');
}

// A record of the calling token's own, matching the call's atlas and item; any other answers as absent.
function findOwn(db, id, call) {
  const row = db.prepare('SELECT * FROM externalities WHERE id = ? AND org = ? AND token_id = ?').get(id, call.org, call.tokenRow.id);
  if (!row || row.atlas !== call.atlas || row.item !== call.item) {
    throw new HttpError(404, 'unknown id');
  }
  return row;
}

function isObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

export function isHttpUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const { protocol } = new URL(v);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// The limit on asking: a fixed window in memory per key, a count starting at the key's first ask and ending `windowMs`
// later; lost at a restart. Each post counts toward its caller's key and the service's, whatever its answer.
export const LIMITS = { perCaller: 5, total: 60, windowMs: 60_000 };

export function makeLimiter(limits = LIMITS, now = Date.now) {
  const { perCaller, total, windowMs } = { ...LIMITS, ...limits };
  const windows = new Map();
  const count = (key, t) => {
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, n: 0 };
      windows.set(key, w);
    }
    w.n += 1;
    return w.n;
  };
  // True when the ask may proceed.
  return (caller) => {
    const t = now();
    // Ended windows are swept once the map grows, so callers that have gone do not pile up.
    if (windows.size > 10_000) for (const [key, w] of windows) if (t - w.start >= windowMs) windows.delete(key);
    const mine = count(`caller ${caller}`, t);
    const all = count('service', t);
    return mine <= perCaller && all <= total;
  };
}

// Addresses are trimmed and lowered before they are stored or matched.
const normal = (email) => email.trim().toLowerCase();

// An authorized address: one @, text on both sides, no space and no +.
const isAddress = (email) => /^[^@\s+]+@[^@\s+]+$/.test(email);

function listedAddress(body) {
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  const email = typeof body.email === 'string' ? normal(body.email) : '';
  if (!isAddress(email)) throw new HttpError(400, ADDRESS_REASON);
  return email;
}

const toEmailWire = (row) => ({ email: row.email, active: row.active === 1 });

// Adds an authorized email, active; any field but `email` is ignored. A known address is answered as it stands.
export function addEmail(db, body) {
  const email = listedAddress(body);
  const known = db.prepare('SELECT * FROM authorized_emails WHERE email = ?').get(email);
  if (known) return [200, toEmailWire(known)];
  db.prepare('INSERT INTO authorized_emails (email, active) VALUES (?, 1)').run(email);
  return [201, { email, active: true }];
}

// Activates or deactivates an authorized email; it takes effect at the next call, with no restart.
export function setActive(db, body) {
  const email = listedAddress(body);
  if (typeof body.active !== 'boolean') throw new HttpError(400, 'active must be true or false');
  const r = db.prepare('UPDATE authorized_emails SET active = ? WHERE email = ?').run(body.active ? 1 : 0, email);
  if (r.changes === 0) throw new HttpError(404, 'unknown email');
  return [200, { email, active: body.active }];
}

// An ask for a token, under no credential. The asked address's authorized form (the text from its first `+` to its `@`
// removed) is compared with every authorized email, active or not, in constant time; the address itself, a variation
// or the authorized form, holds one token, made at its first ask. `url` absent leaves the stored one, null clears it.
export function ask(db, body) {
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  if (!isText(body.email)) throw new HttpError(400, 'email must be a non-empty string');
  const hasUrl = Object.hasOwn(body, 'url');
  if (hasUrl && body.url !== null && !isHttpUrl(body.url)) throw new HttpError(400, URL_REASON);
  const email = normal(body.email);
  const authorized = email.replace(/\+[^@]*@/, '@');
  let found = null;
  for (const row of db.prepare('SELECT id, email, active FROM authorized_emails').all()) {
    if (safeEqual(authorized, row.email) && !found) found = row;
  }
  if (!found || found.active !== 1) throw new HttpError(401, 'refused');
  const own = db.prepare('SELECT * FROM tokens WHERE email = ?').get(email);
  if (!own) {
    const row = { token: randomBytes(32).toString('base64url'), url: hasUrl ? body.url : null, date: new Date().toISOString() };
    db.prepare('INSERT INTO tokens (email, token, authorized_email, url, date) VALUES (?, ?, ?, ?, ?)')
      .run(email, row.token, found.id, row.url, row.date);
    return [201, row];
  }
  if (hasUrl) {
    db.prepare('UPDATE tokens SET url = ? WHERE id = ?').run(body.url, own.id);
    own.url = body.url;
  }
  return [200, { token: own.token, url: own.url ?? null, date: own.date }];
}

export function add(db, call, body) {
  needSlugs(call);
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  for (const field of Object.keys(TEXT)) {
    if (!isText(body[field])) throw new HttpError(400, `${field} must be a non-empty string`);
  }
  const row = {
    id: randomUUID(), org: call.org, atlas: call.atlas, item: call.item,
    what: body['what'], who_acts: body['who-acts'], how_observed: body['how-observed'],
    state: 'open', set_date: new Date().toISOString(), cleared_date: null, cleared_words: null,
  };
  db.prepare(`INSERT INTO externalities
    (id, org, atlas, item, what, who_acts, how_observed, state, set_date, cleared_date, cleared_words, token_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.org, row.atlas, row.item, row.what, row.who_acts, row.how_observed,
    row.state, row.set_date, row.cleared_date, row.cleared_words, call.tokenRow.id);
  return [201, { id: row.id, record: toWire(row) }];
}

export function update(db, call, body) {
  needSlugs(call);
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  if (!isText(body.id)) throw new HttpError(400, 'id must be a non-empty string');
  const fields = [...Object.keys(TEXT), 'state', 'cleared-words'].filter((f) => f in body);
  if (fields.length === 0) throw new HttpError(400, 'nothing to update besides id');
  for (const field of [...Object.keys(TEXT), 'cleared-words']) {
    if (field in body && !isText(body[field])) {
      throw new HttpError(400, `${field} must be a non-empty string`);
    }
  }
  if ('state' in body && !STATES.includes(body.state)) {
    throw new HttpError(400, 'state must be open or cleared');
  }
  const row = { ...findOwn(db, body.id, call) };
  for (const [field, column] of Object.entries(TEXT)) {
    if (field in body) row[column] = body[field];
  }
  if (body.state === 'cleared') {
    if (!('cleared-words' in body)) throw new HttpError(400, 'cleared-words is required to clear');
    row.state = 'cleared';
    row.cleared_date = new Date().toISOString();
    row.cleared_words = body['cleared-words'];
  } else if (body.state === 'open') {
    if ('cleared-words' in body) throw new HttpError(400, 'cleared-words cannot be set on a reopening');
    row.state = 'open';
    row.cleared_date = null;
    row.cleared_words = null;
  } else if ('cleared-words' in body) {
    if (row.state !== 'cleared') throw new HttpError(400, 'cleared-words needs a cleared record');
    row.cleared_words = body['cleared-words'];
  }
  db.prepare(`UPDATE externalities SET what = ?, who_acts = ?, how_observed = ?, state = ?,
    cleared_date = ?, cleared_words = ? WHERE id = ?`).run(
    row.what, row.who_acts, row.how_observed, row.state, row.cleared_date, row.cleared_words, row.id);
  return [200, { record: toWire(row) }];
}

export function status(db, call, url) {
  const id = url.searchParams.get('id');
  if (!id) throw new HttpError(400, 'id is required');
  needSlugs(call);
  return [200, { record: toWire(findOwn(db, id, call)) }];
}

export function inventory(db, call, url) {
  const where = ['org = ?', 'token_id = ?'];
  const args = [call.org, call.tokenRow.id];
  if (call.atlas) { where.push('atlas = ?'); args.push(call.atlas); }
  if (call.item) { where.push('item = ?'); args.push(call.item); }
  const state = url.searchParams.get('state');
  if (state !== null) {
    if (!STATES.includes(state)) throw new HttpError(400, 'state must be open or cleared');
    where.push('state = ?');
    args.push(state);
  }
  const q = url.searchParams.get('q');
  if (q !== null) {
    if (q === '') throw new HttpError(400, 'q must be a non-empty string');
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(what LIKE ? ESCAPE '\\' OR who_acts LIKE ? ESCAPE '\\' OR how_observed LIKE ? ESCAPE '\\')`);
    args.push(pattern, pattern, pattern);
  }
  const rows = db.prepare(`SELECT * FROM externalities WHERE ${where.join(' AND ')}
    ORDER BY set_date DESC, id ASC`).all(...args);
  return [200, { records: rows.map(toWire) }];
}

// The calling token's own record, read by its own credential.
export function tokenInfo(call) {
  return [200, toTokenWire(call.tokenRow)];
}

// The latest third-party outcome, one for the whole service, read under any valid token.
export function thirdpartyInfo(db) {
  return [200, toThirdpartyWire(db.prepare('SELECT * FROM thirdparty WHERE id = 1').get())];
}
