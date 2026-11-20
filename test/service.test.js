import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from '../src/server.js';
import { timeoutMs } from '../src/deliver.js';
import { loadAddressKey, loadAdminToken } from '../src/auth.js';
import { LIMITS, makeLimiter } from '../src/routes.js';
import { openDb } from '../src/db.js';
import { networkInterfaces } from 'node:os';
import { parseAllow, resolveTarget, postOnce, refusedList } from '../src/thirdparty.js';

const ORG = 'test-org';
const OLD_KEY = 'test-key-0123456789'; // a value of the old org key's kind: it opens nothing now
const ADMIN = randomBytes(32).toString('base64url'); // the test servers' ADMIN_TOKEN, never printed
const HOLDER = 'holder@example.org'; // every address here is a made-up one at example.org
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELIVERY_TIMEOUT = 400; // the test server's DELIVERY_TIMEOUT_MS
const NEGATIVE_WAIT = DELIVERY_TIMEOUT + 300; // a wait for nothing to arrive: the timeout and a margin
const URL_REASON = 'url must be an absolute http or https URL';
const ADDRESS_REASON = 'email must be one address: one @, text on both sides, no space and no +';
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const REFUSED = { status: 401, json: { error: 'refused' } };
const DROPPED = 'externality-tracker: dropped old tables externalities, notices, tokens';
// The main and address servers serve many tests from one caller, so each is given numbers no test reaches; the limit's
// own tests (A9, A10) and every other server run on LIMITS, the service's own numbers.
const ROOMY = { perCaller: 1_000_000, total: 1_000_000 };

let server;
let base;
let dataDir;
let TOKEN; // HOLDER's token on the main server, never printed

