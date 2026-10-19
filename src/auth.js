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
  ['key', 'x-externality-key', 'externality-key'],
  ['token', 'x-consumer-token', 'consumer-token'],
];

export function loadAuthConfig(env) {
  const org = env.ORG_SLUG ?? '';
  const key = env.EXTERNALITY_KEY ?? '';
  if (!org) throw new Error('ORG_SLUG is not set');
  if (!key) throw new Error('EXTERNALITY_KEY is not set');
  return { org, key };
}

// Header first, then URL parameter.
export function resolveCall(req, url) {
  const call = {};
  for (const [name, header, param] of VALUES) {
    const h = req.headers[header];
    const v = typeof h === 'string' && h !== '' ? h : url.searchParams.get(param);
    call[name] = v === null || v === '' ? null : v;
  }
  return call;
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

// Returns null when accepted, else the refusal reason.
export function refuse(call, config) {
  if (!call.key) return 'missing externality key';
  if (!safeEqual(call.key, config.key)) return 'wrong externality key';
  if (call.org !== config.org) return 'org slug does not match the key';
  return null;
}

// Returns 'all', or the entries trimmed with duplicates dropped in the order given, or null when invalid:
// not a string, an empty entry, or `all` beside a slug.
export function parseScope(text) {
  if (typeof text !== 'string') return null;
  const entries = text.split(',').map((s) => s.trim());
  if (entries.includes('')) return null;
  const slugs = [...new Set(entries)];
  if (slugs.includes('all')) return slugs.length === 1 ? 'all' : null;
  return slugs;
}

// Every stored token is compared in constant time; none is looked up by an equality in SQL.
// Returns the matching row, else throws the 401.
export function authenticateToken(call, db, config) {
  if (!call.token) throw new HttpError(401, 'consumer token is required');
  if (call.org !== null && call.org !== config.org) throw new HttpError(401, 'org slug does not match');
  let found = null;
  for (const row of db.prepare('SELECT token, scope FROM tokens').all()) {
    if (safeEqual(call.token, row.token) && !found) found = row;
  }
  if (!found) throw new HttpError(401, 'unknown consumer token');
  return found;
}
