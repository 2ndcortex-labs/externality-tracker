import { randomBytes, randomUUID } from 'node:crypto';
import { toWire } from './db.js';
import { HttpError, parseScope } from './auth.js';

export { HttpError };

const TEXT = { 'what': 'what', 'who-acts': 'who_acts', 'how-observed': 'how_observed' };
const STATES = ['open', 'cleared'];

function isText(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function needSlugs(call) {
  if (!call.atlas) throw new HttpError(400, 'atlas-slug is required');
  if (!call.item) throw new HttpError(400, 'item-slug is required');
}

// call.scope: null or absent for `all`, else the atlas slugs the token may see.
function findOwn(db, id, call) {
  const row = db.prepare('SELECT * FROM externalities WHERE id = ? AND org = ?').get(id, call.org);
  if (!row || row.atlas !== call.atlas || row.item !== call.item || (call.scope && !call.scope.includes(row.atlas))) {
    throw new HttpError(404, 'unknown id');
  }
  return row;
}

function isObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

function isHttpUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const { protocol } = new URL(v);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function mint(db, call, body) {
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  const scope = parseScope(body.scope);
  if (scope === null) throw new HttpError(400, 'scope must be all or a comma-delineated list of atlas slugs');
  const url = body.url ?? null;
  if (url !== null && !isHttpUrl(url)) throw new HttpError(400, 'url must be an absolute http or https URL');
  const row = {
    token: randomBytes(32).toString('base64url'),
    scope: scope === 'all' ? 'all' : scope.join(','),
    url,
    date: new Date().toISOString(),
  };
  db.prepare(`INSERT INTO tokens (token, scope, url, date, last_delivery_date, last_delivery_status)
    VALUES (?, ?, ?, ?, ?, ?)`).run(row.token, row.scope, row.url, row.date, null, null);
  return [201, row];
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
    (id, org, atlas, item, what, who_acts, how_observed, state, set_date, cleared_date, cleared_words)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.org, row.atlas, row.item, row.what, row.who_acts, row.how_observed,
    row.state, row.set_date, row.cleared_date, row.cleared_words);
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
  const where = ['org = ?'];
  const args = [call.org];
  if (call.atlas) { where.push('atlas = ?'); args.push(call.atlas); }
  if (call.item) { where.push('item = ?'); args.push(call.item); }
  if (call.scope) {
    where.push(`atlas IN (${call.scope.map(() => '?').join(', ')})`);
    args.push(...call.scope);
  }
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