const listenOn = async (s) => {
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${s.address().port}`;
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'externality-tracker-'));
  server = createServer({ ORG_SLUG: ORG, ADMIN_TOKEN: ADMIN, DATA_DIR: dataDir, DELIVERY_TIMEOUT_MS: String(DELIVERY_TIMEOUT) },
    { limits: ROOMY });
  base = await listenOn(server);
  await listEmail(base, HOLDER);
  TOKEN = (await tokenAt(base, HOLDER)).token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(b, method, path, { headers = {}, params = {}, body, raw } = {}) {
  const url = new URL(path, b);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  if (init.body !== undefined) init.headers['content-type'] = 'application/json';
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const call = (method, path, opts) => request(base, method, path, opts);

const bearer = (token) => ({ 'Authorization': `Bearer ${token}` });
const asAdmin = bearer(ADMIN);

// A token call: the bearer token and the slugs.
const byToken = (token, atlas, item, extra = {}) => ({
  ...bearer(token),
  ...(atlas ? { 'X-Atlas-Slug': atlas } : {}), ...(item ? { 'X-Item-Slug': item } : {}), ...extra,
});
const read = (atlas, item, extra) => byToken(TOKEN, atlas, item, extra);

// The admin endpoints and the ask, against any server. No failure message carries a token.
async function listEmail(b, email) {
  const r = await request(b, 'POST', '/emails', { headers: asAdmin, body: { email } });
  assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.json));
  return r.json;
}

async function activate(b, email, active) {
  const r = await request(b, 'POST', '/emails/active', { headers: asAdmin, body: { email, active } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

const askAt = (b, email, extra = {}, headers = {}) => request(b, 'POST', '/tokens', { headers, body: { email, ...extra } });

async function tokenAt(b, email, extra) {
  const r = await askAt(b, email, extra);
  assert.ok(r.status === 201 || r.status === 200, r.json && r.json.error);
  return r.json;
}

let asked = 0;
const variation = () => `holder+t${++asked}@example.org`;
// A token of its own on the main server: a new variation of HOLDER, with the URL when given.
const newToken = (url) => tokenAt(base, variation(), url === undefined ? {} : { url });

const openMain = () => new DatabaseSync(join(dataDir, 'externalities.sqlite'));

const BODY = { 'what': 'a thing is true', 'who-acts': 'the operator', 'how-observed': 'by a check' };

test('precedence: org-slug from header, param, header wins', async () => {
  const h = read();
  assert.equal((await call('GET', '/token', { headers: { ...h, 'X-Org-Slug': ORG } })).status, 200);
  assert.equal((await call('GET', '/token', { headers: h, params: { 'org-slug': ORG } })).status, 200);
  assert.equal((await call('GET', '/token', { headers: { ...h, 'X-Org-Slug': ORG }, params: { 'org-slug': 'wrong' } })).status, 200);
  assert.equal((await call('GET', '/token', { headers: { ...h, 'X-Org-Slug': 'wrong' }, params: { 'org-slug': ORG } })).status, 401);
});

// The token is read from `Authorization: Bearer <token>` only; no assertion message carries it.
test('bearer: the scheme case-insensitively, the token trimmed; another scheme, an empty value, an old header and a parameter are missing', async () => {
  const s = { 'X-Atlas-Slug': 'bearer-atlas', 'X-Item-Slug': 'bearer-item' };
  for (const [label, headers] of [
    ['Bearer <token>', { ...s, 'Authorization': `Bearer ${TOKEN}` }],
    ['BEARER, two spaces, a trailing space', { ...s, 'authorization': `BEARER  ${TOKEN} ` }],
  ]) {
    const r = await call('GET', '/token', { headers });
    assert.equal(r.status, 200, `${label}: ${r.json && r.json.error}`);
  }
  for (const [label, headers, params, reason] of [
    ['another scheme', { ...s, 'Authorization': `Basic ${TOKEN}` }, {}, 'token is required'],
    ['the scheme alone', { ...s, 'Authorization': 'Bearer' }, {}, 'token is required'],
    ['the scheme and a space', { ...s, 'Authorization': 'Bearer ' }, {}, 'token is required'],
    ['a tab after the scheme', { ...s, 'Authorization': `Bearer\t${TOKEN}` }, {}, 'token is required'],
    ['the old key header', { ...s, 'X-Externality-Key': TOKEN }, {}, 'token is required'],
    ['the old token header', { ...s, 'X-Consumer-Token': TOKEN }, {}, 'token is required'],
    ['a parameter', s, { 'token': TOKEN }, 'token is required'],
    ['a wrong token', { ...s, 'Authorization': 'Bearer wrong' }, {}, 'unknown token'],
    ['another org', { ...s, 'X-Org-Slug': 'other', 'Authorization': `Bearer ${TOKEN}` }, {}, 'org slug does not match'],
  ]) {
    const r = await call('GET', '/token', { headers, params });
    assert.equal(r.status, 401, label);
    assert.equal(r.json.error, reason, label);
  }
});

test('auth: a wrong token, no token or another org is 401 with a reason', async () => {
  for (const [headers, reason] of [
    [{ 'X-Org-Slug': ORG, 'Authorization': 'Bearer wrong' }, 'unknown token'],
    [{ 'X-Org-Slug': ORG }, 'token is required'],
    [{ 'X-Org-Slug': 'another-org', 'Authorization': `Bearer ${TOKEN}` }, 'org slug does not match'],
  ]) {
    for (const [method, path] of [['GET', '/token'], ['GET', '/thirdparty']]) {
      const r = await call(method, path, { headers });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(r.json.error, reason, `${method} ${path}`);
    }
  }
});

test('bad body is 400, unknown id 404, DELETE and unknown routes 404', async () => {
  // No route reads by an id any more; a bad body is refused by the routes that take one.
  let r = await call('POST', '/tokens', { raw: '{not json' });
  assert.equal(r.status, 400);
  assert.equal(typeof r.json.error, 'string');
  assert.equal((await call('POST', '/tokens', { body: [1, 2] })).status, 400);
  assert.equal((await call('POST', '/emails', { headers: asAdmin, raw: '' })).status, 400);
  assert.equal((await call('POST', '/emails/active', { headers: asAdmin, body: { email: 'missing@example.org', active: true } })).status, 404);
  for (const path of ['/', '/token', '/thirdparty', '/tokens', '/emails', '/emails/active', '/elsewhere']) {
    for (const headers of [read(), asAdmin]) {
      r = await call('DELETE', path, { headers, body: { email: HOLDER } });
      assert.equal(r.status, 404, `DELETE ${path}`);
      assert.equal(typeof r.json.error, 'string');
    }
  }
  for (const [method, path] of [['GET', '/elsewhere'], ['POST', '/token'], ['PUT', '/thirdparty'], ['POST', '/'],
    ['GET', '/tokens'], ['GET', '/emails'], ['PUT', '/emails'], ['PATCH', '/emails/active'], ['POST', '/emails/delete']]) {
    assert.equal((await call(method, path, { headers: read() })).status, 404, `${method} ${path}`);
  }
  assert.equal((await call('GET', '/token', { headers: read() })).status, 200, 'the listed address was not removed');
});

test("url parameters: no credential is read from one; the slugs' parameters still are", async () => {
  const slugs = { 'X-Org-Slug': ORG };
  for (const [method, path, opts] of [
    ['GET', '/token', {}],
    ['GET', '/thirdparty', {}],
  ]) {
    for (const name of ['token', 'consumer-token', 'externality-key', 'authorization']) {
      const r = await call(method, path, { ...opts, headers: slugs, params: { ...opts.params, [name]: TOKEN } });
      assert.equal(r.status, 401, `${method} ${path} by ${name}`);
      assert.equal(r.json.error, 'token is required', `${method} ${path} by ${name}`);
    }
  }
  for (const [path, body] of [['/emails', { email: 'urlp@example.org' }], ['/emails/active', { email: HOLDER, active: false }]]) {
    for (const name of ['admin-token', 'token', 'authorization']) {
      const r = await call('POST', path, { params: { [name]: ADMIN }, body });
      assert.equal(r.status, 401, `${path} by ${name}`);
      assert.equal(r.json.error, 'admin token is required', `${path} by ${name}`);
    }
  }

  // The org slug, the one slug left, as a parameter beside the bearer header, on GET /token and GET /thirdparty.
  assert.equal((await call('GET', '/thirdparty', { headers: read(), params: { 'org-slug': ORG } })).status, 200);
  let r = await call('GET', '/token', { headers: read(), params: { 'org-slug': ORG } });
  assert.equal(r.status, 200, r.json && r.json.error);
  r = await call('GET', '/token', { headers: read(), params: { 'org-slug': 'another-org' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'org slug does not match');
});

test('org slug: optional on a token call, refused when it differs; another org is absent', async () => {
  const h = read();
  for (const [method, path] of [['GET', '/token'], ['GET', '/thirdparty']]) {
    for (const extra of [{}, { 'X-Org-Slug': ORG }]) {
      assert.equal((await call(method, path, { headers: { ...h, ...extra } })).status, 200, `${method} ${path}`);
    }
    assert.equal((await call(method, path, { headers: h, params: { 'org-slug': ORG } })).status, 200);
    for (const req of [{ headers: { ...h, 'X-Org-Slug': 'another-org' } }, { headers: h, params: { 'org-slug': 'another-org' } }]) {
      const r = await call(method, path, req);
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(r.json.error, 'org slug does not match');
    }
  }
  // Another org is absent: its slug opens nothing, a notice's status read included.
  const s = await oneWay();
  try {
    const t = await s.token();
    assert.deepEqual(await s.notify(t, notice('feature/org-other', 'open')), KEPT);
    const r = await s.statusOf(t, 'feature/org-other', { headers: { 'X-Org-Slug': 'another-org' } });
    assert.deepEqual(r, { status: 401, json: { error: 'org slug does not match' } });
  } finally {
    await s.close();
  }
});

test('the limit: a count ends one window after its first ask, per caller and for the service', () => {
  assert.deepEqual(LIMITS, { perCaller: 5, total: 60, windowMs: 60_000 });
  let t = 0;
  const may = makeLimiter({ perCaller: 2, total: 3, windowMs: 1000 }, () => t);
  assert.equal(may('a'), true);
  assert.equal(may('a'), true);
  assert.equal(may('a'), false, "over the caller's number");
  assert.equal(may('b'), false, "b's first, over the service's number");
  t = 999;
  assert.equal(may('b'), false, 'both windows still open');
  t = 1000;
  assert.equal(may('a'), true, 'a window ends one window after its first ask');
});

test('the limit: posts over the service-wide number, from many callers, add no caller window; ended windows are swept', () => {
  let t = 0;
  const may = makeLimiter({ perCaller: 5, total: 3, windowMs: 1000 }, () => t);
  for (const caller of ['a', 'b', 'c']) assert.equal(may(caller), true);
  assert.equal(may.callers(), 3);
  for (let i = 0; i < 500; i++) assert.equal(may(`198.51.100.${i}`), false, 'over the service-wide number');
  assert.equal(may.callers(), 3, 'no window made or kept for a refused caller');
  t = 999;
  assert.equal(may('d'), false, 'every post counted toward the service, the refused ones included');
  assert.equal(may.callers(), 3);
  t = 1000;
  assert.equal(may('e'), true, 'a new window for the service');
  assert.equal(may.callers(), 1, "the ended callers' windows are swept");
});

// Asking for a token, in the service's own tests against a local service.

test('A1: an authorized address gets 201 and a token, no credential sent; a second ask bearing that token gets 200 and a new token', async () => {
  await listEmail(base, 'first@example.org');
  const one = await call('POST', '/tokens', { body: { email: 'first@example.org' } });
  assert.equal(one.status, 201, one.json && one.json.error);
  assert.deepEqual(Object.keys(one.json), ['token', 'url', 'date']);
  assert.ok(BASE64URL_32_BYTES.test(one.json.token), 'the token is 32 bytes as base64url');
  assert.equal(one.json.url, null);
  assert.match(one.json.date, ISO);
  const two = await call('POST', '/tokens', { headers: bearer(one.json.token), body: { email: 'first@example.org' } });
  assert.equal(two.status, 200, two.json && two.json.error);
  assert.deepEqual(Object.keys(two.json), ['token', 'url', 'date']);
  assert.ok(two.json.token !== one.json.token, 'a new token');
  assert.match(two.json.date, ISO);
  assert.equal((await call('GET', '/token', { headers: bearer(two.json.token) })).status, 200, 'the new token opens a token route');
  const db = openMain();
  try {
    const rows = db.prepare('SELECT email, token FROM tokens WHERE email = ?').all('first@example.org');
    assert.equal(rows.length, 1, 'one token, stored next to its address');
    assert.ok(rows[0].token === two.json.token, 'the stored token is the one last returned');
  } finally {
    db.close();
  }
});

test('A2: an unlisted address, a deactivated one and a variation of each get the same status and body', async () => {
  await listEmail(base, 'gone@example.org');
  await tokenAt(base, 'gone@example.org');
  await activate(base, 'gone@example.org', false);
  for (const email of ['nobody@example.org', 'nobody+x@example.org', 'gone@example.org', 'gone+x@example.org', 'gone+@example.org']) {
    assert.deepEqual(await askAt(base, email), REFUSED, email);
  }
});

test('A3: an address asked in capitals, with spaces around it, gets its token', async () => {
  await listEmail(base, 'caps@example.org');
  const first = await askAt(base, '  CAPS@Example.ORG \t');
  assert.equal(first.status, 201, first.json && first.json.error);
  const plain = await askAt(base, 'caps@example.org', {}, bearer(first.json.token));
  assert.equal(plain.status, 200, 'the token asked in capitals is the plain address\'s');
  assert.ok(plain.json.token !== first.json.token, 'renewed');
  const loud = await askAt(base, ' Caps+Work@EXAMPLE.org ');
  assert.equal(loud.status, 201, loud.json && loud.json.error);
  const quiet = await askAt(base, 'caps+work@example.org', {}, bearer(loud.json.token));
  assert.equal(quiet.status, 200, 'a variation in capitals is the same variation');
  assert.ok(quiet.json.token !== loud.json.token, 'renewed');
});

test('A4: an ask naming a URL stores it, another replaces it, a bare ask keeps it, null clears it; each later ask bears the current token', async () => {
  const email = 'forward@example.org';
  await listEmail(base, email);
  const u1 = 'http://127.0.0.1:1/hook?x=1&y=two';
  const u2 = 'https://example.org/second';
  const urlOf = async (token) => (await call('GET', '/token', { headers: bearer(token) })).json.url;
  let r = await askAt(base, email, { url: u1 });
  assert.equal(r.status, 201, r.json && r.json.error);
  assert.equal(r.json.url, u1);
  let token = r.json.token;
  assert.equal(await urlOf(token), u1);
  for (const [label, extra, code, url] of [
    ['another URL', { url: u2 }, 200, u2],
    ['a bare ask', {}, 200, u2],
    ['null', { url: null }, 200, null],
    ['a bare ask after null', {}, 200, null],
  ]) {
    r = await askAt(base, email, extra, bearer(token));
    assert.equal(r.status, code, label);
    assert.equal(r.json.url, url, label);
    assert.ok(r.json.token !== token, `${label}: a new token`);
    token = r.json.token;
    assert.equal(await urlOf(token), url, `${label}: as stored`);
  }
});

test('A5: a body with no email, and one with a url that is no web address, each answer 400', async () => {
  for (const body of [{}, { email: '' }, { email: '   ' }, { email: 42 }, { email: [HOLDER] }, { email: null }, { url: 'https://example.org' }]) {
    const r = await call('POST', '/tokens', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'email must be a non-empty string');
  }
  for (const url of ['ftp://x', 'not a url', 42, '', '/relative', { href: 'https://example.org' }, false]) {
    const r = await askAt(base, HOLDER, { url });
    assert.equal(r.status, 400, JSON.stringify(url));
    assert.equal(r.json.error, URL_REASON);
  }
  let r = await call('POST', '/tokens', { body: [1] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'body must be a JSON object');
  r = await call('POST', '/tokens', { raw: '{not json' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'body is not valid JSON');
  assert.equal((await call('GET', '/token', { headers: read() })).json.url, null, 'nothing was stored by a refused ask');
});

// Variations and the limit, in the same tests.

test('A6: a variation of an authorized address, never added, gets 201 and a token', async () => {
  await listEmail(base, 'plus@example.org');
  const r = await askAt(base, 'plus+anything@example.org');
  assert.equal(r.status, 201, r.json && r.json.error);
  assert.ok(BASE64URL_32_BYTES.test(r.json.token));
  const db = openMain();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM authorized_emails WHERE email LIKE 'plus+%'").get().n, 0, 'the variation is not listed');
    const row = db.prepare('SELECT authorized_email FROM tokens WHERE email = ?').get('plus+anything@example.org');
    const listed = db.prepare('SELECT id FROM authorized_emails WHERE email = ?').get('plus@example.org');
    assert.equal(row.authorized_email, listed.id, 'the token row is keyed to its authorized address');
  } finally {
    db.close();
  }
});

test("A7: a variation's token differs from its authorized address's and from a second variation's; each renews its own", async () => {
  await listEmail(base, 'split@example.org');
  const emails = ['split@example.org', 'split+one@example.org', 'split+two@example.org'];
  const first = [];
  for (const email of emails) {
    const r = await askAt(base, email);
    assert.equal(r.status, 201, email);
    first.push(r.json.token);
  }
  assert.equal(new Set(first).size, 3, 'three different tokens');
  for (const [i, email] of emails.entries()) {
    const r = await askAt(base, email, {}, bearer(first[i]));
    assert.equal(r.status, 200, email);
    assert.ok(r.json.token !== first[i], `${email}: renewed`);
  }
});

test('A8: a further variation gets a token however many exist, one with no text after its "+" among them', async () => {
  await listEmail(base, 'crowd@example.org');
  const seen = new Set();
  for (const tag of ['', ...Array.from({ length: 40 }, (_, i) => `n${i}`)]) {
    const r = await askAt(base, `crowd+${tag}@example.org`);
    assert.equal(r.status, 201, `crowd+${tag}`);
    seen.add(r.json.token);
  }
  assert.equal(seen.size, 41, 'each variation its own token');
  const more = await askAt(base, 'crowd+one.more@example.org');
  assert.equal(more.status, 201, 'one more after them all');
});

// A server of its own on LIMITS, the service's own numbers.
async function limitServer() {
  const s = createServer({ ORG_SLUG: ORG, ADMIN_TOKEN: ADMIN, DATA_DIR: mkdtempSync(join(dataDir, 'limit-')) });
  const b = await listenOn(s);
  return { base: b, close: async () => { s.closeAllConnections(); await new Promise((resolve) => s.close(resolve)); } };
}

test('A9: the sixth post from one caller within a minute gets 429, whatever the five before it answered', async () => {
  const s = await limitServer();
  try {
    await listEmail(s.base, 'limit@example.org');
    const from = { 'X-Real-IP': '203.0.113.9' };
    const answers = [];
    let current; // the address's then-current token: a later ask bears it
    for (const { renew, ...opts } of [
      { body: { email: 'limit@example.org' } },
      { body: { email: 'nobody@example.org' } },
      { body: {} },
      { body: { email: 'limit@example.org' }, renew: true },
      { raw: '{not json' },
    ]) {
      const r = await request(s.base, 'POST', '/tokens', { headers: renew ? { ...from, ...bearer(current) } : from, ...opts });
      if (r.json && r.json.token) current = r.json.token;
      answers.push(r.status);
    }
    assert.deepEqual(answers, [201, 401, 400, 200, 400]);
    const sixth = await request(s.base, 'POST', '/tokens', { headers: from, body: { email: 'limit@example.org' } });
    assert.deepEqual(sixth, { status: 429, json: { error: 'too many asks' } });
    const another = await request(s.base, 'POST', '/tokens', { headers: { 'X-Real-IP': '203.0.113.10', ...bearer(current) }, body: { email: 'limit@example.org' } });
    assert.equal(another.status, 200, "another caller is not held by this one's count");
    // Without X-Real-IP the connection's own address is the caller.
    for (let i = 0; i < 5; i++) {
      assert.equal((await request(s.base, 'POST', '/tokens', { body: { email: 'nobody@example.org' } })).status, 401);
    }
    const last = await request(s.base, 'POST', '/tokens', { body: { email: 'limit@example.org' } });
    assert.deepEqual(last, { status: 429, json: { error: 'too many asks' } });
  } finally {
    await s.close();
  }
});

test('A10: the sixty-first post within a minute, from many callers, gets 429', async () => {
  const s = await limitServer();
  try {
    await listEmail(s.base, 'busy@example.org');
    for (let caller = 1; caller <= 12; caller++) {
      for (let i = 0; i < 5; i++) {
        const email = i % 2 === 0 ? 'busy@example.org' : 'nobody@example.org';
        const r = await request(s.base, 'POST', '/tokens', { headers: { 'X-Real-IP': `198.51.100.${caller}` }, body: { email } });
        assert.notEqual(r.status, 429, `post ${(caller - 1) * 5 + i + 1}`);
      }
    }
    const r = await request(s.base, 'POST', '/tokens', { headers: { 'X-Real-IP': '198.51.100.200' }, body: { email: 'busy@example.org' } });
    assert.deepEqual(r, { status: 429, json: { error: 'too many asks' } }, 'the sixty-first, from a caller of its first ask');
  } finally {
    await s.close();
  }
});

// The email list, in the same tests.

test('A11: with the admin token, adding a new address answers 201; it gets a token at its first ask; a url sent with the add is stored nowhere', async () => {
  const r = await call('POST', '/emails', { headers: asAdmin, body: { email: 'added@example.org', url: 'http://127.0.0.1:1/never', active: false, token: 'x' } });
  assert.deepEqual(r, { status: 201, json: { email: 'added@example.org', active: true } });
  const t = await askAt(base, 'added@example.org');
  assert.equal(t.status, 201, t.json && t.json.error);
  assert.equal(t.json.url, null, 'the url of the add is not the token\'s');
  const db = openMain();
  try {
    assert.deepEqual(db.prepare('PRAGMA table_info(authorized_emails)').all().map((c) => c.name), ['id', 'email', 'active']);
    assert.equal(db.prepare('SELECT active FROM authorized_emails WHERE email = ?').get('added@example.org').active, 1);
    assert.equal(db.prepare('SELECT url FROM tokens WHERE email = ?').get('added@example.org').url, null);
  } finally {
    db.close();
  }
});

test('A12: adding a known address answers 200 and changes nothing, a deactivated one staying inactive', async () => {
  const add = (email) => call('POST', '/emails', { headers: asAdmin, body: { email } });
  assert.deepEqual(await add('known@example.org'), { status: 201, json: { email: 'known@example.org', active: true } });
  assert.deepEqual(await add('known@example.org'), { status: 200, json: { email: 'known@example.org', active: true } });
  assert.deepEqual(await add('  KNOWN@Example.ORG '), { status: 200, json: { email: 'known@example.org', active: true } }, 'trimmed and lowered');
  await activate(base, 'known@example.org', false);
  assert.deepEqual(await add('known@example.org'), { status: 200, json: { email: 'known@example.org', active: false } });
  assert.deepEqual(await askAt(base, 'known@example.org'), REFUSED, 'still inactive');
  const db = openMain();
  try {
    assert.deepEqual(db.prepare('SELECT active FROM authorized_emails WHERE email = ?').all('known@example.org').map((r) => r.active), [0], 'one row, inactive');
  } finally {
    db.close();
  }
});

test("A13: deactivating an address refuses its token, its asks and its variations' with no restart; activating restores the same tokens and their records", async () => {
  // On the server with the notice address on, so each token keeps a notice of its own.
  await listEmail(partBase, 'toggle@example.org');
  const plain = (await tokenAt(partBase, 'toggle@example.org')).token;
  const varied = (await tokenAt(partBase, 'toggle+v@example.org')).token;
  const item = 'feature/toggle';
  const sent = {};
  for (const [name, token] of [['plain', plain], ['varied', varied]]) {
    sent[name] = notice(item, 'open', { what: `sent by ${name}` });
    const r = await at('POST', `/${PART}/notify`, { headers: bearer(token), body: sent[name] });
    assert.equal(r.status, 201, r.json && r.json.error);
  }
  await activate(partBase, 'toggle@example.org', false);
  for (const token of [plain, varied]) {
    for (const [method, path, opts] of [['GET', '/token', {}], ['GET', '/thirdparty', {}], ['POST', `/${PART}/notify`, { body: notice(item, 'open') }],
      ['GET', statusPath(item), {}]]) {
      const r = await at(method, path, { ...opts, headers: bearer(token) });
      assert.deepEqual(r, { status: 401, json: { error: 'unknown token' } }, method);
    }
  }
  for (const email of ['toggle@example.org', 'toggle+v@example.org', 'toggle+new@example.org']) {
    assert.deepEqual(await askAt(partBase, email), REFUSED, email);
  }
  await activate(partBase, 'toggle@example.org', true);
  for (const [email, token, name] of [['toggle@example.org', plain, 'plain'], ['toggle+v@example.org', varied, 'varied']]) {
    const st = await at('GET', statusPath(item), { headers: bearer(token) });
    assert.equal(st.status, 200, email);
    assert.deepEqual(st.json, [sent[name]], `${email}: its notice is back`);
    const again = await askAt(partBase, email, {}, bearer(token));
    assert.equal(again.status, 200, `${email}: the same token asks again`);
    assert.ok(again.json.token !== token, `${email}: renewed`);
  }
});

test('A14: an unknown address on the activate endpoint answers 404; a malformed address, one holding a "+" among them, answers 400 on both', async () => {
  const r = await call('POST', '/emails/active', { headers: asAdmin, body: { email: 'unknown@example.org', active: false } });
  assert.deepEqual(r, { status: 404, json: { error: 'unknown email' } });
  for (const email of ['no-at', 'two@@example.org', 'a@b@example.org', '@example.org', 'name@', 'sp ace@example.org',
    'tab\t@example.org', 'plus+tag@example.org', '+@example.org', '', '   ', 42, null, undefined]) {
    for (const path of ['/emails', '/emails/active']) {
      const body = email === undefined ? { active: true } : { email, active: true };
      const res = await call('POST', path, { headers: asAdmin, body });
      assert.deepEqual(res, { status: 400, json: { error: ADDRESS_REASON } }, `${path} ${JSON.stringify(email)}`);
    }
  }
  for (const active of ['true', 1, null, undefined]) {
    const body = active === undefined ? { email: HOLDER } : { email: HOLDER, active };
    const res = await call('POST', '/emails/active', { headers: asAdmin, body });
    assert.deepEqual(res, { status: 400, json: { error: 'active must be true or false' } }, JSON.stringify(active));
  }
  for (const body of [[1], 'text']) {
    assert.equal((await call('POST', '/emails', { headers: asAdmin, body })).status, 400);
  }
  const db = openMain();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM authorized_emails WHERE email LIKE '%+%' OR email LIKE '% %'").get().n, 0);
  } finally {
    db.close();
  }
});

test("A15: both admin endpoints answer 401 with no bearer, a wrong one and a holder's token", async () => {
  for (const [path, body] of [['/emails', { email: 'locked@example.org' }], ['/emails/active', { email: HOLDER, active: false }]]) {
    for (const [label, headers, reason] of [
      ['no bearer', {}, 'admin token is required'],
      ['another scheme', { 'Authorization': `Basic ${ADMIN}` }, 'admin token is required'],
      ['a wrong one', bearer('wrong'), 'wrong admin token'],
      ['a near one', bearer(ADMIN.slice(0, -1)), 'wrong admin token'],
      ["a holder's token", bearer(TOKEN), 'wrong admin token'],
      ['the old org key', { ...bearer(OLD_KEY), 'X-Org-Slug': ORG }, 'wrong admin token'],
    ]) {
      const r = await call('POST', path, { headers, body });
      assert.deepEqual(r, { status: 401, json: { error: reason } }, `${path}: ${label}`);
    }
    const r = await call('POST', path, { raw: '{not json' });
    assert.deepEqual(r, { status: 401, json: { error: 'admin token is required' } }, `${path}: the admin token comes before the body`);
  }
  assert.deepEqual(await askAt(base, 'locked@example.org'), REFUSED, 'nothing was added');
  assert.equal((await call('GET', '/token', { headers: read() })).status, 200, 'nothing was deactivated');
});

// The admin token and every other call, in the same tests.

// Starts the service as `npm start` would, with the given variables; resolves when it exits or once it listens (then it is
// stopped). No variable here is printed.
function launch(env) {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: '0', ...env } });
  let out = '';
  let err = '';
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      if (/listening/.test(out)) child.kill();
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
  });
}

test('A17: the service refuses to start with ADMIN_TOKEN unset or malformed, and starts with EXTERNALITY_KEY unset', async () => {
  assert.equal(loadAdminToken({ ADMIN_TOKEN: ADMIN }), ADMIN);
  for (const bad of [undefined, '', 'a'.repeat(31), `${'a'.repeat(31)}.`, ` ${'a'.repeat(32)}`, `${'a'.repeat(31)}é`]) {
    assert.throws(() => loadAdminToken(bad === undefined ? {} : { ADMIN_TOKEN: bad }), /ADMIN_TOKEN/, `${String(bad).length} characters`);
    const r = await launch({ ORG_SLUG: ORG, DATA_DIR: mkdtempSync(join(dataDir, 'start-')), ...(bad === undefined ? {} : { ADMIN_TOKEN: bad }) });
    assert.notEqual(r.code, null, 'exited on its own');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /refusing to start: ADMIN_TOKEN/);
    assert.doesNotMatch(r.out, /listening/);
  }
  const noOrg = await launch({ ADMIN_TOKEN: ADMIN, DATA_DIR: mkdtempSync(join(dataDir, 'start-')) });
  assert.notEqual(noOrg.code, 0);
  assert.match(noOrg.err, /refusing to start: ORG_SLUG/);
  const ok = await launch({ ORG_SLUG: ORG, ADMIN_TOKEN: ADMIN, DATA_DIR: mkdtempSync(join(dataDir, 'start-')) });
  assert.match(ok.out, /listening/, 'started with EXTERNALITY_KEY unset');
  assert.equal(ok.signal, 'SIGTERM', 'stopped by the test, not exited');
  assert.doesNotMatch(ok.err, /refusing/);
});

// The token routes of the route table, the four retired calls no longer among them (each now answers as an unknown route).
const TOKEN_ROUTES = (atlas, item) => [
  ['GET', '/token', {}],
  ['GET', '/thirdparty', {}],
].map(([method, path, opts]) => [method, path, { ...opts, slugs: { 'X-Atlas-Slug': atlas, 'X-Item-Slug': item } }]);

test('A18: the admin token, sent as bearer, is refused by every route but the two admin endpoints', async () => {
  for (const [method, path, { slugs, ...opts }] of TOKEN_ROUTES('a18', 'a18-item')) {
    const r = await call(method, path, { ...opts, headers: { ...asAdmin, ...slugs } });
    assert.deepEqual(r, { status: 401, json: { error: 'unknown token' } }, `${method} ${path}`);
  }
  for (const [method, path, opts] of [['POST', `/${PART}/notify`, { body: notice('feature/a18', 'open') }], ['GET', statusPath('feature/a18')]]) {
    const r = await at(method, path, { ...opts, headers: asAdmin });
    assert.deepEqual(r, { status: 401, json: { error: 'unknown token' } }, `${method} at an open address`);
  }
  assert.deepEqual(await askAt(base, 'a18@example.org', {}, asAdmin), REFUSED, 'the tokens endpoint reads no credential: the admin token opens nothing there');
  assert.equal((await call('POST', '/emails', { headers: asAdmin, body: { email: 'a18@example.org' } })).status, 201, 'the admin endpoints take it');
});

test('A19: every route but POST /tokens, GET / and the admin endpoints answers 401 with no token, with X-Consumer-Token alone, and with the old org key as bearer', async () => {
  const variants = (token) => [
    ['no token', { 'X-Org-Slug': ORG }, 'token is required'],
    ['X-Consumer-Token alone', { 'X-Consumer-Token': token }, 'token is required'],
    ['the old org key as bearer', { 'X-Org-Slug': ORG, ...bearer(OLD_KEY) }, 'unknown token'],
  ];
  for (const [method, path, { slugs, ...opts }] of TOKEN_ROUTES('a19', 'a19-item')) {
    for (const [label, headers, reason] of variants(TOKEN)) {
      const r = await call(method, path, { ...opts, headers: { ...headers, ...slugs } });
      assert.deepEqual(r, { status: 401, json: { error: reason } }, `${method} ${path}: ${label}`);
    }
  }
  for (const [method, path, opts] of [['POST', `/${PART}/notify`, { body: notice('feature/a19', 'open') }], ['GET', statusPath('feature/a19')]]) {
    for (const [label, headers, reason] of variants(PART_TOKEN)) {
      const r = await at(method, path, { ...opts, headers });
      assert.deepEqual(r, { status: 401, json: { error: reason } }, `${method} at an open address: ${label}`);
    }
  }
  assert.deepEqual(await statusOf('feature/a19'), [], 'nothing was kept');
});

test('A20: GET / answers 200 with its four fields and no credential', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['node', 'ok', 'service', 'started']);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.service, 'externality-tracker');
  assert.equal(r.json.node, process.version);
  assert.match(r.json.started, ISO);
});

test('A21: at an open address a wrong part answers 404; the right part with no token answers 401; with a token, the notice is kept', async () => {
  const item = 'feature/a21';
  let wrong = randomBytes(32).toString('base64url');
  while (wrong === PART) wrong = randomBytes(32).toString('base64url');
  for (const headers of [{}, bearer(PART_TOKEN)]) {
    assert.deepEqual(await at('POST', `/${wrong}/notify`, { headers, body: notice(item, 'open') }), NOT_FOUND);
    assert.deepEqual(await at('GET', `/${wrong}/status?item=${encodeURIComponent(item)}`, { headers }), NOT_FOUND);
  }
  for (const [label, headers, reason] of [
    ['no token', {}, 'token is required'],
    ['a made-up token', bearer('made-up'), 'unknown token'],
    ['the old header', { 'X-Consumer-Token': PART_TOKEN }, 'token is required'],
  ]) {
    assert.deepEqual(await at('POST', `/${PART}/notify`, { headers, body: notice(item, 'open') }), { status: 401, json: { error: reason } }, `notify: ${label}`);
    assert.deepEqual(await at('GET', statusPath(item), { headers }), { status: 401, json: { error: reason } }, `status: ${label}`);
  }
  const kept = await post(notice(item, 'open'));
  assert.deepEqual(Object.keys(kept), ['id']);
  assert.deepEqual(await statusOf(item), [notice(item, 'open')], 'kept once, the refused posts not at all');
});

test('A22: a token adds a record and reads the third-party outcome', async () => {
  // The record is a notice, kept on the server with the notice address on.
  const t = (await tokenAt(partBase, variation())).token;
  const r = await at('POST', `/${PART}/notify`, { headers: bearer(t), body: notice('feature/a22', 'open') });
  assert.equal(r.status, 201, r.json && r.json.error);
  const o = await at('GET', '/thirdparty', { headers: bearer(t) });
  assert.equal(o.status, 200, o.json && o.json.error);
  assert.deepEqual(Object.keys(o.json).sort(), ['last-delivery-date', 'last-delivery-status']);
});

// Delivery: an add POSTed once to the URL of the token that made it. Each test asks its own token with its own receiver.
// No assertion message below carries a token.

const receivers = [];

after(async () => {
  for (const r of receivers) {
    r.server.closeAllConnections();
    await new Promise((resolve) => r.server.close(resolve));
  }
});

const idOfBody = (body) => {
  try {
    return JSON.parse(body).id;
  } catch {
    return null;
  }
};

// A local receiver on port 0: records each request's headers and body, and the connections that carried a
// request (the platform's fetch may open an empty one after an abort, which carries none); answers `status`,
// or never answers (the socket held open) when `status` is null. `status` may be changed between adds.
async function receiver(status = 200) {
  const r = { requests: [], sockets: new Set(), status };
  r.server = http.createServer((req, res) => {
    r.sockets.add(req.socket);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      r.requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (r.status !== null) {
        res.writeHead(r.status);
        res.end();
      }
    });
  });
  await new Promise((resolve) => r.server.listen(0, '127.0.0.1', resolve));
  r.url = `http://127.0.0.1:${r.server.address().port}/hook`;
  r.withId = (id) => r.requests.filter((q) => idOfBody(q.body) === id);
  receivers.push(r);
  return r;
}

