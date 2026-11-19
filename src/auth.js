import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
  }
}

const VALUES = [
  ['org', 'x-org-slug', 'org-slug'],
  ['atlas', 'x-atlas-slug', 'atlas-slug'],
  ['item', 'x-item-slug', 'item-slug'],
];

// The rule of ADDRESS_KEY and ADMIN_TOKEN: letters, digits, - and _ only, 32 characters or more.
const SECRET = /^[A-Za-z0-9_-]{32,}$/;

// ORG_SLUG and ADMIN_TOKEN, both required; no other credential setting is read.
export function loadAuthConfig(env) {
  const org = env.ORG_SLUG ?? '';
  if (!org) throw new Error('ORG_SLUG is not set');
  return { org, admin: loadAdminToken(env) };
}

// The admin token, which opens the two admin endpoints and nothing else; unset or of any other shape stops the start.
export function loadAdminToken(env) {
  const admin = env.ADMIN_TOKEN ?? '';
  if (admin === '') throw new Error('ADMIN_TOKEN is not set');
  if (!SECRET.test(admin)) throw new Error('ADMIN_TOKEN must be letters, digits, - and _ only, 32 characters or more');
  return admin;
}

// The hard-to-guess part of the two open addresses: '' when ADDRESS_KEY is unset or empty (the addresses off),
// else letters, digits, - and _ only, 32 characters or more; any other value stops the start.
export function loadAddressKey(env) {
  const part = env.ADDRESS_KEY ?? '';
  if (part !== '' && !SECRET.test(part)) {
    throw new Error('ADDRESS_KEY must be letters, digits, - and _ only, 32 characters or more');
  }
  return part;
}

// The part of a call against the configured one, in constant time; never true while the addresses are off.
export function matchesPart(given, part) {
  return part !== '' && safeEqual(given, part);
}

// The credential from `Authorization: Bearer <value>`: the scheme in any case, then spaces only, the value trimmed.
function bearer(req) {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^bearer +(\S.*)$/i.exec(h) : null;
  return m ? m[1].trim() : null;
}

// The bearer credential from its header only; the slugs header first, then URL parameter.
export function resolveCall(req, url) {
  const call = {};
  call.bearer = bearer(req);
  for (const [name, header, param] of VALUES) {
    const h = req.headers[header];
    const v = typeof h === 'string' && h !== '' ? h : url.searchParams.get(param);
    call[name] = v === null || v === '' ? null : v;
  }
  return call;
}

export function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

// The two admin endpoints: the admin token, compared in constant time; else throws the 401.
export function authenticateAdmin(call, config) {
  if (!call.bearer) throw new HttpError(401, 'admin token is required');
  if (!safeEqual(call.bearer, config.admin)) throw new HttpError(401, 'wrong admin token');
}

// Every token whose authorized email is active is compared in constant time; none is looked up by an equality in SQL.
// Returns the matching row, else throws the 401. The admin token is no stored token, so it is unknown here.
export function authenticateToken(call, db, config) {
  if (!call.bearer) throw new HttpError(401, 'token is required');
  if (call.org !== null && call.org !== config.org) throw new HttpError(401, 'org slug does not match');
  let found = null;
  const rows = db.prepare(`SELECT tokens.* FROM tokens JOIN authorized_emails ON authorized_emails.id = tokens.authorized_email
    WHERE authorized_emails.active = 1`).all();
  for (const row of rows) {
    if (safeEqual(call.bearer, row.token) && !found) found = row;
  }
  if (!found) throw new HttpError(401, 'unknown token');
  return found;
}
