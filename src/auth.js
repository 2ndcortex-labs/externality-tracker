import { timingSafeEqual } from 'node:crypto';

const VALUES = [
  ['org', 'x-org-slug', 'org-slug'],
  ['atlas', 'x-atlas-slug', 'atlas-slug'],
  ['item', 'x-item-slug', 'item-slug'],
  ['key', 'x-externality-key', 'externality-key'],
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