// A URL on a port nothing listens on: a server listened, then closed.
async function closedPortUrl() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}/hook`;
}

const TOKEN_FIELDS = ['date', 'last-delivery-date', 'last-delivery-status', 'url'];

test("A23: a new record reaches its own token's URL once and no other token's; a token without a URL receives nothing", async () => {
  // The record is a notice, forwarded on a server with the notice address on and loopback exempt.
  const rxA = await receiver();
  const rxB = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const a = await s.token(rxA.url);
    const b = await s.token(rxB.url);
    const none = await s.token();
    const sent = JSON.stringify(notice('feature/a23', 'open'));
    assert.deepEqual(await s.notify(a, sent), KEPT);
    const outcome = await forwarded(s, a);
    assert.equal(outcome['last-delivery-status'], 200);
    assert.match(outcome['last-delivery-date'], ISO);
    await sleep(NEGATIVE_WAIT);
    assert.deepEqual(rxA.requests.map((q) => q.body), [sent], 'once, to its own token');
    assert.equal(rxB.requests.length, 0, "no other token's URL");
    assert.deepEqual(await s.notify(none, notice('feature/a23', 'cleared')), KEPT);
    await sleep(NEGATIVE_WAIT);
    assert.equal(rxA.requests.length + rxB.requests.length, 1, 'a token without a URL sends nowhere');
    for (const t of [b, none]) {
      const rec = (await s.tokenInfo(t)).json;
      assert.equal(rec['last-delivery-date'], null);
      assert.equal(rec['last-delivery-status'], null);
    }
  } finally {
    await s.close();
  }
});

test('delivery: a token without a URL stays at nulls', async () => {
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token();
    assert.deepEqual(await s.notify(t, notice('feature/dlv-no-url', 'open')), KEPT);
    await sleep(NEGATIVE_WAIT);
    const rec = (await s.tokenInfo(t)).json;
    assert.equal(rec.url, null);
    assert.equal(rec['last-delivery-date'], null);
    assert.equal(rec['last-delivery-status'], null);
  } finally {
    await s.close();
  }
});

test('delivery: a receiver answering 500 stores 500 and is called once', async () => {
  const rx = await receiver(500);
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    assert.deepEqual(await s.notify(t, notice('feature/dlv-500', 'open')), KEPT);
    const outcome = await forwarded(s, t);
    assert.equal(outcome['last-delivery-status'], 500);
    assert.match(outcome['last-delivery-date'], ISO);
    assert.equal(rx.requests.length, 1);
    await sleep(NEGATIVE_WAIT);
    assert.equal(rx.requests.length, 1, 'no retry');
  } finally {
    await s.close();
  }
});

test('delivery: a never-answering receiver stores 0, connected once, the add answering 201 first', async () => {
  // The delivery is the forwarding of a notice, on a server with the notice address on and loopback exempt.
  const rx = await receiver(null);
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    const started = performance.now();
    const r = await s.notify(t, notice('feature/dlv-silent', 'open'));
    const elapsed = performance.now() - started;
    assert.deepEqual(r, KEPT);
    assert.ok(elapsed < DELIVERY_TIMEOUT, `the notice answered in ${Math.round(elapsed)} ms, before the timeout`);
    const outcome = await forwarded(s, t);
    assert.equal(outcome['last-delivery-status'], 0);
    assert.match(outcome['last-delivery-date'], ISO);
    assert.equal(rx.requests.length, 1, 'one request');
    assert.equal(rx.sockets.size, 1, 'connected once');
  } finally {
    await s.close();
  }
});

test('delivery: a closed port stores 0 and the add answers 201 in shape', async () => {
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(await closedPortUrl());
    assert.deepEqual(await s.notify(t, notice('feature/dlv-closed', 'open')), KEPT, 'the notice answers 201 in shape');
    const outcome = await forwarded(s, t);
    assert.equal(outcome['last-delivery-status'], 0);
    assert.match(outcome['last-delivery-date'], ISO);
  } finally {
    await s.close();
  }
});

test('delivery: a second add overwrites the outcome', async () => {
  // A second notice's forwarding overwrites the first's outcome.
  const rx = await receiver(200);
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    const first = JSON.stringify(notice('feature/dlv-overwrite', 'open'));
    assert.deepEqual(await s.notify(t, first), KEPT);
    const one = await forwarded(s, t);
    assert.equal(one['last-delivery-status'], 200);
    rx.status = 500;
    const second = JSON.stringify(notice('feature/dlv-overwrite', 'cleared'));
    assert.deepEqual(await s.notify(t, second), KEPT);
    const two = await forwarded(s, t, (x) => x['last-delivery-status'] === 500);
    assert.equal(two['last-delivery-status'], 500);
    assert.match(two['last-delivery-date'], ISO);
    assert.ok(two['last-delivery-date'] >= one['last-delivery-date'], 'the later attempt dated no earlier');
    assert.deepEqual(rx.requests.map((q) => q.body), [first, second], 'each notice once');
  } finally {
    await s.close();
  }
});

test('GET /token: the token record without the token value, nulls before any delivery', async () => {
  const rx = await receiver();
  const t = await newToken(rx.url);
  const r = await call('GET', '/token', { headers: byToken(t.token) });
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.deepEqual(Object.keys(r.json).sort(), TOKEN_FIELDS);
  assert.equal('token' in r.json, false, 'no token field');
  assert.equal(r.json.url, t.url);
  assert.equal(r.json.url, rx.url);
  assert.equal(r.json.date, t.date);
  assert.equal(r.json['last-delivery-date'], null);
  assert.equal(r.json['last-delivery-status'], null);
  assert.equal(rx.requests.length, 0);
});

test('timeoutMs: 10000 by default, the variable when a positive integer, else 10000', () => {
  assert.equal(timeoutMs({}), 10000);
  assert.equal(timeoutMs({ DELIVERY_TIMEOUT_MS: '500' }), 500);
  assert.equal(timeoutMs({ DELIVERY_TIMEOUT_MS: 'abc' }), 10000);
  assert.equal(timeoutMs({ DELIVERY_TIMEOUT_MS: '0' }), 10000);
  assert.equal(timeoutMs({ DELIVERY_TIMEOUT_MS: '-5' }), 10000);
});

// The two open addresses, `/<part>/notify` and `/<part>/status`. The server above runs without ADDRESS_KEY, so its
// addresses are off; a second server runs with a part, on its own data folder inside the first one's (removed with it),
// HOLDER listed there with a token of its own. No assertion message below carries the part or a token.

const PART = randomBytes(32).toString('base64url');
const NOT_FOUND = { status: 404, json: { error: 'not found' } };
const RECORD = 'the body must be a JSON record of named fields';
const ITEM_MSG = "item must be a non-empty text, the item's reference";
const WHAT_MSG = 'what must be a non-empty text';
const REQUIRED_MSG = "item is required: the item's reference";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let partServer;
let partBase;
let partDir;
let PART_TOKEN; // HOLDER's token on the server with the part

before(async () => {
  partDir = join(dataDir, 'addresses');
  partServer = createServer({ ORG_SLUG: ORG, ADMIN_TOKEN: ADMIN, ADDRESS_KEY: PART, DATA_DIR: partDir, DELIVERY_TIMEOUT_MS: String(DELIVERY_TIMEOUT) },
    { limits: ROOMY });
  partBase = await listenOn(partServer);
  await listEmail(partBase, HOLDER);
  PART_TOKEN = (await tokenAt(partBase, HOLDER)).token;
});

after(async () => {
  await new Promise((resolve) => partServer.close(resolve));
});

// A call to the server with the part, under PART_TOKEN unless headers are given; `raw` is sent as the body text when given.
const at = (method, path, { headers = bearer(PART_TOKEN), ...rest } = {}) => request(partBase, method, path, { headers, ...rest });

const statusPath = (item) => `/${PART}/status${item === undefined ? '' : `?item=${encodeURIComponent(item)}`}`;

async function post(body) {
  const r = await at('POST', `/${PART}/notify`, { body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

async function statusOf(item) {
  const r = await at('GET', statusPath(item));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(Array.isArray(r.json));
  return r.json;
}

const notice = (item, state, extra = {}) => ({
  'what': 'a vendor key is issued', 'who-acts': 'the vendor', 'how-observed': 'the key works', state, item,
  'set-date': '2026-11-17T09:00:00.000Z', 'cleared-date': null, 'cleared-words': null, 'atlas': 'none', ...extra,
});

const partTokenId = () => {
  const db = new DatabaseSync(join(partDir, 'externalities.sqlite'));
  try {
    return db.prepare('SELECT id FROM tokens WHERE email = ?').get(HOLDER).id;
  } finally {
    db.close();
  }
};

test('ADDRESS_KEY: unset or empty is off; letters, digits, - and _, 32 or more is taken; anything else is refused', () => {
  assert.equal(loadAddressKey({}), '');
  assert.equal(loadAddressKey({ ADDRESS_KEY: '' }), '');
  for (const ok of ['a'.repeat(32), 'A-b_9'.repeat(7), PART]) assert.equal(loadAddressKey({ ADDRESS_KEY: ok }), ok);
  for (const bad of ['a'.repeat(31), `${'a'.repeat(31)}.`, `${'a'.repeat(31)}/`, `${'a'.repeat(31)} `, ` ${'a'.repeat(32)}`, `${'a'.repeat(31)}é`]) {
    assert.throws(() => loadAddressKey({ ADDRESS_KEY: bad }), /ADDRESS_KEY/, `a part of ${bad.length} characters`);
  }
});

test('the server refuses to start with a bad ADDRESS_KEY, naming it', () => {
  for (const part of ['a'.repeat(31), `${'a'.repeat(31)}.`]) {
    const r = spawnSync(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ORG_SLUG: ORG, ADMIN_TOKEN: ADMIN, ADDRESS_KEY: part, DATA_DIR: dataDir, PORT: '0' },
      timeout: 10000,
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, null, 'exited on its own');
    assert.match(r.stderr, /refusing to start: ADDRESS_KEY/);
  }
});

test('addresses: off without ADDRESS_KEY, both answering as an unknown route', async () => {
  assert.deepEqual(await call('GET', '/elsewhere'), NOT_FOUND);
  for (const headers of [{}, read()]) {
    assert.deepEqual(await call('POST', `/${PART}/notify`, { headers, body: notice('feature/off', 'open') }), NOT_FOUND);
    assert.deepEqual(await call('GET', statusPath('feature/off'), { headers }), NOT_FOUND);
  }
});

test('addresses: on with ADDRESS_KEY, both answer; the present routes still answer', async () => {
  assert.deepEqual(await post(notice('feature/on', 'open')), { kept: true });
  assert.equal((await statusOf('feature/on')).length, 1);
  assert.equal((await at('GET', '/', { headers: {} })).status, 200);
  assert.deepEqual(await at('GET', '/token', { headers: {} }), { status: 401, json: { error: 'token is required' } });
});

test('addresses: a wrong part, another method or a near path answers as an unknown route', async () => {
  assert.deepEqual(await at('GET', '/elsewhere'), NOT_FOUND);
  let wrong = randomBytes(32).toString('base64url');
  while (wrong === PART) wrong = randomBytes(32).toString('base64url');
  const body = notice('feature/wrong', 'open');
  for (const [method, path, opts] of [
    ['POST', `/${wrong}/notify`, { body }],
    ['GET', `/${wrong}/status?item=feature%2Fwrong`],
    ['POST', `/${PART.slice(0, -1)}/notify`, { body }],
    ['POST', `/${PART}x/notify`, { body }],
    ['POST', `/${PART}/notify/`, { body }],
    ['POST', `/x/${PART}/notify`, { body }],
    ['POST', `/${PART}`, { body }],
    ['GET', `/${PART}/notify`],
    ['POST', `/${PART}/status?item=feature%2Fwrong`, { body }],
    ['PUT', `/${PART}/notify`, { body }],
    ['DELETE', `/${PART}/status?item=feature%2Fwrong`],
  ]) {
    assert.deepEqual(await at(method, path, opts), NOT_FOUND, `${method} at a wrong address`);
  }
  assert.deepEqual(await statusOf('feature/wrong'), [], 'nothing was kept');
});

test('notify: a kept notice answers 201 with its id alone; two notices, two ids; one row each, under the token', async () => {
  const item = 'feature/ids';
  const one = await post(notice(item, 'open'));
  const two = await post(notice(item, 'open'));
  for (const r of [one, two]) {
    assert.deepEqual(r, { kept: true }, 'the R9 answer: kept, no id');
  }
  const own = partTokenId();
  const db = new DatabaseSync(join(partDir, 'externalities.sqlite'));
  try {
    const columns = db.prepare('PRAGMA table_info(notices)').all().map((c) => c.name);
    assert.deepEqual(columns, ['id', 'item', 'state', 'what', 'body', 'received', 'token_id']);
    const rows = db.prepare('SELECT * FROM notices WHERE item = ?').all(item);
    assert.equal(rows.length, 2, 'one row each');
    assert.notEqual(rows[0].id, rows[1].id);
    for (const row of rows) {
      assert.match(row.id, UUID, 'the row is given an id, which no call returns');
      assert.equal(row.state, 'open');
      assert.equal(row.what, 'a vendor key is issued');
      assert.deepEqual(JSON.parse(row.body), notice(item, 'open'));
      assert.match(row.received, ISO);
      assert.equal(row.token_id, own);
    }
  } finally {
    db.close();
  }
});

test('notify: kept as sent, a record of only item, state and what, and one with extra fields', async () => {
  const minimal = { item: 'feature/kept-minimal', state: 'cleared', what: ' a key ' };
  const extra = {
    'item': 'feature/kept-extra', 'state': 'open', 'what': 'a key is issued', 'nested': { list: [1, 'two', { three: null }] },
    'count': 42.5, 'nothing': null, 'flag': false, 'unknown-name': 'kept', 'cleared-words': 7,
  };
  for (const body of [minimal, extra]) {
    await post(body);
    assert.deepEqual(await statusOf(body.item), [body]);
  }
});

test('status: a body that does not survive a JavaScript round trip comes back as the very text sent', async () => {
  const raw = '{"item":"feature/n","state":"open","what":"w","n":12345678901234567890,"m":1e400,"dup":1,"dup":2}';
  assert.equal((await at('POST', `/${PART}/notify`, { raw })).status, 201);
  const res = await fetch(new URL(statusPath('feature/n'), partBase), { headers: bearer(PART_TOKEN) });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('12345678901234567890'));
  assert.equal(text, `[${raw}]`);
});

test('notify: each refused post answers 400 with its message, and is not kept', async () => {
  const item = 'feature/refused';
  const ok = { item, state: 'open', what: 'w' };
  for (const [label, raw, message] of [
    ['a blank body', '', RECORD],
    ['a body of spaces', '  \n', RECORD],
    ['not JSON', '{"item": "feature/refused", not json', RECORD],
    ['a list', JSON.stringify([ok]), `${RECORD}; got a list`],
    ['a text', '"feature/refused"', `${RECORD}; got a text`],
    ['a number', '42', `${RECORD}; got a number`],
    ['a boolean', 'true', `${RECORD}; got a boolean`],
    ['null', 'null', `${RECORD}; got null`],
    ['no item', JSON.stringify({ state: 'open', what: 'w' }), ITEM_MSG],
    ['an item of spaces', JSON.stringify({ ...ok, item: '   ' }), ITEM_MSG],
    ['an item not a text', JSON.stringify({ ...ok, item: 5 }), ITEM_MSG],
    ['a state of Open', JSON.stringify({ ...ok, state: 'Open' }), 'state must be open or cleared; got Open'],
    ['no state', JSON.stringify({ item, what: 'w' }), 'state must be open or cleared; got nothing'],
    ['a state of 1', JSON.stringify({ ...ok, state: 1 }), 'state must be open or cleared; got 1'],
    ['a state of null', JSON.stringify({ ...ok, state: null }), 'state must be open or cleared; got null'],
    ['no what', JSON.stringify({ item, state: 'open' }), WHAT_MSG],
    ['a what of spaces', JSON.stringify({ ...ok, what: ' ' }), WHAT_MSG],
    ['no item and a state of done', JSON.stringify({ state: 'done', what: 'w' }), `${ITEM_MSG}; state must be open or cleared; got done`],
    ['an empty record', '{}', `${ITEM_MSG}; state must be open or cleared; got nothing; ${WHAT_MSG}`],
    ['too large', JSON.stringify({ ...ok, pad: 'x'.repeat(1024 * 1024) }), 'body too large'],
  ]) {
    const r = await at('POST', `/${PART}/notify`, { raw });
    assert.equal(r.status, 400, label);
    assert.deepEqual(r.json, { error: message }, label);
  }
  assert.deepEqual(await statusOf(item), []);
});

test('status: an open and a cleared notice both kept, newest first; the reference matched exactly', async () => {
  const item = 'feature/pair';
  const opened = notice(item, 'open');
  const cleared = notice(item, 'cleared', { 'cleared-date': '2026-11-17T10:00:00.000Z', 'cleared-words': 'the key arrived' });
  await post(opened);
  await sleep(5);
  await post(cleared);
  assert.deepEqual(await statusOf(item), [cleared, opened]);
  for (const other of ['Feature/Pair', 'feature/pair ', ' feature/pair', 'feature/pai', 'pair']) {
    assert.deepEqual(await statusOf(other), [], JSON.stringify(other));
  }
  const spaced = 'feature/a name with spaces & more';
  await post(notice(spaced, 'open'));
  assert.equal((await statusOf(spaced)).length, 1, 'the reference is URL-decoded');
});

test('status: rows received in one instant read the later-inserted first', async () => {
  const item = 'feature/same-instant';
  const own = partTokenId();
  const db = new DatabaseSync(join(partDir, 'externalities.sqlite'));
  try {
    const insert = db.prepare('INSERT INTO notices (id, item, state, what, body, received, token_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [id, state] of [['z-first', 'open'], ['a-second', 'cleared']]) {
      insert.run(id, item, state, 'w', JSON.stringify({ item, state, what: 'w', id }), '2026-11-17T09:00:00.000Z', own);
    }
  } finally {
    db.close();
  }
  assert.deepEqual((await statusOf(item)).map((e) => e.id), ['a-second', 'z-first']);
});

test('status: an unknown reference is an empty list; a missing or empty one is refused', async () => {
  assert.deepEqual(await statusOf('feature/never-noticed'), []);
  for (const path of [statusPath(), `/${PART}/status?item=`, `/${PART}/status?other=feature%2Fpair`]) {
    assert.deepEqual(await at('GET', path), { status: 400, json: { error: REQUIRED_MSG } });
  }
});

test("A24: an authorized address's token and its variation's each add a record and send a notice; neither reads, lists or changes the other's", async () => {
  // The record and the notice are one now: each token sends notices, and no call changes a kept one.
  await listEmail(partBase, 'pair@example.org');
  const p = (await tokenAt(partBase, 'pair@example.org')).token;
  const v = (await tokenAt(partBase, 'pair+v@example.org')).token;
  const item = 'feature/a24';
  const notices = {};
  for (const [name, token] of [['p', p], ['v', v]]) {
    notices[name] = [notice(item, 'open', { what: `sent by ${name}` }), notice(item, 'cleared', { what: `sent by ${name}` })];
    for (const sent of notices[name]) {
      assert.equal((await at('POST', `/${PART}/notify`, { headers: bearer(token), body: sent })).status, 201);
      await sleep(5);
    }
  }
  for (const [mine, token] of [['p', p], ['v', v]]) {
    const st = await at('GET', statusPath(item), { headers: bearer(token) });
    assert.deepEqual(st.json, [...notices[mine]].reverse(), `${mine} reads its own notices only, each unchanged`);
  }
});

// The passing-on: a notice's `3rdparty-notice-url` posted to once, behind the guard. Every receiver here listens on
// loopback, which the guard refuses, so a server that must post runs with THIRDPARTY_ALLOW=127.0.0.1; each test
// starts its own, on its own data folder inside the first server's (removed with it), HOLDER listed there and its token
// sent with every notice, status read and outcome read. No assertion message carries a part or a token.

const TP = '3rdparty-notice-url';
const OUTSIDE = '93.184.216.34';

// A server with its notice address on and the given THIRDPARTY_ALLOW (undefined: unset).
async function tpServer(allow) {
  const part = randomBytes(32).toString('base64url');
  const env = { ORG_SLUG: ORG, ADMIN_TOKEN: ADMIN, ADDRESS_KEY: part, DATA_DIR: mkdtempSync(join(dataDir, 'tp-')),
    DELIVERY_TIMEOUT_MS: String(DELIVERY_TIMEOUT), ...(allow === undefined ? {} : { THIRDPARTY_ALLOW: allow }) };
  const s = createServer(env);
  const b = await listenOn(s);
  await listEmail(b, HOLDER);
  const token = (await tokenAt(b, HOLDER)).token;
  const own = bearer(token);
  const req = async (method, path, { headers = {}, raw } = {}) => {
    const init = { method, headers: { ...headers } };
    if (raw !== undefined) { init.body = raw; init.headers['content-type'] = 'application/json'; }
    const res = await fetch(new URL(path, b), init);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return {
    req,
    base: b,
    token,
    notifyUrl: `${b}/${part}/notify`,
    notify: (raw, headers) => req('POST', `/${part}/notify`, { raw, headers: { ...own, ...headers } }),
    statusOf: (item) => req('GET', `/${part}/status?item=${encodeURIComponent(item)}`, { headers: own }),
    outcome: () => req('GET', '/thirdparty', { headers: own }),
    close: async () => { s.closeAllConnections(); await new Promise((resolve) => s.close(resolve)); },
  };
}

const tpNotice = (item, state, url, extra = {}) => JSON.stringify(notice(item, state, url === undefined ? extra : { [TP]: url, ...extra }));

// Polls GET /thirdparty every 50 ms, up to 3 s, until `done` holds.
async function tpSettled(s, done = (o) => o['last-delivery-status'] !== null) {
  for (let i = 0; i < 60; i++) {
    const r = await s.outcome();
    assert.equal(r.status, 200);
    if (done(r.json)) return r.json;
    await sleep(50);
  }
  return assert.fail('no third-party outcome settled within 3 s');
}

const NULL_OUTCOME = { 'last-delivery-date': null, 'last-delivery-status': null };

// A lookup in dns.lookup's form that answers `answer(n)` on its n-th call (an Error fails the call).
function stubLookup(answer) {
  const fn = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    fn.calls += 1;
    const list = answer(fn.calls);
    process.nextTick(() => {
      if (list instanceof Error) callback(list);
      else if (options?.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
  fn.calls = 0;
  return fn;
}

test('thirdparty: one post per opened and per cleared notice, the text as received, JSON, no authorization header', async () => {
  const rx = await receiver();
  const s = await tpServer('127.0.0.1');
  try {
    const texts = [
      `{"item": "feature/tp-post",  "state":"open", "what":"w", "${TP}": "${rx.url}", "n": 1.50}`,
      `{ "state":"cleared","item":"feature/tp-post","what":"w","${TP}":"${rx.url}" ,"n":2.0 }`,
    ];
    for (const [i, raw] of texts.entries()) {
      // every notice's own post carries the holder's token as its authorization header
      const r = await s.notify(raw);
      assert.equal(r.status, 201, JSON.stringify(r.json));
      for (let k = 0; k < 60 && rx.requests.length <= i; k++) await sleep(50);
    }
    await sleep(NEGATIVE_WAIT);
    assert.equal(rx.requests.length, 2, 'one post per notice');
    for (const [i, q] of rx.requests.entries()) {
      assert.equal(q.body, texts[i], 'the text as received');
      assert.equal(q.headers['content-type'], 'application/json');
      assert.equal(q.headers['content-length'], String(Buffer.byteLength(texts[i])));
      assert.equal('authorization' in q.headers, false, 'no authorization header');
    }
  } finally {
    await s.close();
  }
});

test('thirdparty: no retry after a third party that fails or stays silent', async () => {
  const failing = await receiver(500);
  const silent = await receiver(null);
  const s = await tpServer('127.0.0.1');
  try {
    for (const rx of [failing, silent]) {
      assert.equal((await s.notify(tpNotice('feature/tp-retry', 'open', rx.url))).status, 201);
    }
    await sleep(DELIVERY_TIMEOUT * 4);
    assert.equal(failing.requests.length, 1, 'a 500 is not retried');
    assert.equal(silent.sockets.size, 1, 'a silent third party is connected to once');
    assert.equal(silent.requests.length, 1);
  } finally {
    await s.close();
  }
});

test('thirdparty: the notice is answered and kept with a slow, a failing and a refusing third party', async () => {
  const slow = await receiver(null);
  const failing = await receiver(500);
  const s = await tpServer('127.0.0.1');
  try {
    for (const [label, url] of [['slow', slow.url], ['failing', failing.url], ['refusing', await closedPortUrl()]]) {
      const item = `feature/tp-nowait-${label}`;
      const started = performance.now();
      const r = await s.notify(tpNotice(item, 'open', url));
      const elapsed = performance.now() - started;
      assert.equal(r.status, 201, label);
      assert.deepEqual(Object.keys(r.json), ['id'], label);
      assert.ok(elapsed < DELIVERY_TIMEOUT, `${label}: answered in ${Math.round(elapsed)} ms, before the timeout`);
      assert.equal((await s.statusOf(item)).json.length, 1, `${label}: kept`);
    }
    const o = await tpSettled(s, (x) => x['last-delivery-status'] === 0);
    assert.equal(o['last-delivery-status'], 0, 'a refused connection or a timeout is status 0');
  } finally {
    await s.close();
  }
});

test('thirdparty: a bad address or none gets no post and no outcome, and the notice is kept', async () => {
  const rx = await receiver();
  const port = rx.url.split(':')[2].split('/')[0];
  const s = await tpServer('127.0.0.1');
  try {
    for (const [label, url] of [['ftp', `ftp://127.0.0.1:${port}/hook`], ['a bare word', 'thirdparty'], ['a relative path', '/hook'],
      ['a user and password', `http://user:pw@127.0.0.1:${port}/hook`], ['a user alone', `http://user@127.0.0.1:${port}/hook`],
      ['a number', 42], ['a list', [rx.url]], ['null', null], ['empty', ''], ['absent', undefined]]) {
      const item = `feature/tp-bad-${label.replace(/\W+/g, '-')}`;
      const r = await s.notify(tpNotice(item, 'open', url));
      assert.equal(r.status, 201, label);
      assert.equal((await s.statusOf(item)).json.length, 1, `${label}: kept`);
    }
    await sleep(NEGATIVE_WAIT);
    assert.equal(rx.requests.length, 0, 'no post');
    assert.deepEqual((await s.outcome()).json, NULL_OUTCOME, 'no outcome row');
    // the positive control: the same server posts to the same receiver given a web address
    assert.equal((await s.notify(tpNotice('feature/tp-bad-control', 'open', rx.url))).status, 201);
    assert.equal((await tpSettled(s))['last-delivery-status'], 200);
    assert.equal(rx.requests.length, 1);
  } finally {
    await s.close();
  }
});

