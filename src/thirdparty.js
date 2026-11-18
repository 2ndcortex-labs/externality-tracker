// The passing-on: after a notice is kept and answered, its text is POSTed once to the web address in its field
// `3rdparty-notice-url`, behind a guard that refuses addresses on this machine and on private networks.
// One attempt, no retry, no redirect followed; the outcome kept in one row for the whole service, the latest only.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { isHttpUrl } from './routes.js';
import { saveThirdparty } from './db.js';

export const FIELD = '3rdparty-notice-url';
// Carried by every post this service makes; a notice that arrives carrying it is kept but not passed on again,
// which ends a loop through this service's own notice address or between two such services.
export const PASSED_ON = 'x-externality-passed-on';

// The refused set: the refused ranges, filled range by range (`BlockList.PRIVATE_RANGES` needs a newer Node than the
// engines' 24), and every address the given interfaces (os.networkInterfaces()'s form) report for this machine.
export function refusedList(interfaces) {
  const list = new net.BlockList();
  for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4]]) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
    ['64:ff9b::', 96], ['64:ff9b:1::', 48]]) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      const address = String(entry?.address ?? '').replace(/%.*$/, '');
      const kind = net.isIP(address);
      if (kind !== 0) list.addAddress(address, kind === 4 ? 'ipv4' : 'ipv6');
    }
  }
  return list;
}

// Read once, at start: the machine's own addresses as its interfaces report them then.
const REFUSED = refusedList(os.networkInterfaces());

// The owner's exemptions from THIRDPARTY_ALLOW: '' exempts nothing; else comma-separated entries, each trimmed and
// each an IPv4 or IPv6 address or a CIDR subnet. Any other entry, a host name or an empty one included, throws.
// The entries are kept per family, and an address is checked against its own family's entries only: one BlockList
// would let an IPv6 entry covering ::ffff:0:0/96 (`::/1`, `::/0`) exempt IPv4 addresses.
export function parseAllow(text) {
  const lists = { ipv4: new net.BlockList(), ipv6: new net.BlockList() };
  const allow = { check: (address, type) => (type === 'ipv4' || type === 'ipv6' ? lists[type].check(address, type) : false) };
  if (text === undefined || text === '') return allow;
  for (const raw of String(text).split(',')) {
    const entry = raw.trim();
    const [address, prefix, extra] = entry.split('/');
    const kind = net.isIP(address ?? '');
    const max = kind === 4 ? 32 : 128;
    const type = kind === 4 ? 'ipv4' : 'ipv6';
    if (kind === 0 || extra !== undefined || (prefix !== undefined && !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= max))) {
      throw new Error(`THIRDPARTY_ALLOW: ${JSON.stringify(entry)} is not an IPv4 or IPv6 address or a CIDR subnet`);
    }
    if (prefix === undefined) lists[type].addAddress(address, type);
    else lists[type].addSubnet(address, Number(prefix), type);
  }
  return allow;
}

// A web address: an absolute http or https URL carrying no user and no password.
export function isWebAddress(v) {
  if (!isHttpUrl(v)) return false;
  const u = new URL(v);
  return u.username === '' && u.password === '';
}

// The eight 16-bit groups of a valid IPv6 address, a trailing dotted IPv4 part included.
function groups(v6) {
  let s = v6.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

// An address as the guard reads it: an IPv4-mapped IPv6 address (::ffff:a.b.c.d) as its IPv4 address.
function asChecked(address) {
  const kind = net.isIP(address);
  if (kind === 4) return { address, type: 'ipv4' };
  if (kind !== 6) return null;
  const g = groups(address);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return { address: `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`, type: 'ipv4' };
  }
  return { address, type: 'ipv6' };
}

// True when the guard refuses the address: not an address at all, or in a refused range and not exempt.
function refusedAddress(address, allow) {
  const a = asChecked(address);
  if (!a) return true;
  if (allow.check(a.address, a.type)) return false;
  return REFUSED.check(a.address, a.type);
}

// Resolves to { refused: true } or { refused: false, addresses: [{ address, family }] }. An address given as the host
// is checked as it stands; a name is resolved once, by `lookup` (dns.lookup's form, all: true), and refused whole when
// any of its addresses is refused. A name that does not resolve is not refused: it is an attempt that gets no answer,
// so it resolves to no addresses.
export async function resolveTarget(url, { lookup, allow = parseAllow('') } = {}) {
  if (!isWebAddress(url)) return { refused: true };
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');
  const kind = net.isIP(host);
  if (kind !== 0) return refusedAddress(host, allow) ? { refused: true } : { refused: false, addresses: [{ address: host, family: kind }] };
  let found;
  try {
    found = await new Promise((resolve, reject) => {
      lookup(host, { all: true }, (err, list) => (err ? reject(err) : resolve(list)));
    });
  } catch {
    return { refused: false, addresses: [] };
  }
  const addresses = (Array.isArray(found) ? found : []).map((x) => ({ address: x?.address, family: x?.family }));
  if (addresses.some((x) => typeof x.address !== 'string' || refusedAddress(x.address, allow))) return { refused: true };
  return { refused: false, addresses };
}

// One POST of `text` to `url`, connecting only to `addresses` (already checked): the request's own lookup answers
// them and nothing else, so no second resolution happens. No redirect is followed. Resolves to the response's status,
// 0 when none came within `timeout` ms; never rejects.
function send(url, text, addresses, timeout) {
  if (addresses.length === 0) return Promise.resolve(0);
  const checked = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const family = typeof options === 'number' ? options : options?.family;
    const list = family === 4 || family === 6 ? addresses.filter((x) => x.family === family) : addresses;
    if (list.length === 0) return process.nextTick(() => callback(Object.assign(new Error('no checked address'), { code: 'ENOTFOUND' })));
    process.nextTick(() => (options?.all ? callback(null, list) : callback(null, list[0].address, list[0].family)));
  };
  const body = Buffer.from(text, 'utf8');
  const client = new URL(url).protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let done = false;
    const settle = (status) => { if (!done) { done = true; resolve(status); } };
    try {
      const req = client.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length, [PASSED_ON]: '1' },
        lookup: checked,
        agent: false,
        signal: AbortSignal.timeout(timeout),
      }, (res) => {
        settle(res.statusCode);
        res.resume();
        res.on('error', () => {});
      });
      req.on('error', () => settle(0));
      req.end(body);
    } catch {
      settle(0);
    }
  });
}

// The guard and the post together, `lookup` called once: the status, 0 when refused or when no response came.
export async function postOnce(url, text, { lookup, allow, timeout }) {
  const target = await resolveTarget(url, { lookup, allow });
  if (target.refused) return 0;
  return send(url, text, target.addresses, timeout);
}

// After a notice is kept and answered: its record's address read, guarded, posted to once, the outcome written.
// A bad or refused address makes no attempt and no row. Never rejects; the server never awaits it.
export async function passOn(db, record, text, { allow, timeout }) {
  try {
    const url = record?.[FIELD];
    if (!isWebAddress(url)) return;
    const date = new Date().toISOString();
    const target = await resolveTarget(url, { lookup: dns.lookup, allow });
    if (target.refused) return;
    saveThirdparty(db, date, await send(url, text, target.addresses, timeout));
  } catch {
    // nothing reaches the server
  }
}
