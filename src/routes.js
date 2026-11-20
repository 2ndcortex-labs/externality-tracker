import { randomBytes } from 'node:crypto';
import { toTokenWire, toThirdpartyWire } from './db.js';
import { HttpError, safeEqual } from './auth.js';

export { HttpError };

const URL_REASON = 'url must be an absolute http or https URL';
const ADDRESS_REASON = 'email must be one address: one @, text on both sides, no space and no +';

function isText(v) {
  return typeof v === 'string' && v.trim() !== '';
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
// later; lost at a restart. Every post counts toward the service's window, whatever its answer. A post the service's
// count already refuses touches no caller's window, so callers' windows are made only by posts within the service's
// number, at most `total` of them per window; ended windows are swept at most once a window.
export const LIMITS = { perCaller: 5, total: 60, windowMs: 60_000 };

export function makeLimiter(limits = LIMITS, now = Date.now) {
  const { perCaller, total, windowMs } = { ...LIMITS, ...limits };
  const callers = new Map();
  let service = { start: -Infinity, n: 0 };
  let swept = -Infinity;
  // True when the ask may proceed.
  const may = (caller) => {
    const t = now();
    if (t - service.start >= windowMs) service = { start: t, n: 0 };
    service.n += 1;
    if (t - swept >= windowMs) {
      swept = t;
      for (const [key, w] of callers) if (t - w.start >= windowMs) callers.delete(key);
    }
    if (service.n > total) return false;
    let w = callers.get(caller);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, n: 0 };
      callers.set(caller, w);
    }
    w.n += 1;
    return w.n <= perCaller;
  };
  // The number of callers' windows held, for the tests.
  may.callers = () => callers.size;
  return may;
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

// An ask for a token. The asked address's authorized form (the text from its first `+` to its `@` removed) is compared
// with every authorized email, active or not, in constant time; the address itself, a variation or the authorized form,
// holds one token. A first ask reads no credential and makes the token. A later ask (the address already has a token)
// must carry that token as `bearer`, compared in constant time; none or any other value gets the unknown address's 401
// and writes nothing. A match writes a new token and date, and the URL when named, on the same row in one write, which
// holds only while the row still carries the matched token. `url` absent leaves the stored one, null clears it.
export function ask(db, body, bearer = null) {
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
  if (typeof bearer !== 'string' || !safeEqual(bearer, own.token)) throw new HttpError(401, 'refused');
  const row = { token: randomBytes(32).toString('base64url'), url: hasUrl ? body.url : own.url ?? null, date: new Date().toISOString() };
  const r = hasUrl
    ? db.prepare('UPDATE tokens SET token = ?, date = ?, url = ? WHERE id = ? AND token = ?').run(row.token, row.date, row.url, own.id, own.token)
    : db.prepare('UPDATE tokens SET token = ?, date = ? WHERE id = ? AND token = ?').run(row.token, row.date, own.id, own.token);
  // Another ask renewed the row first: the matched token is no longer current.
  if (r.changes !== 1) throw new HttpError(401, 'refused');
  return [200, row];
}

// The calling token's own record, read by its own credential.
export function tokenInfo(call) {
  return [200, toTokenWire(call.tokenRow)];
}

// The latest third-party outcome, one for the whole service, read under any valid token.
export function thirdpartyInfo(db) {
  return [200, toThirdpartyWire(db.prepare('SELECT * FROM thirdparty WHERE id = 1').get())];
}