test('thirdparty: the guard refuses loopback, the IPv4-mapped loopback and localhost at the server: no post, no outcome', async () => {
  const rx = await receiver();
  const port = rx.url.split(':')[2].split('/')[0];
  const s = await tpServer();
  try {
    for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', 'localhost', '[::1]']) {
      const item = `feature/tp-guard-${host.replace(/\W+/g, '-')}`;
      assert.equal((await s.notify(tpNotice(item, 'open', `http://${host}:${port}/hook`))).status, 201, host);
      assert.equal((await s.statusOf(item)).json.length, 1, `${host}: kept`);
    }
    await sleep(NEGATIVE_WAIT);
    assert.equal(rx.requests.length, 0, 'no post');
    assert.deepEqual((await s.outcome()).json, NULL_OUTCOME, 'no outcome row');
  } finally {
    await s.close();
  }
});

test('thirdparty: one address in each refused range, and the IPv4-mapped loopback, is refused', async () => {
  const look = stubLookup(() => assert.fail('an address is not resolved'));
  const allow = parseAllow('');
  for (const host of ['0.0.0.1', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '224.0.0.1',
    '[::]', '[::1]', '[fc00::1]', '[fe80::1]', '[ff02::1]', '[64:ff9b::1]', '[64:ff9b:1::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]',
    '0x7f.1', '2130706433']) {
    for (const scheme of ['http', 'https']) {
      assert.deepEqual(await resolveTarget(`${scheme}://${host}:8443/x`, { lookup: look, allow }), { refused: true }, `${scheme} ${host}`);
    }
  }
  for (const host of [OUTSIDE, '172.32.0.1', '100.128.0.1', '[2606:4700::1]']) {
    const r = await resolveTarget(`http://${host}/x`, { lookup: look, allow });
    assert.equal(r.refused, false, host);
  }
  assert.equal(look.calls, 0, 'an address given is checked as it stands');
});

test('thirdparty: a name is resolved once, all its addresses, and refused whole when one is refused', async () => {
  const allow = parseAllow('');
  for (const [label, list] of [['loopback', [{ address: '127.0.0.1', family: 4 }]],
    ['an outside and a loopback address', [{ address: OUTSIDE, family: 4 }, { address: '127.0.0.1', family: 4 }]],
    ['an outside and a private IPv6 address', [{ address: OUTSIDE, family: 4 }, { address: 'fc00::1', family: 6 }]],
    ['an IPv4-mapped private address', [{ address: '::ffff:10.0.0.1', family: 6 }]]]) {
    const look = stubLookup(() => list);
    assert.deepEqual(await resolveTarget('http://name.test/x', { lookup: look, allow }), { refused: true }, label);
    assert.equal(look.calls, 1, label);
  }
  const look = stubLookup(() => [{ address: OUTSIDE, family: 4 }, { address: '2606:4700::1', family: 6 }]);
  assert.deepEqual(await resolveTarget('http://name.test/x', { lookup: look, allow }),
    { refused: false, addresses: [{ address: OUTSIDE, family: 4 }, { address: '2606:4700::1', family: 6 }] });
  const missing = stubLookup(() => Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
  assert.deepEqual(await resolveTarget('http://name.test/x', { lookup: missing, allow }), { refused: false, addresses: [] },
    'a name that does not resolve is an attempt, not a refusal');
  assert.equal(await postOnce('http://name.test/x', '{}', { lookup: missing, allow, timeout: DELIVERY_TIMEOUT }), 0);
});

test('thirdparty: the connection goes to the checked address, the lookup called once', async () => {
  const rx = await receiver();
  const port = rx.url.split(':')[2].split('/')[0];
  const look = stubLookup((n) => [{ address: n === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 }]);
  const text = '{"item":"feature/tp-pin","state":"open","what":"w"}';
  const status = await postOnce(`http://name.test:${port}/hook`, text, { lookup: look, allow: parseAllow('127.0.0.1'), timeout: DELIVERY_TIMEOUT });
  assert.equal(status, 200);
  assert.equal(look.calls, 1, 'one lookup per post');
  assert.equal(rx.requests.length, 1);
  assert.equal(rx.requests[0].body, text);
  // refused: no connection, status 0
  const refused = stubLookup(() => [{ address: '127.0.0.1', family: 4 }]);
  assert.equal(await postOnce(`http://name.test:${port}/hook`, text, { lookup: refused, allow: parseAllow(''), timeout: DELIVERY_TIMEOUT }), 0);
  assert.equal(refused.calls, 1);
  await sleep(100);
  assert.equal(rx.requests.length, 1, 'a refused name is not connected to');
});

test('thirdparty: a redirect is not followed; its 3xx is the outcome', async () => {
  const target = await receiver();
  const hits = [];
  const redirecting = http.createServer((req, res) => {
    hits.push(req.url);
    req.resume();
    req.on('end', () => res.writeHead(302, { location: target.url }).end());
  });
  await new Promise((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
  const s = await tpServer('127.0.0.1');
  try {
    const url = `http://127.0.0.1:${redirecting.address().port}/hook`;
    assert.equal((await s.notify(tpNotice('feature/tp-redirect', 'open', url))).status, 201);
    const o = await tpSettled(s);
    await sleep(NEGATIVE_WAIT);
    assert.equal(o['last-delivery-status'], 302);
    assert.equal(hits.length, 1);
    assert.equal(target.requests.length, 0, 'the redirect target receives nothing');
    assert.equal(await postOnce(url, '{}', { lookup: stubLookup(() => assert.fail('no lookup')), allow: parseAllow('127.0.0.1'), timeout: DELIVERY_TIMEOUT }), 302);
    assert.equal(target.requests.length, 0);
  } finally {
    await s.close();
    redirecting.closeAllConnections();
    await new Promise((resolve) => redirecting.close(resolve));
  }
});

test('thirdparty: THIRDPARTY_ALLOW exempts an address, a subnet and a trimmed list; the web-address rule still applies', async () => {
  const look = stubLookup(() => assert.fail('an address is not resolved'));
  for (const [allowText, host] of [['127.0.0.1', '127.0.0.1'], ['127.0.0.0/8', '127.0.0.5'], [' 10.0.0.1 , ::1 ', '[::1]'],
    [' 10.0.0.1 , ::1 ', '10.0.0.1'], ['fc00::/7', '[fd12::1]'], ['10.0.0.0/8', '[::ffff:10.9.9.9]']]) {
    const r = await resolveTarget(`http://${host}/x`, { lookup: look, allow: parseAllow(allowText) });
    assert.equal(r.refused, false, `${host} under ${JSON.stringify(allowText)}`);
  }
  for (const [allowText, host] of [['127.0.0.1', '127.0.0.2'], ['10.0.0.1', '10.0.0.2'], ['::1', '127.0.0.1'], ['', '127.0.0.1']]) {
    assert.deepEqual(await resolveTarget(`http://${host}/x`, { lookup: look, allow: parseAllow(allowText) }), { refused: true },
      `${host} under ${JSON.stringify(allowText)}`);
  }
  const allow = parseAllow('127.0.0.1');
  for (const url of ['ftp://127.0.0.1/x', 'http://u:p@127.0.0.1/x', 'not a url']) {
    assert.deepEqual(await resolveTarget(url, { lookup: look, allow }), { refused: true }, url);
  }
  const name = stubLookup(() => [{ address: '127.0.0.1', family: 4 }]);
  assert.equal((await resolveTarget('http://name.test/x', { lookup: name, allow })).refused, false, 'a resolved address is exempt too');
});

test('thirdparty: THIRDPARTY_ALLOW takes addresses and subnets only; anything else is refused, naming it', () => {
  for (const ok of ['', '127.0.0.1', '10.0.0.0/8', '::1', 'fc00::/7', ' 127.0.0.1 , ::1 ', '0.0.0.0/0']) {
    assert.doesNotThrow(() => parseAllow(ok), JSON.stringify(ok));
  }
  for (const bad of ['localhost', 'example.com', '999.1.1.1', '10.0.0.0/99', '::1/129', '10.0.0.0/', '10.0.0.0/x', '1.2.3.4/8/8',
    '127.0.0.1,', ',', ' ', 'http://127.0.0.1']) {
    assert.throws(() => parseAllow(bad), /THIRDPARTY_ALLOW/, JSON.stringify(bad));
  }
});

test('the server refuses to start with a bad THIRDPARTY_ALLOW, naming it', () => {
  for (const allow of ['localhost', '999.1.1.1', '10.0.0.0/99']) {
    const r = spawnSync(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ORG_SLUG: ORG, ADMIN_TOKEN: ADMIN, THIRDPARTY_ALLOW: allow, DATA_DIR: dataDir, PORT: '0' },
      timeout: 10000,
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, null, 'exited on its own');
    assert.match(r.stderr, /refusing to start: THIRDPARTY_ALLOW/);
  }
});

test('GET /thirdparty: refused without a valid token; null at first, the latest outcome after, replaced by the next', async () => {
  const rx = await receiver(200);
  const s = await tpServer('127.0.0.1');
  try {
    for (const headers of [{}, { 'X-Org-Slug': ORG }, { 'X-Org-Slug': ORG, 'Authorization': 'Bearer wrong' },
      { 'X-Org-Slug': ORG, 'Authorization': `Bearer ${OLD_KEY}` }, { 'X-Consumer-Token': s.token }, asAdmin,
      { 'X-Org-Slug': 'another-org', 'Authorization': `Bearer ${s.token}` }]) {
      const r = await s.req('GET', '/thirdparty', { headers });
      assert.equal(r.status, 401);
      assert.equal(typeof r.json.error, 'string');
    }
    const first = await s.outcome();
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, NULL_OUTCOME);
    assert.equal((await s.notify(tpNotice('feature/tp-read', 'open', rx.url))).status, 201);
    const one = await tpSettled(s);
    assert.deepEqual(Object.keys(one).sort(), ['last-delivery-date', 'last-delivery-status']);
    assert.equal(one['last-delivery-status'], 200);
    assert.match(one['last-delivery-date'], ISO);
    rx.status = 503;
    assert.equal((await s.notify(tpNotice('feature/tp-read', 'cleared', rx.url))).status, 201);
    const two = await tpSettled(s, (x) => x['last-delivery-status'] === 503);
    assert.match(two['last-delivery-date'], ISO);
    assert.ok(two['last-delivery-date'] >= one['last-delivery-date'], 'the later attempt dated no earlier');
  } finally {
    await s.close();
  }
});

// The loop guard: every post carries `x-externality-passed-on: 1`; a notice arriving with it is kept, never passed on.
const PASSED = 'x-externality-passed-on';

test('thirdparty: the post a notice produces carries x-externality-passed-on: 1, still JSON with no authorization', async () => {
  const rx = await receiver();
  const s = await tpServer('127.0.0.1');
  try {
    assert.equal((await s.notify(tpNotice('feature/tp-header', 'open', rx.url))).status, 201);
    for (let i = 0; i < 60 && rx.requests.length === 0; i++) await sleep(50);
    assert.equal(rx.requests.length, 1);
    const q = rx.requests[0];
    assert.equal(q.headers[PASSED], '1');
    assert.equal(q.headers['content-type'], 'application/json');
    assert.equal('authorization' in q.headers, false, 'no authorization header');
  } finally {
    await s.close();
  }
});

test('thirdparty: a notice carrying x-externality-passed-on, any value, is kept and answered but not passed on', async () => {
  const rx = await receiver();
  const s = await tpServer('127.0.0.1');
  try {
    for (const [label, value] of [['one', '1'], ['other', 'no'], ['empty', '']]) {
      const item = `feature/tp-passed-${label}`;
      const r = await s.notify(tpNotice(item, 'open', rx.url), { [PASSED]: value });
      assert.equal(r.status, 201, label);
      assert.deepEqual(Object.keys(r.json), ['id'], label);
      assert.equal((await s.statusOf(item)).json.length, 1, `${label}: kept`);
    }
    await sleep(NEGATIVE_WAIT);
    assert.equal(rx.requests.length, 0, 'not passed on');
    assert.deepEqual((await s.outcome()).json, NULL_OUTCOME, 'no outcome row');
    // the positive control: the same notice without the header is passed on
    assert.equal((await s.notify(tpNotice('feature/tp-passed-control', 'open', rx.url))).status, 201);
    assert.equal((await tpSettled(s))['last-delivery-status'], 200);
    assert.equal(rx.requests.length, 1);
  } finally {
    await s.close();
  }
});

// The passing-on sends no credential (src/thirdparty.js, unchanged), and the notice address now wants a token, so the
// copy it posts to this service's own notice address is refused with 401 and the loop ends at the first step.
test('thirdparty: a notice naming the service\'s own notice address is kept once; the copy, sent with no token, is refused 401, no more', async () => {
  const s = await tpServer('127.0.0.1');
  try {
    const item = 'feature/tp-self';
    assert.equal((await s.notify(tpNotice(item, 'open', s.notifyUrl))).status, 201);
    assert.equal((await tpSettled(s))['last-delivery-status'], 401, 'the copy was posted and refused');
    await sleep(NEGATIVE_WAIT);
    assert.equal((await s.statusOf(item)).json.length, 1, 'the original only');
    await sleep(NEGATIVE_WAIT);
    assert.equal((await s.statusOf(item)).json.length, 1, 'the count is stable');
  } finally {
    await s.close();
  }
});

// This machine's non-internal interface addresses, those the ranges alone do not refuse first.
function ownAddresses() {
  const ranges = refusedList({});
  const list = Object.values(networkInterfaces()).flat().filter((x) => x && !x.internal)
    .map((x) => String(x.address).replace(/%.*$/, ''))
    .map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const inRanges = (x) => Number(ranges.check(x.address, x.family === 4 ? 'ipv4' : 'ipv6'));
  return list.sort((a, b) => inRanges(a) - inRanges(b));
}

test('thirdparty: the machine\'s own interface address is refused, given or resolved; an exemption still applies', async (t) => {
  const own = ownAddresses();
  if (own.length === 0) {
    t.skip('this machine has no non-internal interface address; the mechanism is tested through refusedList');
    return;
  }
  const { address, family } = own[0];
  if (refusedList({}).check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    t.diagnostic(`every own address here (${address} first) is in the ranges too; the own-address set is shown by refusedList's test`);
  }
  const host = family === 6 ? `[${address}]` : address;
  const look = stubLookup(() => assert.fail('an address is not resolved'));
  assert.deepEqual(await resolveTarget(`http://${host}:8443/x`, { lookup: look, allow: parseAllow('') }), { refused: true }, `own address ${address}`);
  const name = stubLookup(() => [{ address: OUTSIDE, family: 4 }, { address, family }]);
  assert.deepEqual(await resolveTarget('http://name.test/x', { lookup: name, allow: parseAllow('') }), { refused: true }, `a name resolving to ${address}`);
  assert.equal(name.calls, 1);
  assert.equal((await resolveTarget(`http://${host}/x`, { lookup: look, allow: parseAllow(address) })).refused, false, 'an exempt own address passes');
});

test('thirdparty: refusedList holds the ranges and each interface address as a single address in its family', () => {
  const list = refusedList({
    en0: [{ address: '203.0.113.7', family: 'IPv4', internal: false }, { address: '2001:db8::7', family: 'IPv6', internal: false },
      { address: 'fe80::1%en0', family: 'IPv6', internal: false }],
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  });
  assert.equal(list.check('203.0.113.7', 'ipv4'), true);
  assert.equal(list.check('2001:db8::7', 'ipv6'), true);
  assert.equal(list.check('203.0.113.8', 'ipv4'), false, 'a single address, not a subnet');
  assert.equal(list.check('2001:db8::8', 'ipv6'), false, 'a single address, not a subnet');
  assert.equal(list.check('10.0.0.1', 'ipv4'), true, 'the ranges stay');
  const bare = refusedList({});
  assert.equal(bare.check('203.0.113.7', 'ipv4'), false, 'without the interface, not refused');
  assert.equal(bare.check('127.0.0.1', 'ipv4'), true);
});

test('thirdparty: an exemption covers its own address family only', async () => {
  const look = stubLookup(() => assert.fail('an address is not resolved'));
  for (const text of ['::/1', '::/0']) {
    const allow = parseAllow(text);
    for (const host of ['127.0.0.1', '10.0.0.1', '[::ffff:127.0.0.1]']) {
      assert.deepEqual(await resolveTarget(`http://${host}/x`, { lookup: look, allow }), { refused: true }, `${host} under ${text}`);
    }
    assert.equal((await resolveTarget('http://[::1]/x', { lookup: look, allow })).refused, false, `::1 under ${text}`);
    const name = stubLookup(() => [{ address: '127.0.0.1', family: 4 }]);
    assert.deepEqual(await resolveTarget('http://name.test/x', { lookup: name, allow }), { refused: true }, `a name to 127.0.0.1 under ${text}`);
  }
  assert.deepEqual(await resolveTarget('http://[::1]/x', { lookup: look, allow: parseAllow('127.0.0.0/8') }), { refused: true }, '::1 under 127.0.0.0/8');
  assert.equal((await resolveTarget('http://127.0.0.1/x', { lookup: look, allow: parseAllow('127.0.0.0/8') })).refused, false, 'the IPv4 entry still exempts');
});

// Whose records and the old data: the schema, the scope ignored, the old tables dropped once.

test('A25: the schema names token_id on both tables as a foreign key to tokens, and tokens as keyed to authorized_emails; each table holds its named columns', () => {
  const db = openMain();
  try {
    const fks = (table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all().map((f) => [f.from, f.table, f.to]);
    // The add store `externalities` is gone; `notices` is the one table of token_id.
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'externalities'").get().n, 0);
    assert.deepEqual(fks('notices'), [['token_id', 'tokens', 'id']]);
    assert.deepEqual(fks('tokens'), [['authorized_email', 'authorized_emails', 'id']]);
    assert.deepEqual(fks('authorized_emails'), []);
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all();
    const names = (table) => cols(table).map((c) => c.name);
    assert.deepEqual(names('authorized_emails'), ['id', 'email', 'active']);
    assert.deepEqual(names('tokens'), ['id', 'email', 'token', 'authorized_email', 'url', 'date', 'last_delivery_date', 'last_delivery_status']);
    for (const table of ['authorized_emails', 'tokens']) {
      assert.deepEqual(cols(table).filter((c) => c.pk).map((c) => c.name), ['id'], `${table} is keyed by id`);
    }
    for (const table of ['notices']) {
      const tokenId = cols(table).find((c) => c.name === 'token_id');
      assert.ok(tokenId, `${table} holds token_id`);
      assert.equal(tokenId.notnull, 1, `${table}.token_id is required`);
    }
    assert.deepEqual(names('notices'), ['id', 'item', 'state', 'what', 'body', 'received', 'token_id']);
    const uniques = (table) => db.prepare(`PRAGMA index_list(${table})`).all().filter((i) => i.unique)
      .flatMap((i) => db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name)).sort();
    assert.deepEqual(uniques('authorized_emails'), ['email']);
    assert.deepEqual(uniques('tokens'), ['email', 'token']);
    const insertNotice = db.prepare('INSERT INTO notices (id, item, state, what, body, received, token_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    assert.throws(() => insertNotice.run('fk-none', 'i', 'open', 'w', '{}', 't', 999999999), /FOREIGN KEY/);
    assert.throws(() => insertNotice.run('fk-null', 'i', 'open', 'w', '{}', 't', null), /NOT NULL/);
  } finally {
    db.close();
  }
});

test('A26: POST /tokens ignores a scope; GET /token returns none', async () => {
  const email = variation();
  const r = await askAt(base, email, { scope: 'some-atlas' });
  assert.equal(r.status, 201, r.json && r.json.error);
  assert.deepEqual(Object.keys(r.json), ['token', 'url', 'date']);
  const again = await askAt(base, email, { scope: 'all' }, bearer(r.json.token));
  assert.equal(again.status, 200);
  assert.deepEqual(Object.keys(again.json), ['token', 'url', 'date'], 'no scope, whatever scope is sent');
  const token = again.json.token;
  const info = await call('GET', '/token', { headers: bearer(token) });
  assert.deepEqual(Object.keys(info.json).sort(), TOKEN_FIELDS);
  assert.equal('scope' in info.json, false);
  const db = openMain();
  try {
    assert.ok(!db.prepare('PRAGMA table_info(tokens)').all().some((c) => c.name === 'scope'), 'no scope column');
  } finally {
    db.close();
  }
  assert.equal((await call('GET', '/thirdparty', { headers: bearer(token) })).status, 200, 'the token opens its routes, under no atlas');
});

// A database in the shape the old code made: its tables and columns, a row in each.
function oldDatabase(dir) {
  const old = new DatabaseSync(join(dir, 'externalities.sqlite'));
  try {
    old.exec(`CREATE TABLE externalities (
      id TEXT PRIMARY KEY, org TEXT, atlas TEXT, item TEXT, what TEXT,
      who_acts TEXT, how_observed TEXT, state TEXT, set_date TEXT,
      cleared_date TEXT, cleared_words TEXT)`);
    old.exec('CREATE TABLE tokens (token TEXT PRIMARY KEY, scope TEXT, url TEXT, date TEXT, last_delivery_date TEXT, last_delivery_status INTEGER)');
    old.exec('CREATE TABLE notices (id TEXT PRIMARY KEY, item TEXT, state TEXT, what TEXT, body TEXT, received TEXT)');
    old.exec('CREATE TABLE thirdparty (id INTEGER PRIMARY KEY CHECK (id = 1), last_delivery_date TEXT, last_delivery_status INTEGER)');
    old.prepare(`INSERT INTO externalities (id, org, atlas, item, what, who_acts, how_observed, state, set_date, cleared_date, cleared_words)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('old-1', ORG, 'old-atlas', 'old-item', 'kept before', 'someone', 'somehow', 'open',
      '2026-10-12T00:00:00.000Z', null, null);
    old.prepare('INSERT INTO tokens (token, scope, url, date) VALUES (?, ?, ?, ?)').run('old-token-value-0123456789', 'all', null, '2026-10-12T00:00:00.000Z');
    old.prepare('INSERT INTO notices (id, item, state, what, body, received) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old-n1', 'feature/old', 'open', 'w', '{"item":"feature/old","state":"open","what":"w"}', '2026-10-12T00:00:00.000Z');
    old.prepare('INSERT INTO thirdparty (id, last_delivery_date, last_delivery_status) VALUES (1, ?, ?)').run('2026-11-01T00:00:00.000Z', 204);
  } finally {
    old.close();
  }
}

// Starts a server on the folder, the lines it writes to the log at start caught.
async function startOn(dir) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  let s;
  try {
    s = createServer({ ORG_SLUG: ORG, ADMIN_TOKEN: ADMIN, DATA_DIR: dir });
  } finally {
    console.log = log;
  }
  const b = await listenOn(s);
  return { base: b, lines, close: async () => { s.closeAllConnections(); await new Promise((resolve) => s.close(resolve)); } };
}

test('A27: a database made by the old code opens under the new code with its records, notices and tokens gone and its third-party outcome kept', async () => {
  const dir = mkdtempSync(join(dataDir, 'old-'));
  oldDatabase(dir);
  const s = await startOn(dir);
  try {
    assert.deepEqual(s.lines, [DROPPED], 'one line naming the three tables, and no second line');
    const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'externalities'").get().n, 0,
        'the records are gone with their table');
      for (const table of ['notices', 'tokens', 'authorized_emails']) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} is empty`);
      }
      assert.ok(!db.prepare('PRAGMA table_info(tokens)').all().some((c) => c.name === 'scope'), 'tokens made new');
      assert.ok(db.prepare('PRAGMA table_info(notices)').all().some((c) => c.name === 'token_id'), 'notices made new');
      assert.deepEqual({ ...db.prepare('SELECT * FROM thirdparty').get() },
        { id: 1, last_delivery_date: '2026-11-01T00:00:00.000Z', last_delivery_status: 204 }, 'the third-party outcome is kept');
    } finally {
      db.close();
    }
    assert.deepEqual(await request(s.base, 'GET', '/token', { headers: bearer('old-token-value-0123456789') }),
      { status: 401, json: { error: 'unknown token' } }, 'the old token opens nothing');
    await listEmail(s.base, HOLDER);
    const token = (await tokenAt(s.base, HOLDER)).token;
    assert.deepEqual((await request(s.base, 'GET', '/thirdparty', { headers: bearer(token) })).json,
      { 'last-delivery-date': '2026-11-01T00:00:00.000Z', 'last-delivery-status': 204 });
  } finally {
    await s.close();
  }
});

test('the old shape without a tokens table: records and notices dropped once, the third-party outcome kept, records made after kept', async () => {
  const dir = mkdtempSync(join(dataDir, 'old-'));
  const old = new DatabaseSync(join(dir, 'externalities.sqlite'));
  try {
    old.exec(`CREATE TABLE externalities (
      id TEXT PRIMARY KEY, org TEXT, atlas TEXT, item TEXT, what TEXT,
      who_acts TEXT, how_observed TEXT, state TEXT, set_date TEXT,
      cleared_date TEXT, cleared_words TEXT)`);
    old.exec('CREATE TABLE notices (id TEXT PRIMARY KEY, item TEXT, state TEXT, what TEXT, body TEXT, received TEXT)');
    old.exec('CREATE TABLE thirdparty (id INTEGER PRIMARY KEY CHECK (id = 1), last_delivery_date TEXT, last_delivery_status INTEGER)');
    old.prepare(`INSERT INTO externalities (id, org, atlas, item, what, who_acts, how_observed, state, set_date, cleared_date, cleared_words)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('old-2', ORG, 'old-atlas', 'old-item', 'kept before', 'someone', 'somehow', 'open',
      '2026-10-12T00:00:00.000Z', null, null);
    old.prepare('INSERT INTO notices (id, item, state, what, body, received) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old-n2', 'feature/old', 'open', 'w', '{"item":"feature/old","state":"open","what":"w"}', '2026-10-12T00:00:00.000Z');
    old.prepare('INSERT INTO thirdparty (id, last_delivery_date, last_delivery_status) VALUES (1, ?, ?)').run('2026-11-02T00:00:00.000Z', 202);
  } finally {
    old.close();
  }
  // The records made after are notices, kept on a server with the notice address on.
  let s = await oneWay({ dir, list: false });
  let token;
  const sent = notice('feature/between', 'open');
  try {
    assert.deepEqual(s.lines, [DROPPED], 'the one line, once');
    const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'externalities'").get().n, 0,
        'the records are gone with their table');
      for (const table of ['notices', 'tokens']) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} is empty`);
      }
      assert.ok(db.prepare('PRAGMA table_info(notices)').all().some((c) => c.name === 'token_id'), 'notices made new');
      assert.equal(db.prepare('SELECT last_delivery_status AS s FROM thirdparty').get().s, 202, 'the third-party outcome is kept');
    } finally {
      db.close();
    }
    await listEmail(s.base, HOLDER);
    token = (await tokenAt(s.base, HOLDER)).token;
    assert.deepEqual(await s.notify(token, sent), KEPT);
  } finally {
    await s.close();
  }
  s = await oneWay({ dir, list: false });
  try {
    assert.deepEqual(s.lines, [], 'a second open drops nothing');
    assert.deepEqual(await s.statusOf(token, 'feature/between'), { status: 200, json: [sent] }, 'the notice made in between is kept');
    assert.deepEqual((await s.outcome(token)).json,
      { 'last-delivery-date': '2026-11-02T00:00:00.000Z', 'last-delivery-status': 202 });
  } finally {
    await s.close();
  }
});

test('A28: records made after that survive a restart', async () => {
  // The records made after are notices, kept on a server with the notice address on.
  const dir = mkdtempSync(join(dataDir, 'old-'));
  oldDatabase(dir);
  let s = await oneWay({ dir, list: false });
  let token;
  const sent = notice('feature/after', 'open');
  try {
    assert.deepEqual(s.lines, [DROPPED]);
    await listEmail(s.base, HOLDER);
    token = (await tokenAt(s.base, HOLDER)).token;
    assert.deepEqual(await s.notify(token, sent), KEPT);
  } finally {
    await s.close();
  }
  s = await oneWay({ dir, list: false });
  try {
    assert.deepEqual(s.lines, [], 'a later start drops nothing');
    assert.equal((await s.tokenInfo(token)).status, 200, 'the token survives the restart');
    assert.deepEqual(await s.statusOf(token, 'feature/after'), { status: 200, json: [sent] }, 'the notice survives the restart');
  } finally {
    await s.close();
  }
});

// A later ask (the address already has a token) bears that token and gets a new one. No assertion message carries a token.

test('re-call A1: a later ask with no bearer token answers 401 refused, the body equal to an unknown address\'s', async () => {
  const email = 'recall-a1@example.org';
  await listEmail(base, email);
  const t = (await tokenAt(base, email)).token;
  const unknown = await askAt(base, 'recall-a1-never@example.org');
  assert.deepEqual(unknown, REFUSED, 'an unknown address');
  for (const [label, opts] of [
    ['no header', {}],
    ['an empty bearer', { headers: { 'Authorization': 'Bearer ' } }],
    ['another scheme', { headers: { 'Authorization': `Basic ${t}` } }],
    ['the old header', { headers: { 'X-Consumer-Token': t } }],
    ['a URL parameter', { params: { token: t } }],
  ]) {
    const r = await request(base, 'POST', '/tokens', { ...opts, body: { email } });
    assert.deepEqual(r, unknown, label);
  }
});

test('re-call A2: a later ask with another address\'s token, a variation\'s, the admin token or the old token answers the same refusal', async () => {
  const email = 'recall-a2@example.org';
  await listEmail(base, email);
  await listEmail(base, 'recall-a2-other@example.org');
  const old = (await tokenAt(base, email)).token;
  const varied = (await tokenAt(base, 'recall-a2+v@example.org')).token;
  const other = (await tokenAt(base, 'recall-a2-other@example.org')).token;
  const renewed = await askAt(base, email, {}, bearer(old));
  assert.equal(renewed.status, 200, renewed.json && renewed.json.error);
  const current = renewed.json.token;
  const unknown = await askAt(base, 'recall-a2-never@example.org', {}, bearer(current));
  assert.deepEqual(unknown, REFUSED, 'an unknown address');
  for (const [label, token] of [['another address\'s', other], ['a variation\'s', varied], ['the admin token', ADMIN],
    ['the old token', old], ['a near token', `${current.slice(0, -1)}${current.endsWith('A') ? 'B' : 'A'}`]]) {
    assert.deepEqual(await askAt(base, email, {}, bearer(token)), unknown, label);
  }
  assert.deepEqual(await askAt(base, 'recall-a2+v@example.org', {}, bearer(current)), unknown, 'the plain address\'s token for its variation');
  assert.equal((await call('GET', '/token', { headers: bearer(current) })).status, 200, 'the current token still works');
});

test('re-call A3: after a refused later ask the token still opens its routes; its URL, record and notice stand', async () => {
  const email = 'recall-a3@example.org';
  // A forwarding address the guard refuses (loopback, no exemption on this server): the notice's forwarding sends
  // nothing anywhere and settles at once with status 0, before the row is read.
  const url = 'http://127.0.0.1:1/recall-a3';
  await listEmail(partBase, email);
  const t = (await tokenAt(partBase, email, { url })).token;
  const item = 'feature/recall-a3';
  assert.equal((await at('POST', `/${PART}/notify`, { headers: bearer(t), body: notice(item, 'open') })).status, 201);
  let settledInfo;
  await waitFor(async () => (settledInfo = (await request(partBase, 'GET', '/token', { headers: bearer(t) })).json)['last-delivery-date'] !== null);
  assert.equal(settledInfo['last-delivery-status'], 0, 'the record of the forwarding: refused, status 0');
  const rowOf = () => {
    const db = new DatabaseSync(join(partDir, 'externalities.sqlite'));
    try {
      return { ...db.prepare('SELECT * FROM tokens WHERE email = ?').get(email) };
    } finally {
      db.close();
    }
  };
  const before = rowOf();
  for (const [label, extra, headers] of [
    ['no token', {}, {}],
    ['no token, a new URL', { url: 'https://example.org/elsewhere' }, {}],
    ['a wrong token, null', { url: null }, bearer('made-up')],
    ['the admin token, a new URL', { url: 'https://example.org/elsewhere' }, asAdmin],
  ]) {
    assert.deepEqual(await askAt(partBase, email, extra, headers), REFUSED, label);
  }
  assert.deepEqual(rowOf(), before, 'the row is unchanged: token, URL, date');
  const info = await request(partBase, 'GET', '/token', { headers: bearer(t) });
  assert.equal(info.status, 200, 'the token still opens its routes');
  assert.equal(info.json.url, url, 'the URL stands');
  assert.equal(info.json['last-delivery-date'], settledInfo['last-delivery-date'], 'the record of the forwarding stands');
  const st = await at('GET', statusPath(item), { headers: bearer(t) });
  assert.deepEqual(st, { status: 200, json: [notice(item, 'open')] }, 'the notice stands');
});

test('re-call A4: a later ask with the current token answers 200 with three fields, a different token and that token\'s date', async () => {
  const email = 'recall-a4@example.org';
  await listEmail(base, email);
  const first = await tokenAt(base, email);
  await sleep(5); // the two dates cannot fall in one millisecond
  const t0 = new Date().toISOString();
  const r = await askAt(base, email, {}, bearer(first.token));
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.deepEqual(Object.keys(r.json), ['token', 'url', 'date']);
  assert.ok(r.json.token !== first.token, 'a different token');
  assert.ok(BASE64URL_32_BYTES.test(r.json.token), 'the new token is 32 bytes as base64url');
  assert.match(r.json.date, ISO);
  assert.ok(r.json.date >= t0, 'dated when the new token was made');
  assert.notEqual(r.json.date, first.date, 'a new date');
  assert.equal(r.json.url, null);
  assert.equal((await call('GET', '/token', { headers: bearer(r.json.token) })).json.date, r.json.date, 'the date stored with the new token');
  const db = openMain();
  try {
    const row = db.prepare('SELECT token, date FROM tokens WHERE email = ?').get(email);
    assert.ok(row.token === r.json.token, 'the stored token is the new one');
    assert.equal(row.date, r.json.date);
  } finally {
    db.close();
  }
});

test('re-call A5: the old token then answers 401 on every token route and at the notice and status addresses; the new one is accepted', async () => {
  const email = 'recall-a5@example.org';
  await listEmail(partBase, email);
  const old = (await tokenAt(partBase, email)).token;
  const r = await askAt(partBase, email, {}, bearer(old));
  assert.equal(r.status, 200, r.json && r.json.error);
  const fresh = r.json.token;
  assert.ok(fresh !== old, 'a new token');
  for (const [method, path, { slugs, ...opts }] of TOKEN_ROUTES('rc5', 'rc5-item')) {
    const refused = await request(partBase, method, path, { ...opts, headers: { ...bearer(old), ...slugs } });
    assert.deepEqual(refused, { status: 401, json: { error: 'unknown token' } }, `${method} ${path}: the old token`);
    const accepted = await request(partBase, method, path, { ...opts, headers: { ...bearer(fresh), ...slugs } });
    assert.notEqual(accepted.status, 401, `${method} ${path}: the new token`);
  }
  const item = 'feature/recall-a5';
  for (const [method, path, opts] of [['POST', `/${PART}/notify`, { body: notice(item, 'open') }], ['GET', statusPath(item)]]) {
    assert.deepEqual(await at(method, path, { ...opts, headers: bearer(old) }), { status: 401, json: { error: 'unknown token' } }, `${method} at an open address: the old token`);
  }
  assert.equal((await at('POST', `/${PART}/notify`, { headers: bearer(fresh), body: notice(item, 'open') })).status, 201, 'notify: the new token');
  assert.deepEqual(await at('GET', statusPath(item), { headers: bearer(fresh) }), { status: 200, json: [notice(item, 'open')] }, 'status: the new token');
});

test('re-call A6: a record and a notice made with the old token are read with the new; so are the URL and the delivery outcome', async () => {
  // The record is a notice; its delivery is the notice's forwarding, on a server with loopback exempt.
  const email = 'recall-a6@example.org';
  const rx = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    await listEmail(s.base, email);
    const old = (await tokenAt(s.base, email, { url: rx.url })).token;
    const item = 'feature/recall-a6';
    assert.deepEqual(await s.notify(old, notice(item, 'open')), KEPT);
    const outcome = await forwarded(s, old);
    assert.equal(outcome['last-delivery-status'], 200, 'the delivery settled');
    const r = await askAt(s.base, email, {}, bearer(old));
    assert.equal(r.status, 200, r.json && r.json.error);
    const fresh = r.json.token;
    assert.equal(r.json.url, rx.url, 'the answer carries the kept URL');
    const info = await s.tokenInfo(fresh);
    assert.equal(info.status, 200);
    assert.equal(info.json.url, rx.url, 'the URL');
    assert.equal(info.json['last-delivery-date'], outcome['last-delivery-date'], 'the delivery date');
    assert.equal(info.json['last-delivery-status'], outcome['last-delivery-status'], 'the delivery status');
    assert.deepEqual(await s.statusOf(fresh, item), { status: 200, json: [notice(item, 'open')] }, 'the notice');
  } finally {
    await s.close();
  }
});

test('re-call A7: a later ask naming a URL stores it, with no url keeps it, naming null clears it; each answer carries url', async () => {
  const email = 'recall-a7@example.org';
  await listEmail(base, email);
  const u1 = 'https://example.org/recall-a7/one';
  const u2 = 'https://example.org/recall-a7/two';
  const first = await tokenAt(base, email);
  assert.ok(Object.hasOwn(first, 'url'), 'the first answer carries url');
  assert.equal(first.url, null);
  let token = first.token;
  for (const [label, extra, url] of [
    ['naming a URL', { url: u1 }, u1],
    ['naming another', { url: u2 }, u2],
    ['no url', {}, u2],
    ['null', { url: null }, null],
    ['no url after null', {}, null],
  ]) {
    const r = await askAt(base, email, extra, bearer(token));
    assert.equal(r.status, 200, label);
    assert.ok(Object.hasOwn(r.json, 'url'), `${label}: the answer carries url`);
    assert.equal(r.json.url, url, label);
    token = r.json.token;
    assert.equal((await call('GET', '/token', { headers: bearer(token) })).json.url, url, `${label}: as stored`);
  }
});

test('re-call A8: a variation and its plain address each renew alone; one\'s renewal leaves the other\'s token working', async () => {
  const plain = 'recall-a8@example.org';
  const varied = 'recall-a8+v@example.org';
  await listEmail(base, plain);
  const p = (await tokenAt(base, plain)).token;
  const v = (await tokenAt(base, varied)).token;
  const works = async (t) => (await call('GET', '/token', { headers: bearer(t) })).status;
  const v2 = await askAt(base, varied, {}, bearer(v));
  assert.equal(v2.status, 200, 'the variation renews');
  assert.equal(await works(p), 200, 'the plain token still works after the variation renews');
  const p2 = await askAt(base, plain, {}, bearer(p));
  assert.equal(p2.status, 200, 'the plain address renews with its own token');
  assert.equal(await works(v2.json.token), 200, 'the variation\'s token still works after the plain address renews');
  assert.deepEqual(await askAt(base, plain, {}, bearer(v2.json.token)), REFUSED, 'the variation\'s token renews not the plain address');
  assert.deepEqual(await askAt(base, varied, {}, bearer(p2.json.token)), REFUSED, 'the plain token renews not the variation');
  const v3 = await askAt(base, varied, {}, bearer(v2.json.token));
  assert.equal(v3.status, 200, 'the variation renews again with its own');
  assert.equal(await works(p2.json.token), 200, 'the plain token still works');
});

test('re-call A9: a first ask answers 201 with no credential, and with a made-up bearer token; its answer carries url', async () => {
  await listEmail(base, 'recall-a9@example.org');
  const none = await askAt(base, 'recall-a9@example.org');
  assert.equal(none.status, 201, none.json && none.json.error);
  assert.deepEqual(Object.keys(none.json), ['token', 'url', 'date']);
  assert.equal(none.json.url, null);
  for (const [i, [label, headers]] of [['a made-up bearer token', bearer('made-up')], ['another address\'s token', bearer(none.json.token)],
    ['the admin token', asAdmin]].entries()) {
    const r = await askAt(base, `recall-a9+${i}@example.org`, { url: 'https://example.org/recall-a9' }, headers);
    assert.equal(r.status, 201, label);
    assert.deepEqual(Object.keys(r.json), ['token', 'url', 'date'], label);
    assert.equal(r.json.url, 'https://example.org/recall-a9', label);
  }
  assert.equal((await call('GET', '/token', { headers: bearer(none.json.token) })).status, 200, 'a first ask bearing it left it working');
});

test('re-call A10: a bad body answers 400 with the right token or a wrong one and renews nothing; a post over the limit answers 429', async () => {
  const email = 'recall-a10@example.org';
  await listEmail(base, email);
  const t = (await tokenAt(base, email)).token;
  for (const [label, headers] of [['the right token', bearer(t)], ['a wrong token', bearer('made-up')]]) {
    for (const [what, opts, reason] of [
      ['a url that is no web address', { body: { email, url: 'ftp://x' } }, URL_REASON],
      ['no email', { body: { url: 'https://example.org' } }, 'email must be a non-empty string'],
      ['a list', { body: [email] }, 'body must be a JSON object'],
      ['no JSON', { raw: '{not json' }, 'body is not valid JSON'],
    ]) {
      assert.deepEqual(await request(base, 'POST', '/tokens', { headers, ...opts }), { status: 400, json: { error: reason } }, `${label}: ${what}`);
    }
  }
  assert.equal((await call('GET', '/token', { headers: bearer(t) })).status, 200, 'nothing renewed: the token still works');
  const s = await limitServer();
  try {
    await listEmail(s.base, email);
    const from = { 'X-Real-IP': '203.0.113.77' };
    const own = await request(s.base, 'POST', '/tokens', { headers: from, body: { email } });
    assert.equal(own.status, 201);
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(await request(s.base, 'POST', '/tokens', { headers: { ...from, ...bearer('made-up') }, body: { email } }), REFUSED);
    }
    for (const [label, token] of [['the right token', own.json.token], ['a wrong token', 'made-up']]) {
      const over = await request(s.base, 'POST', '/tokens', { headers: { ...from, ...bearer(token) }, body: { email } });
      assert.deepEqual(over, { status: 429, json: { error: 'too many asks' } }, `over the limit, ${label}`);
    }
    const elsewhere = await request(s.base, 'POST', '/tokens', { headers: { 'X-Real-IP': '203.0.113.78', ...bearer(own.json.token) }, body: { email } });
    assert.equal(elsewhere.status, 200, 'the 429 renewed nothing: the token is still current');
  } finally {
    await s.close();
  }
});

test('re-call A10a: an unknown address with any bearer token gets the 401 of A1; every answer of the tokens endpoint is JSON', async () => {
  const email = 'recall-a10a@example.org';
  await listEmail(base, email);
  const t = (await tokenAt(base, email)).token;
  const raw = async (b, headers, body) => {
    const res = await fetch(new URL('/tokens', b), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    const text = await res.text();
    assert.ok(String(res.headers.get('content-type')).startsWith('application/json'), `${res.status}: content-type`);
    return { status: res.status, json: JSON.parse(text) };
  };
  const later = await raw(base, {}, JSON.stringify({ email }));
  assert.deepEqual(later, REFUSED, 'a later ask with no token');
  for (const [label, headers] of [['no bearer', {}], ['a made-up bearer', bearer('made-up')], ['a real token', bearer(t)], ['the admin token', asAdmin]]) {
    for (const unknown of ['recall-a10a-never@example.org', 'recall-a10a-never+x@example.org']) {
      assert.deepEqual(await raw(base, headers, JSON.stringify({ email: unknown })), later, `${unknown}, ${label}`);
    }
  }
  assert.deepEqual(await raw(base, bearer('made-up'), JSON.stringify({ email })), later, 'a known address, a wrong token');
  const renewed = await raw(base, bearer(t), JSON.stringify({ email }));
  assert.equal(renewed.status, 200);
  assert.equal((await raw(base, {}, JSON.stringify({ email: 'recall-a10a+first@example.org' }))).status, 201);
  assert.equal((await raw(base, {}, '{not json')).status, 400);
  const s = await limitServer();
  try {
    const from = { 'X-Real-IP': '203.0.113.79' };
    for (let i = 0; i < 5; i++) await raw(s.base, from, JSON.stringify({ email }));
    assert.deepEqual(await raw(s.base, from, JSON.stringify({ email })), { status: 429, json: { error: 'too many asks' } });
  } finally {
    await s.close();
  }
});

test('re-call A11: a deactivated address\'s later ask with the right token is refused; activated, that token works and renews', async () => {
  const email = 'recall-a11@example.org';
  await listEmail(base, email);
  const t = (await tokenAt(base, email)).token;
  const v = (await tokenAt(base, 'recall-a11+v@example.org')).token;
  await activate(base, email, false);
  assert.deepEqual(await askAt(base, email, {}, bearer(t)), REFUSED, 'the right token, deactivated');
  assert.deepEqual(await askAt(base, 'recall-a11+v@example.org', {}, bearer(v)), REFUSED, 'a variation\'s right token, deactivated');
  await activate(base, email, true);
  assert.equal((await call('GET', '/token', { headers: bearer(t) })).status, 200, 'activated, the token works');
  const r = await askAt(base, email, {}, bearer(t));
  assert.equal(r.status, 200, 'activated, the token renews');
  assert.ok(r.json.token !== t, 'a new token');
  assert.equal((await askAt(base, 'recall-a11+v@example.org', {}, bearer(v))).status, 200, 'the variation renews too');
});

test('re-call A12: a database made by the service\'s own openDb and filled as the shipped code holds it opens with every row kept and no dropped line', async () => {
  const dir = mkdtempSync(join(dataDir, 'recall-'));
  const held = randomBytes(32).toString('base64url');
  // The tables made by src/db.js, the add store no longer among them; dates recent, so no notice is past its 90 days.
  const made = openDb({ DATA_DIR: dir });
  try {
    made.prepare('INSERT INTO authorized_emails (id, email, active) VALUES (1, ?, 1)').run(HOLDER);
    made.prepare('INSERT INTO tokens (id, email, token, authorized_email, url, date, last_delivery_date, last_delivery_status) VALUES (1, ?, ?, 1, ?, ?, ?, ?)')
      .run(HOLDER, held, 'https://example.org/kept', ago(3 * DAY_MS), ago(3 * DAY_MS - 300_000), 200);
    made.prepare('INSERT INTO notices (id, item, state, what, body, received, token_id) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run('kept-n1', 'feature/kept', 'open', 'w', '{"item":"feature/kept","state":"open","what":"w"}', ago(3 * DAY_MS - 120_000));
    made.prepare('INSERT INTO thirdparty (id, last_delivery_date, last_delivery_status) VALUES (1, ?, ?)').run(ago(3 * DAY_MS - 180_000), 204);
  } finally {
    made.close();
  }
  const TABLES = ['authorized_emails', 'tokens', 'notices', 'thirdparty'];
  const rows = () => {
    const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
    try {
      return Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map((r) => ({ ...r }))]));
    } finally {
      db.close();
    }
  };
  const before = rows();
  const s = await oneWay({ dir, list: false });
  const kept = [{ item: 'feature/kept', state: 'open', what: 'w' }];
  try {
    assert.deepEqual(s.lines, [], 'no dropped line');
    assert.deepEqual(rows(), before, 'every row kept');
    const st = await s.statusOf(held, 'feature/kept');
    assert.equal(st.status, 200, 'the token held from before opens a token route');
    assert.deepEqual(st.json, kept);
    const r = await askAt(s.base, HOLDER, {}, bearer(held));
    assert.equal(r.status, 200, 'the held token renews');
    assert.equal(r.json.url, 'https://example.org/kept', 'its URL kept');
    assert.deepEqual((await s.statusOf(r.json.token, 'feature/kept')).json, kept, 'the notice passes to the new token');
  } finally {
    await s.close();
  }
});

// Notice is the one way in: the cases one-way A1 to A30, one or more per acceptance criterion of the work item
// todo/notice-is-the-one-way-in-and-add-is-retired. Every address is a made-up one at example.org; no assertion message
// carries a part or a token. Each server here runs on its own data folder inside the first server's (removed with it).

const RETIRED = [
  ['POST', '/add', { body: BODY }],
  ['POST', '/update', { body: { id: 'x', what: 'x' } }],
  ['GET', '/status', { params: { id: 'x' } }],
  ['GET', '/inventory', {}],
];
const DROPPED_ONE = 'externality-tracker: dropped old table externalities';
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const KEPT = { status: 201, json: { kept: true } };

// Polls `check` every 50 ms, up to 3 s, until it holds; never fails by itself, so the assertion after it decides.
async function waitFor(check) {
  for (let i = 0; i < 60 && !(await check()); i++) await sleep(50);
}

// A server with its notice address on. `allow` is THIRDPARTY_ALLOW (undefined: unset), `env` adds variables, `dir` reuses
// a data folder, `list` lists HOLDER. The lines the server writes to the log at start are caught in `lines`.
async function oneWay({ allow, env = {}, dir, list = true } = {}) {
  const part = randomBytes(32).toString('base64url');
  const folder = dir ?? mkdtempSync(join(dataDir, 'one-way-'));
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  let s;
  try {
    s = createServer({ ORG_SLUG: ORG, ADMIN_TOKEN: ADMIN, ADDRESS_KEY: part, DATA_DIR: folder,
      DELIVERY_TIMEOUT_MS: String(DELIVERY_TIMEOUT), ...(allow === undefined ? {} : { THIRDPARTY_ALLOW: allow }), ...env },
    { limits: ROOMY });
  } finally {
    console.log = log;
  }
  const b = await listenOn(s);
  if (list) await listEmail(b, HOLDER);
  let n = 0;
  const file = join(folder, 'externalities.sqlite');
  return {
    base: b, dir: folder, file, lines,
    req: (method, path, opts) => request(b, method, path, opts),
    // A token of its own: a new variation of HOLDER, naming `url` as its forwarding address when given.
    token: async (url) => (await tokenAt(b, `holder+ow${++n}@example.org`, url === undefined ? {} : { url })).token,
    tokenId: (token) => {
      const db = new DatabaseSync(file);
      try {
        return db.prepare('SELECT id FROM tokens WHERE token = ?').get(token).id;
      } finally {
        db.close();
      }
    },
    notify: (token, body, headers = {}) => request(b, 'POST', `/${part}/notify`,
      { headers: { ...bearer(token), ...headers }, ...(typeof body === 'string' ? { raw: body } : { body }) }),
    statusOf: (token, item, opts = {}) => request(b, 'GET', `/${part}/status?item=${encodeURIComponent(item)}`,
      { ...opts, headers: { ...bearer(token), ...opts.headers } }),
    tokenInfo: (token) => request(b, 'GET', '/token', { headers: bearer(token) }),
    outcome: (token) => request(b, 'GET', '/thirdparty', { headers: bearer(token) }),
    close: async () => { s.closeAllConnections(); await new Promise((resolve) => s.close(resolve)); },
  };
}

// The token's own delivery outcome once one has settled (`done`), else as it stands after 3 s.
async function forwarded(s, token, done = (t) => t['last-delivery-date'] !== null) {
  let info;
  await waitFor(async () => done((info = (await s.tokenInfo(token)).json)));
  return info;
}

// Writes a notice row straight into a server's database, received at `received`, under the token row `tokenId`.
function plant(file, id, item, received, tokenId, extra = {}) {
  const db = new DatabaseSync(file);
  try {
    const body = JSON.stringify({ item, state: 'open', what: 'w', id, ...extra });
    db.prepare('INSERT INTO notices (id, item, state, what, body, received, token_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, item, 'open', 'w', body, received, tokenId);
    return JSON.parse(body);
  } finally {
    db.close();
  }
}

const noticeIds = (file) => {
  const db = new DatabaseSync(file);
  try {
    return db.prepare('SELECT id FROM notices ORDER BY id').all().map((r) => r.id);
  } finally {
    db.close();
  }
};

// A database in the shape the code at 792a883 made it, the add store `externalities` among its tables, a row in each.
// Returns the token held in it (never printed).
function addStoreDatabase(dir) {
  const held = randomBytes(32).toString('base64url');
  const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
  try {
    db.exec(`CREATE TABLE authorized_emails (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1)`);
    db.exec(`CREATE TABLE tokens (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
      authorized_email INTEGER NOT NULL REFERENCES authorized_emails(id), url TEXT, date TEXT NOT NULL,
      last_delivery_date TEXT, last_delivery_status INTEGER)`);
    db.exec(`CREATE TABLE externalities (
      id TEXT PRIMARY KEY, org TEXT, atlas TEXT, item TEXT, what TEXT,
      who_acts TEXT, how_observed TEXT, state TEXT, set_date TEXT,
      cleared_date TEXT, cleared_words TEXT, token_id INTEGER NOT NULL REFERENCES tokens(id))`);
    db.exec(`CREATE TABLE notices (id TEXT PRIMARY KEY, item TEXT, state TEXT, what TEXT, body TEXT, received TEXT,
      token_id INTEGER NOT NULL REFERENCES tokens(id))`);
    db.exec('CREATE TABLE thirdparty (id INTEGER PRIMARY KEY CHECK (id = 1), last_delivery_date TEXT, last_delivery_status INTEGER)');
    db.prepare('INSERT INTO authorized_emails (id, email, active) VALUES (1, ?, 1)').run(HOLDER);
    db.prepare('INSERT INTO tokens (id, email, token, authorized_email, url, date) VALUES (1, ?, ?, 1, NULL, ?)').run(HOLDER, held, ago(DAY_MS));
    db.prepare(`INSERT INTO externalities (id, org, atlas, item, what, who_acts, how_observed, state, set_date, cleared_date, cleared_words, token_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run('add-1', ORG, 'none', 'add-item', 'made by add', 'someone', 'somehow', 'open', ago(DAY_MS), null, null);
    db.prepare('INSERT INTO notices (id, item, state, what, body, received, token_id) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run('kept-n1', 'feature/ow-kept', 'open', 'w', '{"item":"feature/ow-kept","state":"open","what":"w"}', ago(DAY_MS));
    db.prepare('INSERT INTO thirdparty (id, last_delivery_date, last_delivery_status) VALUES (1, ?, ?)').run(ago(DAY_MS), 204);
  } finally {
    db.close();
  }
  return held;
}

// Every row of the named tables, and the names of every table, read from a database file.
function snapshot(file, tables) {
  const db = new DatabaseSync(file);
  try {
    return {
      names: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name),
      rows: Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map((r) => ({ ...r }))])),
    };
  } finally {
    db.close();
  }
}

const KEPT_TABLES = ['notices', 'tokens', 'authorized_emails', 'thirdparty'];

// A local server that answers every post with a redirect to `to`, counting the posts it gets.
async function redirector(to) {
  const r = { hits: 0 };
  r.server = http.createServer((req, res) => {
    r.hits += 1;
    req.resume();
    req.on('end', () => res.writeHead(302, { location: to }).end());
  });
  await new Promise((resolve) => r.server.listen(0, '127.0.0.1', resolve));
  r.url = `http://127.0.0.1:${r.server.address().port}/hook`;
  r.close = async () => { r.server.closeAllConnections(); await new Promise((resolve) => r.server.close(resolve)); };
  return r;
}

test('one-way A1: each of the four retired calls answers 404 not found with a valid token, with none and with a wrong one', async () => {
  const variants = (token) => [
    ['a valid token', { ...bearer(token), 'X-Org-Slug': ORG, 'X-Atlas-Slug': 'ow-a1', 'X-Item-Slug': 'ow-a1-item' }],
    ['none', {}],
    ['a wrong one', bearer('made-up')],
  ];
  for (const [method, path, opts] of RETIRED) {
    for (const [label, headers] of variants(TOKEN)) {
      assert.deepEqual(await call(method, path, { ...opts, headers }), NOT_FOUND, `${method} ${path}: ${label}`);
    }
  }
  const s = await oneWay();
  try {
    const t = await s.token();
    for (const [method, path, opts] of RETIRED) {
      for (const [label, headers] of variants(t)) {
        assert.deepEqual(await s.req(method, path, { ...opts, headers }), NOT_FOUND, `with the notice address on, ${method} ${path}: ${label}`);
      }
    }
    assert.deepEqual(await s.notify(t, notice('feature/ow-a1', 'open')), KEPT, 'the notice is the way in');
  } finally {
    await s.close();
  }
});

test('one-way A2: a database holding an externalities table with a row opens with that table gone and the drop line logged once', async () => {
  const dir = mkdtempSync(join(dataDir, 'one-way-a2-'));
  addStoreDatabase(dir);
  assert.ok(snapshot(join(dir, 'externalities.sqlite'), []).names.includes('externalities'), 'the table is there before the start');
  const s = await oneWay({ dir, list: false });
  try {
    assert.deepEqual(s.lines, [DROPPED_ONE], 'one line, once');
    assert.equal(snapshot(s.file, []).names.includes('externalities'), false, 'the table is gone');
  } finally {
    await s.close();
  }
});

test('one-way A3: after that start the rows of notices, tokens, authorized_emails and thirdparty made before it are all still read', async () => {
  const dir = mkdtempSync(join(dataDir, 'one-way-a3-'));
  const held = addStoreDatabase(dir);
  const before = snapshot(join(dir, 'externalities.sqlite'), KEPT_TABLES).rows;
  const s = await oneWay({ dir, list: false });
  try {
    assert.deepEqual(snapshot(s.file, KEPT_TABLES).rows, before, 'every row of the four tables as it was');
    const info = await s.tokenInfo(held);
    assert.equal(info.status, 200, 'the token made before opens its routes');
    assert.deepEqual(await s.statusOf(held, 'feature/ow-kept'), { status: 200, json: [{ item: 'feature/ow-kept', state: 'open', what: 'w' }] },
      'the notice made before is read');
    assert.deepEqual((await s.outcome(held)).json, { 'last-delivery-date': before.thirdparty[0].last_delivery_date, 'last-delivery-status': 204 },
      'the third-party outcome made before is read');
  } finally {
    await s.close();
  }
});

test('one-way A4: a second start on the same database logs no drop line and changes nothing', async () => {
  const dir = mkdtempSync(join(dataDir, 'one-way-a4-'));
  addStoreDatabase(dir);
  let s = await oneWay({ dir, list: false });
  await s.close();
  const after = snapshot(s.file, KEPT_TABLES);
  s = await oneWay({ dir, list: false });
  try {
    assert.deepEqual(s.lines, [], 'no drop line');
    assert.deepEqual(snapshot(s.file, KEPT_TABLES), after, 'every table and row as the first start left them');
  } finally {
    await s.close();
  }
});

test('one-way A5: a call carrying neither slug is accepted by every remaining token route; a notice\'s item and atlas come back whole', async () => {
  const s = await oneWay();
  try {
    const t = await s.token();
    const item = 'feature/ow-a5 with spaces';
    const sent = notice(item, 'open', { atlas: 'an-atlas/its slug', what: 'a wait' });
    assert.deepEqual(await s.notify(t, sent), KEPT, 'the notice, no slug');
    assert.deepEqual(await s.statusOf(t, item), { status: 200, json: [sent] }, 'the status read, no slug');
    assert.equal((await s.tokenInfo(t)).status, 200, 'GET /token, no slug');
    assert.equal((await s.outcome(t)).status, 200, 'GET /thirdparty, no slug');
    // Slugs sent as headers or parameters are read by nothing: the notice is kept and read back as sent.
    const slugged = notice(item, 'cleared', { atlas: 'an-atlas/its slug' });
    const slugs = { 'X-Atlas-Slug': 'other-atlas', 'X-Item-Slug': 'other-item' };
    assert.deepEqual(await s.notify(t, slugged, slugs), KEPT);
    assert.deepEqual(await s.statusOf(t, item, { headers: slugs, params: { 'atlas-slug': 'x', 'item-slug': 'y' } }),
      { status: 200, json: [slugged, sent] }, 'item and atlas whole, the slugs ignored');
  } finally {
    await s.close();
  }
});

test('one-way A6: a kept notice answers 201 with exactly {"kept": true}', async () => {
  const s = await oneWay();
  try {
    const t = await s.token();
    const r = await s.notify(t, notice('feature/ow-a6', 'open'));
    assert.deepEqual(r, KEPT);
    assert.deepEqual(Object.keys(r.json), ['kept'], 'no id');
    assert.deepEqual(await s.notify(t, { item: 'feature/ow-a6', state: 'cleared', what: 'w' }), KEPT, 'a cleared notice too');
  } finally {
    await s.close();
  }
});

test('one-way A7: two notices for one reference and one what, open then cleared, are both returned by the status read, the later first', async () => {
  const s = await oneWay();
  try {
    const t = await s.token();
    const item = 'feature/ow-a7';
    const opened = notice(item, 'open', { what: 'one wait' });
    const cleared = notice(item, 'cleared', { what: 'one wait', 'cleared-date': '2026-11-19T10:00:00.000Z', 'cleared-words': 'it came' });
    assert.equal((await s.notify(t, opened)).status, 201);
    await sleep(5);
    assert.equal((await s.notify(t, cleared)).status, 201);
    assert.deepEqual(await s.statusOf(t, item), { status: 200, json: [cleared, opened] }, 'both kept, nothing merged or closed');
  } finally {
    await s.close();
  }
});

test('one-way A8: each refusal of the notice test answers as the shipped cases assert, and nothing is kept', async () => {
  const s = await oneWay();
  try {
    const t = await s.token();
    const item = 'feature/ow-a8';
    for (const [label, raw, message] of [
      ['a blank body', '', RECORD],
      ['a list', JSON.stringify([{ item, state: 'open', what: 'w' }]), `${RECORD}; got a list`],
      ['no item', JSON.stringify({ state: 'open', what: 'w' }), ITEM_MSG],
      ['a state of Open', JSON.stringify({ item, state: 'Open', what: 'w' }), 'state must be open or cleared; got Open'],
      ['no what', JSON.stringify({ item, state: 'open' }), WHAT_MSG],
      ['an empty record', '{}', `${ITEM_MSG}; state must be open or cleared; got nothing; ${WHAT_MSG}`],
    ]) {
      assert.deepEqual(await s.notify(t, raw), { status: 400, json: { error: message } }, label);
    }
    assert.deepEqual(await s.statusOf(t, item), { status: 200, json: [] }, 'nothing kept');
    assert.equal(noticeIds(s.file).length, 0, 'no row');
  } finally {
    await s.close();
  }
});

test('one-way A9: a token with a forwarding address receives its own notice once, the body byte-equal to what was sent', async () => {
  const rx = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    const raw = `{ "item":"feature/ow-a9",  "state":"open","what":"a wait", "n": 1.50, "x":"é" }`;
    assert.deepEqual(await s.notify(t, raw), KEPT);
    await waitFor(() => rx.requests.length > 0);
    await sleep(NEGATIVE_WAIT);
    assert.equal(rx.requests.length, 1, 'once');
    assert.equal(rx.requests[0].body, raw, 'the text exactly as received');
  } finally {
    await s.close();
  }
});

test('one-way A10: the forwarded post carries content-type application/json and no authorization header', async () => {
  const rx = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    const raw = JSON.stringify(notice('feature/ow-a10', 'open'));
    // the notice's own post carries the holder's token as its authorization header
    assert.equal((await s.notify(t, raw)).status, 201);
    await waitFor(() => rx.requests.length > 0);
    assert.equal(rx.requests.length, 1, 'forwarded');
    const q = rx.requests[0];
    assert.equal(q.headers['content-type'], 'application/json');
    assert.equal(q.headers['content-length'], String(Buffer.byteLength(raw)));
    assert.equal('authorization' in q.headers, false, 'no authorization header');
  } finally {
    await s.close();
  }
});

test('one-way A11: a notice of state open and one of state cleared are both forwarded', async () => {
  const rx = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    const texts = [JSON.stringify(notice('feature/ow-a11', 'open')),
      JSON.stringify(notice('feature/ow-a11', 'cleared', { 'cleared-date': '2026-11-19T10:00:00.000Z', 'cleared-words': 'done' }))];
    for (const [i, raw] of texts.entries()) {
      assert.equal((await s.notify(t, raw)).status, 201);
      await waitFor(() => rx.requests.length > i);
    }
    await sleep(NEGATIVE_WAIT);
    assert.deepEqual(rx.requests.map((q) => q.body), texts, 'open and cleared, each once, in order');
  } finally {
    await s.close();
  }
});

test('one-way A12: a second token\'s forwarding address receives nothing of the first token\'s notice', async () => {
  const rxA = await receiver();
  const rxB = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const a = await s.token(rxA.url);
    const b = await s.token(rxB.url);
    assert.equal((await s.notify(a, notice('feature/ow-a12', 'open'))).status, 201);
    await waitFor(() => rxA.requests.length > 0);
    await sleep(NEGATIVE_WAIT);
    assert.equal(rxA.requests.length, 1, "positive control: the sender's own address got it");
    assert.equal(rxB.requests.length, 0, "the other token's address got nothing");
    assert.deepEqual((await s.tokenInfo(b)).json['last-delivery-date'], null, 'no attempt on the other token');
  } finally {
    await s.close();
  }
});

test('one-way A13: a token with no forwarding address causes no post, and its GET /token shows no delivery', async () => {
  const rx = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const none = await s.token();
    await s.token(rx.url); // a token with an address, which sends nothing here
    assert.equal((await s.notify(none, notice('feature/ow-a13', 'open'))).status, 201);
    await sleep(NEGATIVE_WAIT);
    assert.equal(rx.requests.length, 0, 'no post');
    const info = (await s.tokenInfo(none)).json;
    assert.equal(info.url, null);
    assert.equal(info['last-delivery-date'], null, 'no delivery');
    assert.equal(info['last-delivery-status'], null, 'no delivery');
  } finally {
    await s.close();
  }
});

test('one-way A14: a receiver that answers with a redirect is posted to once and the redirect\'s target not at all', async () => {
  const target = await receiver();
  const redirecting = await redirector(target.url);
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(redirecting.url);
    assert.equal((await s.notify(t, notice('feature/ow-a14', 'open'))).status, 201);
    const info = await forwarded(s, t);
    await sleep(NEGATIVE_WAIT);
    assert.equal(redirecting.hits, 1, 'posted to once');
    assert.equal(target.requests.length, 0, 'the target receives nothing');
    assert.equal(info['last-delivery-status'], 302, 'the 3xx is the outcome');
  } finally {
    await s.close();
    await redirecting.close();
  }
});

test('one-way A15: a receiver that never answers leaves status 0 after the delivery timeout, the notice having answered 201 first', async () => {
  const rx = await receiver(null);
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    const started = performance.now();
    const r = await s.notify(t, notice('feature/ow-a15', 'open'));
    const elapsed = performance.now() - started;
    assert.equal(r.status, 201);
    assert.ok(elapsed < DELIVERY_TIMEOUT, `answered in ${Math.round(elapsed)} ms, before the timeout`);
    const info = await forwarded(s, t);
    assert.equal(info['last-delivery-status'], 0, 'no response: status 0');
    assert.match(String(info['last-delivery-date']), ISO);
    assert.equal(rx.requests.length, 1, 'one request');
    assert.equal(rx.sockets.size, 1, 'connected once');
  } finally {
    await s.close();
  }
});

test('one-way A16: a closed port leaves status 0, the notice having answered 201 and being read back by the status read', async () => {
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(await closedPortUrl());
    const sent = notice('feature/ow-a16', 'open');
    assert.deepEqual(await s.notify(t, sent), KEPT);
    assert.deepEqual(await s.statusOf(t, 'feature/ow-a16'), { status: 200, json: [sent] });
    const info = await forwarded(s, t);
    assert.equal(info['last-delivery-status'], 0);
    assert.match(String(info['last-delivery-date']), ISO);
  } finally {
    await s.close();
  }
});

test('one-way A17: a forwarding address in a refused range receives nothing; GET /token shows status 0 and the attempt\'s time', async () => {
  const rx = await receiver();
  const port = rx.url.split(':')[2].split('/')[0];
  const s = await oneWay(); // no THIRDPARTY_ALLOW: loopback is refused
  try {
    for (const host of ['127.0.0.1', 'localhost', '[::ffff:127.0.0.1]']) {
      const t = await s.token(`http://${host}:${port}/hook`);
      const before = new Date().toISOString();
      assert.equal((await s.notify(t, notice('feature/ow-a17', 'open'))).status, 201, host);
      const info = await forwarded(s, t);
      assert.equal(info['last-delivery-status'], 0, `${host}: status 0`);
      assert.match(String(info['last-delivery-date']), ISO, `${host}: the attempt's time`);
      assert.ok(info['last-delivery-date'] >= before, `${host}: the time of this attempt`);
    }
    await sleep(NEGATIVE_WAIT);
    assert.equal(rx.requests.length, 0, 'nothing sent');
  } finally {
    await s.close();
  }
});

test('one-way A18: the same address, exempted by THIRDPARTY_ALLOW, receives the notice', async () => {
  const rx = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    assert.equal((await s.notify(t, notice('feature/ow-a18', 'open'))).status, 201);
    const info = await forwarded(s, t);
    assert.equal(rx.requests.length, 1, 'received');
    assert.equal(info['last-delivery-status'], 200);
  } finally {
    await s.close();
  }
});

test('one-way A19: GET /token shows the status and time of the latest attempt, and never the token', async () => {
  const rx = await receiver(200);
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    assert.equal((await s.notify(t, notice('feature/ow-a19', 'open'))).status, 201);
    const one = await forwarded(s, t);
    assert.equal(one['last-delivery-status'], 200);
    assert.match(String(one['last-delivery-date']), ISO);
    rx.status = 503;
    assert.equal((await s.notify(t, notice('feature/ow-a19', 'cleared'))).status, 201);
    const two = await forwarded(s, t, (x) => x['last-delivery-status'] === 503);
    assert.equal(two['last-delivery-status'], 503, 'the latest attempt');
    assert.ok(two['last-delivery-date'] >= one['last-delivery-date'], 'dated no earlier');
    const r = await s.tokenInfo(t);
    assert.deepEqual(Object.keys(r.json).sort(), TOKEN_FIELDS);
    assert.equal(JSON.stringify(r.json).includes(t), false, 'the token is never in the answer');
  } finally {
    await s.close();
  }
});

test('one-way A20: the forwarded post carries x-externality-passed-on: 1', async () => {
  const rx = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rx.url);
    assert.equal((await s.notify(t, notice('feature/ow-a20', 'open'))).status, 201);
    await waitFor(() => rx.requests.length > 0);
    assert.equal(rx.requests.length, 1, 'forwarded');
    assert.equal(rx.requests[0].headers[PASSED], '1');
  } finally {
    await s.close();
  }
});

test('one-way A21: a notice arriving with that header is kept and answered 201, and reaches neither the forwarding address nor a quiet address', async () => {
  const rxF = await receiver();
  const rxQ = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rxF.url);
    for (const [label, value] of [['one', '1'], ['other', 'no'], ['empty', '']]) {
      const item = `feature/ow-a21-${label}`;
      const r = await s.notify(t, tpNotice(item, 'open', rxQ.url), { [PASSED]: value });
      assert.equal(r.status, 201, label);
      assert.equal((await s.statusOf(t, item)).json.length, 1, `${label}: kept`);
    }
    await sleep(NEGATIVE_WAIT);
    assert.equal(rxF.requests.length, 0, 'not forwarded');
    assert.equal(rxQ.requests.length, 0, 'not passed on');
    assert.equal((await s.tokenInfo(t)).json['last-delivery-date'], null, 'no attempt on the token');
    assert.deepEqual((await s.outcome(t)).json, NULL_OUTCOME, 'no third-party outcome');
    // the positive control: the same notice without the header reaches both
    assert.equal((await s.notify(t, tpNotice('feature/ow-a21-control', 'open', rxQ.url))).status, 201);
    await waitFor(() => rxF.requests.length > 0 && rxQ.requests.length > 0);
    assert.equal(rxF.requests.length, 1, 'control: forwarded');
    assert.equal(rxQ.requests.length, 1, 'control: passed on');
  } finally {
    await s.close();
  }
});

test('one-way A22: a notice naming a quiet address, under a token with a forwarding address, reaches both receivers', async () => {
  const rxF = await receiver();
  const rxQ = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const t = await s.token(rxF.url);
    const raw = tpNotice('feature/ow-a22', 'open', rxQ.url);
    assert.equal((await s.notify(t, raw)).status, 201);
    await waitFor(() => rxF.requests.length > 0 && rxQ.requests.length > 0);
    await sleep(NEGATIVE_WAIT);
    assert.deepEqual(rxF.requests.map((q) => q.body), [raw], 'the forwarding address, once');
    assert.deepEqual(rxQ.requests.map((q) => q.body), [raw], 'the quiet address, once');
  } finally {
    await s.close();
  }
});

test('one-way A23: with either receiver closed, the other still receives the notice, and the notice is kept', async () => {
  const rxF = await receiver();
  const rxQ = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    // the quiet address closed: the forwarding address still receives
    const f = await s.token(rxF.url);
    assert.equal((await s.notify(f, tpNotice('feature/ow-a23-f', 'open', await closedPortUrl()))).status, 201);
    await waitFor(() => rxF.requests.length > 0);
    assert.equal(rxF.requests.length, 1, 'the forwarding address received it, the quiet one closed');
    assert.equal((await s.statusOf(f, 'feature/ow-a23-f')).json.length, 1, 'kept');
    // the forwarding address closed: the quiet address still receives
    const q = await s.token(await closedPortUrl());
    assert.equal((await s.notify(q, tpNotice('feature/ow-a23-q', 'open', rxQ.url))).status, 201);
    await waitFor(() => rxQ.requests.length > 0);
    assert.equal(rxQ.requests.length, 1, 'the quiet address received it, the forwarding one closed');
    assert.equal((await s.statusOf(q, 'feature/ow-a23-q')).json.length, 1, 'kept');
    assert.equal((await forwarded(s, q))['last-delivery-status'], 0, 'the closed forwarding address: status 0');
  } finally {
    await s.close();
  }
});

test('one-way A24: the quiet way and GET /thirdparty behave as before beside the forwarding, each outcome in its own place', async () => {
  const rxQ = await receiver();
  const rxF = await receiver();
  const s = await oneWay({ allow: '127.0.0.1' });
  try {
    const plain = await s.token();
    const raw = tpNotice('feature/ow-a24', 'open', rxQ.url);
    assert.equal((await s.notify(plain, raw)).status, 201);
    await waitFor(async () => (await s.outcome(plain)).json['last-delivery-status'] !== null);
    const quiet = (await s.outcome(plain)).json;
    assert.equal(quiet['last-delivery-status'], 200, 'the quiet outcome on GET /thirdparty');
    assert.deepEqual(rxQ.requests.map((q) => q.body), [raw], 'the text as received, once');
    assert.equal((await s.tokenInfo(plain)).json['last-delivery-date'], null, 'the quiet way writes nothing on the token');
    // a forwarding alone writes on its token and leaves GET /thirdparty as it was
    const f = await s.token(rxF.url);
    assert.equal((await s.notify(f, notice('feature/ow-a24-f', 'open'))).status, 201);
    await waitFor(() => rxF.requests.length > 0);
    await sleep(NEGATIVE_WAIT);
    assert.equal(rxF.requests.length, 1, 'forwarded');
    assert.deepEqual((await s.outcome(plain)).json, quiet, 'GET /thirdparty unchanged by the forwarding');
  } finally {
    await s.close();
  }
});

test('one-way A25: a notice of 90 days and a minute is deleted when a notice is kept; one of 90 days less a minute stays, whichever token', async () => {
  const s = await oneWay();
  try {
    const a = await s.token();
    const b = await s.token();
    const old = plant(s.file, 'ow-a25-old', 'feature/ow-a25', ago(90 * DAY_MS + 60_000), s.tokenId(a));
    const young = plant(s.file, 'ow-a25-young', 'feature/ow-a25', ago(90 * DAY_MS - 60_000), s.tokenId(b));
    assert.deepEqual((await s.statusOf(a, 'feature/ow-a25')).json, [old], 'the old one is there before');
    assert.deepEqual((await s.statusOf(b, 'feature/ow-a25')).json, [young]);
    assert.equal((await s.notify(a, notice('feature/ow-a25-new', 'open'))).status, 201);
    assert.deepEqual((await s.statusOf(a, 'feature/ow-a25')).json, [], 'more than 90 days: gone');
    assert.deepEqual((await s.statusOf(b, 'feature/ow-a25')).json, [young], 'less than 90 days, under another token: read');
    assert.deepEqual(noticeIds(s.file).filter((id) => id.startsWith('ow-a25')), ['ow-a25-young']);
  } finally {
    await s.close();
  }
});

test('one-way A26: the clean-up reads no variable and holds the 90 days fixed; with likely variables set it still deletes at 90 days', async () => {
  const code = readFileSync(join(ROOT, 'src', 'notices.js'), 'utf8');
  assert.doesNotMatch(code, /process\.env|\benv\b/, 'src/notices.js reads no variable');
  assert.match(code, /\b90 \* 24\b/, 'the 90 days as 90 times 24 hours, a fixed number');
  const likely = { NOTICE_DAYS: '1', NOTICE_TTL_DAYS: '1', NOTICE_MAX_AGE_DAYS: '1', RETENTION_DAYS: '1', CLEANUP_DAYS: '1',
    MAX_AGE_DAYS: '1', TTL_DAYS: '1', NOTICE_RETENTION_DAYS: '1000', CLEANUP: 'off' };
  const s = await oneWay({ env: likely });
  try {
    const t = await s.token();
    const id = s.tokenId(t);
    plant(s.file, 'ow-a26-2d', 'feature/ow-a26', ago(2 * DAY_MS), id);
    plant(s.file, 'ow-a26-89d', 'feature/ow-a26', ago(89 * DAY_MS), id);
    plant(s.file, 'ow-a26-91d', 'feature/ow-a26', ago(91 * DAY_MS), id);
    assert.equal((await s.notify(t, notice('feature/ow-a26-new', 'open'))).status, 201);
    assert.deepEqual(noticeIds(s.file).filter((x) => x.startsWith('ow-a26')), ['ow-a26-2d', 'ow-a26-89d'], 'deleted at 90 days, not at 1 or 1000');
  } finally {
    await s.close();
  }
});

test('one-way A27: with the delete made to fail, the arriving notice is kept and answered 201, and the old notice is still there', async () => {
  const s = await oneWay();
  try {
    const t = await s.token();
    plant(s.file, 'ow-a27-old', 'feature/ow-a27', ago(100 * DAY_MS), s.tokenId(t));
    // The delete is made to fail by a trigger written into the database; the service is given no setting for it.
    const db = new DatabaseSync(s.file);
    try {
      db.exec("CREATE TRIGGER ow_a27_no_delete BEFORE DELETE ON notices BEGIN SELECT RAISE(ABORT, 'the delete is made to fail'); END");
    } finally {
      db.close();
    }
    const sent = notice('feature/ow-a27-new', 'open');
    assert.deepEqual(await s.notify(t, sent), KEPT, 'answered 201');
    assert.deepEqual((await s.statusOf(t, 'feature/ow-a27-new')).json, [sent], 'kept');
    assert.ok(noticeIds(s.file).includes('ow-a27-old'), 'the old notice is still there: the delete did fail');
    // the positive control: with the trigger gone, the next notice kept deletes it
    const fix = new DatabaseSync(s.file);
    try {
      fix.exec('DROP TRIGGER ow_a27_no_delete');
    } finally {
      fix.close();
    }
    assert.equal((await s.notify(t, notice('feature/ow-a27-next', 'open'))).status, 201);
    assert.equal(noticeIds(s.file).includes('ow-a27-old'), false, 'control: deleted once the delete can run');
  } finally {
    await s.close();
  }
});

test('one-way A28: each remaining route, called with an old notice in place, deletes nothing', async () => {
  const s = await oneWay();
  try {
    const t = await s.token();
    const old = plant(s.file, 'ow-a28-old', 'feature/ow-a28', ago(100 * DAY_MS), s.tokenId(t));
    const stays = (label) => assert.ok(noticeIds(s.file).includes('ow-a28-old'), `${label}: the old notice stays`);
    assert.deepEqual((await s.statusOf(t, 'feature/ow-a28')).json, [old]);
    stays('the status read');
    const first = await tokenAt(s.base, 'holder+ow-a28@example.org');
    stays('a first ask');
    assert.equal((await askAt(s.base, 'holder+ow-a28@example.org', {}, bearer(first.token))).status, 200);
    stays('a later ask');
    await listEmail(s.base, 'ow-a28@example.org');
    stays('POST /emails');
    await activate(s.base, 'ow-a28@example.org', false);
    stays('POST /emails/active');
    assert.equal((await s.tokenInfo(t)).status, 200);
    stays('GET /token');
    assert.equal((await s.outcome(t)).status, 200);
    stays('GET /thirdparty');
    assert.equal((await s.req('GET', '/')).status, 200);
    stays('GET /');
    assert.equal((await s.notify(t, '{}')).status, 400);
    stays('a refused notice');
    // the positive control: a kept notice deletes it
    assert.equal((await s.notify(t, notice('feature/ow-a28-new', 'open'))).status, 201);
    assert.equal(noticeIds(s.file).includes('ow-a28-old'), false, 'control: the keeping of a notice deletes it');
  } finally {
    await s.close();
  }
});

// The shipped cases that use no retired call, each as the SHA-256 (first 16 hex digits) of its text at 792a883: a case
// is each `test(` with a literal name, to the first `})` line at its own indent. Six cases the class rule first counted
// here are left out by the lead's ruling, as they used the add call through a helper or asserted what the spec changes:
// A23, "delivery: a token without a URL…", "delivery: a receiver answering 500…", "delivery: a second add…",
// "notify: a kept notice answers 201…" and A25.
const UNCHANGED_AT_792A883 = [
  'b300989daba04199', 'b5738f205d9ab3a1', '0f43b4135eff94de', '78cf598e9eecfac5', 'abb29dbd7643aff8',
  'e9a7b46a11023201', '8bbd9a123d15403a', '35c367723c01ce8f', 'f7e304fdfa08bb39', '39207af54b4b9500',
  'a16bc8033f2e5b00', '41213260e2271665', '94dc63dde49b0d9c', '9785a2f3f7a55c33', '11bc171138af2ff3',
  '5629cf2a91fd4dde', '45136a18b1383f17', '77b56bf87d44e011', 'f937cc2aa8caeeeb', '8037cbc973aa5191',
  '908e6d2f7db75a30',
  '4909c9edca4cbb28', '97a8602bddddb85c', 'd5114455731ab0ca', '3e57e0258d2ea3f8', '2055188dc2962ea6',
  'f89c996dbc1dbd58', '408cb0096781d4f9', '301e5bab9a5d5396', 'fb9121eadcb8d2d2',
  'ca0e73b0a8aa88e7', 'af435540528016a2', '55b94268cf626aff', 'a86fb28d702233f4', 'b10ce2d67d364dda',
  '790d8776bb1f6c0e', 'd7fe457063d1fa86', '448f008452df69a2', 'd478c38909e72a31', '0c3ab4666e7da24f',
  'cf7f7a92b2a4930c', 'e7fd0a0323bb1868', '73b33929ae8a1dc4', '9e7d1a38f2c7d05f', '29a43beaeca66668',
  'c9a0f8e5e9ce8803', '942be3bbee2e7b3a', '205a852360edded1', '8867d343bd501c63', '48a7fce6e958b5d8',
  'e3402deeb45593ef', '410726760abb39c4', '0fc7ee730be156f5', 'c966ecfa79441c95',
  'cb53b3de5d37e76f', 'f175901036f94a3d', '0cfff9542bd0dfa3', '9796fd99898a589a', '506368273ad05ccd',
  'ee021bc47293093f', '218f9a7d5c990df5', 'ebe27ccc732ef6b6',
];

test('one-way A29: every shipped case that uses no retired call is byte-equal to its text at 792a883', () => {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const have = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)test\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/.exec(lines[i]);
    if (!m) continue;
    const end = new RegExp(`^${m[1]}\\}\\)[;,]?\\s*$`);
    let j = i + 1;
    while (j < lines.length && !end.test(lines[j])) j++;
    have.add(createHash('sha256').update(lines.slice(i, j + 1).join('\n')).digest('hex').slice(0, 16));
  }
  assert.equal(UNCHANGED_AT_792A883.length, 62);
  assert.deepEqual(UNCHANGED_AT_792A883.filter((h) => !have.has(h)), [], 'each such case is present, byte for byte');
});

test('one-way A30: GET / answers the service\'s name externality-tracker', async () => {
  assert.equal((await call('GET', '/')).json.service, 'externality-tracker');
  const s = await oneWay({ list: false });
  try {
    const r = await s.req('GET', '/');
    assert.equal(r.status, 200);
    assert.equal(r.json.service, 'externality-tracker');
  } finally {
    await s.close();
  }
});
