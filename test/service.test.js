import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createServer } from '../src/server.js';
import { timeoutMs } from '../src/deliver.js';
import { loadAddressKey, loadAdminToken } from '../src/auth.js';
import { LIMITS, makeLimiter } from '../src/routes.js';
import { networkInterfaces } from 'node:os';
import { parseAllow, resolveTarget, postOnce, refusedList } from '../src/thirdparty.js';

const ORG = 'test-org';
const OLD_KEY = 'test-key-0123456789'; // a value of the old org key's kind: it opens nothing now
const ADMIN = randomBytes(32).toString('base64url'); // the test servers' ADMIN_TOKEN, never printed
const HOLDER = 'holder@example.org'; // every address here is a made-up one at example.org
const FIELDS = ['id', 'org-slug', 'atlas-slug', 'item-slug', 'what', 'who-acts', 'how-observed',
  'state', 'set-date', 'cleared-date', 'cleared-words'];
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
const auth = (atlas, item, extra = {}) => byToken(TOKEN, atlas, item, { 'X-Org-Slug': ORG, ...extra });
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

async function addOne(atlas, item, body = BODY) {
  const r = await call('POST', '/add', { headers: auth(atlas, item), body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

const idsOf = (recs) => recs.map((r) => r.id).sort();

test('add returns 201 with an id and the record', async () => {
  const r = await call('POST', '/add', { headers: auth('atlas-a', 'item-a'), body: BODY });
  assert.equal(r.status, 201);
  assert.equal(typeof r.json.id, 'string');
  assert.ok(r.json.id.length > 0);
  assert.equal(r.json.record.id, r.json.id);
  assert.equal(r.json.record.state, 'open');
  // `none` is the documented atlas slug of an item under no atlas: free text, accepted like any other.
  const none = await call('POST', '/add', { headers: auth('none', 'item-none'), body: BODY });
  assert.equal(none.status, 201, JSON.stringify(none.json));
  assert.equal(none.json.record['atlas-slug'], 'none');
});

test('add refuses missing slugs and missing fields with 400', async () => {
  assert.equal((await call('POST', '/add', { headers: auth(null, 'i'), body: BODY })).status, 400);
  assert.equal((await call('POST', '/add', { headers: auth('n', null), body: BODY })).status, 400);
  const r = await call('POST', '/add', { headers: auth('n', 'i'), body: { what: 'x', 'who-acts': 'y' } });
  assert.equal(r.status, 400);
  assert.equal(typeof r.json.error, 'string');
  assert.equal((await call('POST', '/add', { headers: auth('n', 'i'), body: { ...BODY, what: '' } })).status, 400);
});

test('status returns the eleven fields exactly with ISO timestamps', async () => {
  const id = await addOne('atlas-s', 'item-s');
  const r = await call('GET', '/status', { headers: read('atlas-s', 'item-s'), params: { id } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json.record).sort(), [...FIELDS].sort());
  const rec = r.json.record;
  assert.equal(rec.id, id);
  assert.equal(rec['org-slug'], ORG);
  assert.equal(rec['atlas-slug'], 'atlas-s');
  assert.equal(rec['item-slug'], 'item-s');
  assert.equal(rec.what, BODY.what);
  assert.equal(rec['who-acts'], BODY['who-acts']);
  assert.equal(rec['how-observed'], BODY['how-observed']);
  assert.equal(rec.state, 'open');
  assert.match(rec['set-date'], ISO);
  assert.equal(rec['cleared-date'], null);
  assert.equal(rec['cleared-words'], null);
});

test('status: missing id 400, unknown id 404, wrong atlas or item 404', async () => {
  const id = await addOne('atlas-t', 'item-t');
  assert.equal((await call('GET', '/status', { headers: read('atlas-t', 'item-t') })).status, 400);
  assert.equal((await call('GET', '/status', { headers: read('atlas-t', 'item-t'), params: { id: 'nope' } })).status, 404);
  assert.equal((await call('GET', '/status', { headers: read('other', 'item-t'), params: { id } })).status, 404);
  assert.equal((await call('GET', '/status', { headers: read('atlas-t', 'other'), params: { id } })).status, 404);
});

test('update changes text, clears with words and a date, reopens', async () => {
  const h = read('atlas-u', 'item-u');
  const id = await addOne('atlas-u', 'item-u');

  let r = await call('POST', '/update', { headers: h, body: { id, what: 'new what', 'who-acts': 'new who' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.record.what, 'new what');
  assert.equal(r.json.record['who-acts'], 'new who');
  assert.equal(r.json.record['how-observed'], BODY['how-observed']);

  r = await call('POST', '/update', { headers: h, body: { id, state: 'cleared' } });
  assert.equal(r.status, 400, 'clearing needs words');

  r = await call('POST', '/update', { headers: h, body: { id, state: 'cleared', 'cleared-words': 'done, by the operator' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.record.state, 'cleared');
  assert.equal(r.json.record['cleared-words'], 'done, by the operator');
  assert.match(r.json.record['cleared-date'], ISO);

  r = await call('GET', '/status', { headers: h, params: { id } });
  assert.equal(r.json.record.state, 'cleared');

  r = await call('POST', '/update', { headers: h, body: { id, state: 'open' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.record.state, 'open');
  assert.equal(r.json.record['cleared-date'], null);
  assert.equal(r.json.record['cleared-words'], null);
});

test('update: 404 on wrong atlas, wrong item, unknown id; 400 on bad input', async () => {
  const id = await addOne('atlas-v', 'item-v');
  assert.equal((await call('POST', '/update', { headers: read('other', 'item-v'), body: { id, what: 'x' } })).status, 404);
  assert.equal((await call('POST', '/update', { headers: read('atlas-v', 'other'), body: { id, what: 'x' } })).status, 404);
  assert.equal((await call('POST', '/update', { headers: read('atlas-v', 'item-v'), body: { id: 'nope', what: 'x' } })).status, 404);
  assert.equal((await call('POST', '/update', { headers: read('atlas-v', 'item-v'), body: { id } })).status, 400);
  assert.equal((await call('POST', '/update', { headers: read('atlas-v', 'item-v'), body: { id, state: 'gone' } })).status, 400);
  assert.equal((await call('POST', '/update', { headers: read('atlas-v', 'item-v'), body: { what: 'x' } })).status, 400);
});

test('inventory by none, atlas, item, both and state, newest first', async () => {
  const ids = {};
  for (const [atlas, item] of [['inv-n1', 'inv-i1'], ['inv-n1', 'inv-i2'], ['inv-n2', 'inv-i1'], ['inv-n2', 'inv-i2']]) {
    ids[`${atlas}/${item}`] = await addOne(atlas, item);
    await sleep(5);
  }
  const ids4 = Object.values(ids);
  const list = async (atlas, item, params = {}) => {
    const r = await call('GET', '/inventory', { headers: read(atlas, item), params });
    assert.equal(r.status, 200);
    return r.json.records;
  };
  const sortedDesc = (recs) => {
    for (let i = 1; i < recs.length; i++) {
      assert.ok(recs[i - 1]['set-date'] >= recs[i]['set-date'], 'newest first');
    }
  };

  const all = await list(null, null);
  sortedDesc(all);
  const allIds = all.map((r) => r.id);
  for (const id of ids4) assert.ok(allIds.includes(id));
  assert.deepEqual(all.filter((r) => ids4.includes(r.id)).map((r) => r.id), [...ids4].reverse());

  const byAtlas = await list('inv-n1', null);
  assert.deepEqual(byAtlas.map((r) => r.id), [ids['inv-n1/inv-i2'], ids['inv-n1/inv-i1']]);

  const byItem = await list(null, 'inv-i1');
  assert.deepEqual(byItem.map((r) => r.id), [ids['inv-n2/inv-i1'], ids['inv-n1/inv-i1']]);

  const both = await list('inv-n2', 'inv-i2');
  assert.deepEqual(both.map((r) => r.id), [ids['inv-n2/inv-i2']]);

  const h = read('inv-n2', 'inv-i2');
  await call('POST', '/update', { headers: h, body: { id: ids['inv-n2/inv-i2'], state: 'cleared', 'cleared-words': 'ok' } });
  const cleared = await list('inv-n2', null, { state: 'cleared' });
  assert.deepEqual(cleared.map((r) => r.id), [ids['inv-n2/inv-i2']]);
  const open = await list('inv-n2', null, { state: 'open' });
  assert.deepEqual(open.map((r) => r.id), [ids['inv-n2/inv-i1']]);
  for (const r of await list(null, null, { state: 'open' })) assert.equal(r.state, 'open');

  assert.equal((await call('GET', '/inventory', { headers: read(), params: { state: 'other' } })).status, 400);
  assert.equal((await list('inv-n1', null, { page: '2' })).length, 2, 'page is ignored');
});

test('precedence: org-slug from header, param, header wins', async () => {
  const h = read();
  assert.equal((await call('GET', '/inventory', { headers: { ...h, 'X-Org-Slug': ORG } })).status, 200);
  assert.equal((await call('GET', '/inventory', { headers: h, params: { 'org-slug': ORG } })).status, 200);
  assert.equal((await call('GET', '/inventory', { headers: { ...h, 'X-Org-Slug': ORG }, params: { 'org-slug': 'wrong' } })).status, 200);
  assert.equal((await call('GET', '/inventory', { headers: { ...h, 'X-Org-Slug': 'wrong' }, params: { 'org-slug': ORG } })).status, 401);
});

// The token is read from `Authorization: Bearer <token>` only; no assertion message carries it.
test('bearer: the scheme case-insensitively, the token trimmed; another scheme, an empty value, an old header and a parameter are missing', async () => {
  const s = { 'X-Atlas-Slug': 'bearer-atlas', 'X-Item-Slug': 'bearer-item' };
  for (const [label, headers] of [
    ['Bearer <token>', { ...s, 'Authorization': `Bearer ${TOKEN}` }],
    ['BEARER, two spaces, a trailing space', { ...s, 'authorization': `BEARER  ${TOKEN} ` }],
  ]) {
    const r = await call('POST', '/add', { headers, body: BODY });
    assert.equal(r.status, 201, `${label}: ${r.json && r.json.error}`);
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
    const r = await call('POST', '/add', { headers, params, body: BODY });
    assert.equal(r.status, 401, label);
    assert.equal(r.json.error, reason, label);
  }
});

for (const [name, header, param, field] of [
  ['atlas-slug', 'X-Atlas-Slug', 'atlas-slug', 'atlas-slug'],
  ['item-slug', 'X-Item-Slug', 'item-slug', 'item-slug'],
]) {
  test(`precedence: ${name} from header, param, header wins`, async () => {
    const other = name === 'atlas-slug' ? { 'X-Item-Slug': 'prec-item' } : { 'X-Atlas-Slug': 'prec-atlas' };
    const h0 = { 'X-Org-Slug': ORG, 'Authorization': `Bearer ${TOKEN}`, ...other };
    let r = await call('POST', '/add', { headers: { ...h0, [header]: 'from-header' }, body: BODY });
    assert.equal(r.json.record[field], 'from-header');
    r = await call('POST', '/add', { headers: h0, params: { [param]: 'from-param' }, body: BODY });
    assert.equal(r.json.record[field], 'from-param');
    r = await call('POST', '/add', { headers: { ...h0, [header]: 'from-header' }, params: { [param]: 'from-param' }, body: BODY });
    assert.equal(r.status, 201);
    assert.equal(r.json.record[field], 'from-header');
  });
}

test('auth: a wrong token, no token or another org is 401 with a reason', async () => {
  for (const [headers, reason] of [
    [{ 'X-Org-Slug': ORG, 'Authorization': 'Bearer wrong' }, 'unknown token'],
    [{ 'X-Org-Slug': ORG }, 'token is required'],
    [{ 'X-Org-Slug': 'another-org', 'Authorization': `Bearer ${TOKEN}` }, 'org slug does not match'],
  ]) {
    for (const [method, path, body] of [['GET', '/inventory'], ['POST', '/add', BODY], ['GET', '/status'],
      ['POST', '/update', { id: 'x', what: 'x' }]]) {
      const r = await call(method, path, { headers: { ...headers, 'X-Atlas-Slug': 'n', 'X-Item-Slug': 'i' }, body });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(r.json.error, reason, `${method} ${path}`);
    }
  }
});

test('bad body is 400, unknown id 404, DELETE and unknown routes 404', async () => {
  let r = await call('POST', '/add', { headers: auth('n', 'i'), raw: '{not json' });
  assert.equal(r.status, 400);
  assert.equal(typeof r.json.error, 'string');
  assert.equal((await call('POST', '/add', { headers: auth('n', 'i'), body: [1, 2] })).status, 400);
  assert.equal((await call('POST', '/update', { headers: read('n', 'i'), raw: '' })).status, 400);
  assert.equal((await call('GET', '/status', { headers: read('n', 'i'), params: { id: 'missing' } })).status, 404);
  for (const path of ['/', '/add', '/update', '/status', '/inventory', '/tokens', '/emails', '/emails/active', '/elsewhere']) {
    for (const headers of [auth('n', 'i'), asAdmin]) {
      r = await call('DELETE', path, { headers, body: { email: HOLDER } });
      assert.equal(r.status, 404, `DELETE ${path}`);
      assert.equal(typeof r.json.error, 'string');
    }
  }
  for (const [method, path] of [['GET', '/elsewhere'], ['GET', '/add'], ['POST', '/status'], ['PUT', '/update'], ['POST', '/'],
    ['GET', '/tokens'], ['GET', '/emails'], ['PUT', '/emails'], ['PATCH', '/emails/active'], ['POST', '/emails/delete']]) {
    assert.equal((await call(method, path, { headers: auth('n', 'i') })).status, 404, `${method} ${path}`);
  }
  assert.equal((await call('GET', '/token', { headers: read() })).status, 200, 'the listed address was not removed');
});

test("url parameters: no credential is read from one; the slugs' parameters still are", async () => {
  const id = await addOne('urlp-atlas', 'urlp-item');
  const slugs = { 'X-Org-Slug': ORG, 'X-Atlas-Slug': 'urlp-atlas', 'X-Item-Slug': 'urlp-item' };
  for (const [method, path, opts] of [
    ['POST', '/add', { body: BODY }],
    ['GET', '/status', { params: { id } }],
    ['POST', '/update', { body: { id, what: 'changed by a parameter' } }],
    ['GET', '/inventory', {}],
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

  // The slugs as parameters beside the bearer header: all three on add, the org slug on GET /token,
  // the atlas and item slugs on status, update and inventory.
  const bearerOnly = bearer(TOKEN);
  const tp = { 'atlas-slug': 'urlp-param-atlas', 'item-slug': 'urlp-param-item' };
  let r = await call('POST', '/add', { headers: bearerOnly, params: { 'org-slug': ORG, ...tp }, body: BODY });
  assert.equal(r.status, 201, r.json && r.json.error);
  assert.equal(r.json.record['atlas-slug'], 'urlp-param-atlas');
  assert.equal(r.json.record['item-slug'], 'urlp-param-item');
  const pid = r.json.id;
  r = await call('GET', '/status', { headers: read(), params: { ...tp, id: pid } });
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.equal(r.json.record.id, pid);
  r = await call('POST', '/update', { headers: read(), params: tp, body: { id: pid, what: 'changed under the parameters' } });
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.equal(r.json.record.what, 'changed under the parameters');
  r = await call('GET', '/inventory', { headers: read(), params: tp });
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.deepEqual(idsOf(r.json.records), [pid]);
  r = await call('GET', '/token', { headers: read(), params: { 'org-slug': ORG } });
  assert.equal(r.status, 200, r.json && r.json.error);
  r = await call('GET', '/token', { headers: read(), params: { 'org-slug': 'another-org' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'org slug does not match');
});

test('org slug: optional on a token call, refused when it differs; another org is absent', async () => {
  const id = await addOne('org-atlas', 'org-item');
  const h = read('org-atlas', 'org-item');
  const routes = (rid) => [
    ['GET', '/inventory', {}],
    ['GET', '/status', { params: { id: rid } }],
    ['POST', '/update', { body: { id: rid, what: 'changed under the org' } }],
  ];
  for (const [method, path, opts] of routes(id)) {
    for (const extra of [{}, { 'X-Org-Slug': ORG }]) {
      assert.equal((await call(method, path, { ...opts, headers: { ...h, ...extra } })).status, 200, `${method} ${path}`);
    }
    assert.equal((await call(method, path, { ...opts, headers: h, params: { ...opts.params, 'org-slug': ORG } })).status, 200);
    for (const req of [{ headers: { ...h, 'X-Org-Slug': 'another-org' } }, { headers: h, params: { ...opts.params, 'org-slug': 'another-org' } }]) {
      const r = await call(method, path, { ...opts, ...req });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(r.json.error, 'org slug does not match');
    }
  }

  const db = openMain();
  try {
    const own = db.prepare('SELECT id FROM tokens WHERE email = ?').get(HOLDER).id;
    db.prepare(`INSERT INTO externalities
      (id, org, atlas, item, what, who_acts, how_observed, state, set_date, cleared_date, cleared_words, token_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'other-org-1', 'another-org', 'org-atlas', 'org-item', 'not ours', 'someone else', 'elsewhere',
      'open', new Date().toISOString(), null, null, own);
  } finally {
    db.close();
  }
  for (const headers of [read(), h]) {
    const r = await call('GET', '/inventory', { headers });
    assert.equal(r.status, 200);
    assert.ok(!r.json.records.some((rec) => rec.id === 'other-org-1'), 'absent from the inventory');
    assert.ok(r.json.records.every((rec) => rec['org-slug'] === ORG));
  }
  for (const [method, path, opts] of routes('other-org-1').slice(1)) {
    const r = await call(method, path, { ...opts, headers: h });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.json.error, 'unknown id');
  }
});

test('inventory q: a substring of what, who-acts or how-observed, wildcards literal', async () => {
  const item = 'q-item';
  const rec = (what, who = 'someone', how = 'somehow') => ({ 'what': what, 'who-acts': who, 'how-observed': how });
  const qa1 = await addOne('a', item, rec('the Quokka eats'));
  const qa2 = await addOne('a', item, rec('plain', 'a Wombat'));
  const qb1 = await addOne('b', item, rec('plain', 'someone', 'seen by a Platypus'));
  const qb2 = await addOne('b', item, rec('another QUOKKA'));
  const pct = await addOne('a', item, rec('load at 100% now'));
  await addOne('a', item, rec('load at 1000 now'));
  const und = await addOne('b', item, rec('key a_b here'));
  await addOne('b', item, rec('key axb here'));
  const bsl = await addOne('a', item, rec('path a\\b here'));
  await addOne('a', item, rec('path ab here'));
  const other = (await newToken()).token;
  const find = async (token, params, atlas) => {
    const r = await call('GET', '/inventory', { headers: byToken(token, atlas, null), params });
    assert.equal(r.status, 200, JSON.stringify(params));
    return idsOf(r.json.records);
  };

  assert.deepEqual(await find(TOKEN, { q: 'quokka' }), [qa1, qb2].sort(), 'what, any case');
  assert.deepEqual(await find(TOKEN, { q: 'WOMB' }), [qa2], 'who-acts');
  assert.deepEqual(await find(TOKEN, { q: 'tYpU' }), [qb1], 'how-observed');
  assert.deepEqual(await find(other, { q: 'quokka' }), [], "another token's inventory holds none of them");

  const r = await call('POST', '/update', { headers: read('a', item), body: { id: qa1, state: 'cleared', 'cleared-words': 'seen' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await find(TOKEN, { q: 'quokka', state: 'open' }), [qb2]);
  assert.deepEqual(await find(TOKEN, { q: 'quokka', state: 'cleared' }), [qa1]);
  assert.deepEqual(await find(TOKEN, { q: 'quokka' }, 'b'), [qb2]);
  assert.deepEqual(await find(TOKEN, { q: 'quokka' }, 'a'), [qa1]);

  assert.deepEqual(await find(TOKEN, { q: '100%' }), [pct], 'a literal percent sign');
  assert.deepEqual(await find(TOKEN, { q: 'a_b' }), [und], 'a literal underscore');
  assert.deepEqual(await find(TOKEN, { q: 'a\\b' }), [bsl], 'a literal backslash');

  const empty = await call('GET', '/inventory', { headers: read(), params: { q: '' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'q must be a non-empty string');
  const space = await call('GET', `/inventory?q=%20`, { headers: read() });
  assert.equal(space.status, 200, 'a space is matched as sent');
  assert.ok(space.json.records.length > 0);
});

test('the old navigation header alone is refused', async () => {
  const r = await call('POST', '/add', { headers: auth(null, 'i', { 'X-Nav-Slug': 'n' }), body: BODY });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'atlas-slug is required');
  const p = await call('POST', '/add', { headers: auth(null, 'i'), params: { 'nav-slug': 'n' }, body: BODY });
  assert.equal(p.status, 400);
  assert.equal(p.json.error, 'atlas-slug is required');
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
  await listEmail(base, 'toggle@example.org');
  const plain = (await tokenAt(base, 'toggle@example.org')).token;
  const varied = (await tokenAt(base, 'toggle+v@example.org')).token;
  const ids = [];
  for (const token of [plain, varied]) {
    const r = await call('POST', '/add', { headers: byToken(token, 'tg', 'tg-item'), body: BODY });
    assert.equal(r.status, 201, r.json && r.json.error);
    ids.push(r.json.id);
  }
  await activate(base, 'toggle@example.org', false);
  for (const token of [plain, varied]) {
    for (const [method, path, opts] of [['GET', '/token', {}], ['GET', '/inventory', {}], ['POST', '/add', { body: BODY }],
      ['GET', '/status', { params: { id: ids[0] } }]]) {
      const r = await call(method, path, { ...opts, headers: byToken(token, 'tg', 'tg-item') });
      assert.deepEqual(r, { status: 401, json: { error: 'unknown token' } }, `${method} ${path}`);
    }
  }
  for (const email of ['toggle@example.org', 'toggle+v@example.org', 'toggle+new@example.org']) {
    assert.deepEqual(await askAt(base, email), REFUSED, email);
  }
  await activate(base, 'toggle@example.org', true);
  for (const [i, [email, token]] of [['toggle@example.org', plain], ['toggle+v@example.org', varied]].entries()) {
    const inv = await call('GET', '/inventory', { headers: byToken(token) });
    assert.equal(inv.status, 200, email);
    assert.deepEqual(idsOf(inv.json.records), [ids[i]], `${email}: its record is back`);
    const again = await askAt(base, email, {}, bearer(token));
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

const TOKEN_ROUTES = (atlas, item) => [
  ['POST', '/add', { body: BODY }],
  ['POST', '/update', { body: { id: 'x', what: 'x' } }],
  ['GET', '/status', { params: { id: 'x' } }],
  ['GET', '/inventory', {}],
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
  const t = (await newToken()).token;
  const r = await call('POST', '/add', { headers: byToken(t, 'a22', 'a22-item'), body: BODY });
  assert.equal(r.status, 201, r.json && r.json.error);
  const o = await call('GET', '/thirdparty', { headers: bearer(t) });
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

async function tokenRecord(token) {
  const r = await call('GET', '/token', { headers: byToken(token) });
  assert.equal(r.status, 200, r.json && r.json.error);
  return r.json;
}

// Polls GET /token every 50 ms, up to 3 s, until `done` holds: by default, until a delivery has settled.
async function settled(token, done = (t) => t['last-delivery-date'] !== null) {
  for (let i = 0; i < 60; i++) {
    const t = await tokenRecord(token);
    if (done(t)) return t;
    await sleep(50);
  }
  return assert.fail('no delivery settled within 3 s');
}

async function addFull(atlas, item, token) {
  const r = await call('POST', '/add', { headers: byToken(token, atlas, item), body: BODY });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

const assertAddShape = (r) => {
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json).sort(), ['id', 'record']);
  assert.equal(r.json.record.id, r.json.id);
  assert.deepEqual(Object.keys(r.json.record).sort(), [...FIELDS].sort());
  assert.equal(r.json.record.state, 'open');
};

const TOKEN_FIELDS = ['date', 'last-delivery-date', 'last-delivery-status', 'url'];

test("A23: a new record reaches its own token's URL once and no other token's; a token without a URL receives nothing", async () => {
  const rxA = await receiver();
  const rxB = await receiver();
  const a = await newToken(rxA.url);
  const b = await newToken(rxB.url);
  const none = await newToken();
  const added = await addFull('a23', 'a23-item', a.token);
  const outcome = await settled(a.token);
  assert.equal(outcome['last-delivery-status'], 200);
  assert.match(outcome['last-delivery-date'], ISO);
  await sleep(NEGATIVE_WAIT);
  assert.equal(rxA.withId(added.id).length, 1, 'once, to its own token');
  assert.equal(rxA.requests.length, 1);
  assert.equal(rxB.requests.length, 0, "no other token's URL");
  const quiet = await addFull('a23', 'a23-item', none.token);
  await sleep(NEGATIVE_WAIT);
  assert.equal(rxA.withId(quiet.id).length + rxB.withId(quiet.id).length, 0, 'a token without a URL sends nowhere');
  assert.equal(rxA.requests.length + rxB.requests.length, 1);
  for (const t of [b, none]) {
    const rec = await tokenRecord(t.token);
    assert.equal(rec['last-delivery-date'], null);
    assert.equal(rec['last-delivery-status'], null);
  }
});

test('delivery: a token with a URL receives its own add once, JSON, no auth header, the inventory record', async () => {
  const rx = await receiver();
  const atlas = 'dlv-own';
  const item = 'dlv-own-item';
  const t = await newToken(rx.url);
  const added = await addFull(atlas, item, t.token);
  const outcome = await settled(t.token);
  const got = rx.withId(added.id);
  assert.equal(got.length, 1, 'exactly one request with the id');
  assert.ok(String(got[0].headers['content-type']).startsWith('application/json'), got[0].headers['content-type']);
  assert.equal('authorization' in got[0].headers, false, 'no auth header');
  const body = JSON.parse(got[0].body);
  assert.deepEqual(body, added.record, 'the add response record');
  const inv = await call('GET', '/inventory', { headers: byToken(t.token, atlas, item) });
  assert.equal(inv.status, 200);
  const fromInventory = inv.json.records.find((rec) => rec.id === added.id);
  assert.ok(fromInventory, 'inventory lists the record');
  assert.deepEqual(body, fromInventory, 'the inventory record');
  assert.equal(outcome['last-delivery-status'], 200);
  assert.match(outcome['last-delivery-date'], ISO);
});

test('delivery: a token without a URL stays at nulls', async () => {
  const t = await newToken();
  assert.equal(t.url, null);
  await addFull('dlv-no-url', 'dlv-no-url-item', t.token);
  await sleep(NEGATIVE_WAIT);
  const rec = await tokenRecord(t.token);
  assert.equal(rec.url, null);
  assert.equal(rec['last-delivery-date'], null);
  assert.equal(rec['last-delivery-status'], null);
});

test('delivery: a receiver answering 500 stores 500 and is called once', async () => {
  const rx = await receiver(500);
  const t = await newToken(rx.url);
  const added = await addFull('dlv-500', 'dlv-500-item', t.token);
  const outcome = await settled(t.token);
  assert.equal(outcome['last-delivery-status'], 500);
  assert.match(outcome['last-delivery-date'], ISO);
  assert.equal(rx.withId(added.id).length, 1);
  await sleep(NEGATIVE_WAIT);
  assert.equal(rx.withId(added.id).length, 1, 'no retry');
  assert.equal(rx.requests.length, 1);
});

test('delivery: a never-answering receiver stores 0, connected once, the add answering 201 first', async () => {
  const rx = await receiver(null);
  const t = await newToken(rx.url);
  const started = performance.now();
  const r = await call('POST', '/add', { headers: byToken(t.token, 'dlv-silent', 'dlv-silent-item'), body: BODY });
  const elapsed = performance.now() - started;
  assertAddShape(r);
  assert.ok(elapsed < DELIVERY_TIMEOUT, `the add answered in ${Math.round(elapsed)} ms, before the timeout`);
  const outcome = await settled(t.token);
  assert.equal(outcome['last-delivery-status'], 0);
  assert.match(outcome['last-delivery-date'], ISO);
  assert.equal(rx.withId(r.json.id).length, 1, 'one request');
  assert.equal(rx.sockets.size, 1, 'connected once');
});

test('delivery: a closed port stores 0 and the add answers 201 in shape', async () => {
  const t = await newToken(await closedPortUrl());
  const r = await call('POST', '/add', { headers: byToken(t.token, 'dlv-closed', 'dlv-closed-item'), body: BODY });
  assertAddShape(r);
  const outcome = await settled(t.token);
  assert.equal(outcome['last-delivery-status'], 0);
  assert.match(outcome['last-delivery-date'], ISO);
});

test('delivery: an update is not re-sent', async () => {
  const rx = await receiver();
  const atlas = 'dlv-update';
  const item = 'dlv-update-item';
  const t = await newToken(rx.url);
  const added = await addFull(atlas, item, t.token);
  await settled(t.token);
  assert.equal(rx.withId(added.id).length, 1);
  const u = await call('POST', '/update', { headers: byToken(t.token, atlas, item), body: { id: added.id, what: 'changed after the delivery' } });
  assert.equal(u.status, 200, u.json && u.json.error);
  assert.equal(u.json.record.what, 'changed after the delivery');
  await sleep(NEGATIVE_WAIT);
  assert.equal(rx.withId(added.id).length, 1, 'the update was not re-sent');
  assert.equal(rx.requests.length, 1);
});

test('delivery: a second add overwrites the outcome', async () => {
  const rx = await receiver(200);
  const t = await newToken(rx.url);
  const first = await addFull('dlv-overwrite', 'dlv-overwrite-item', t.token);
  const one = await settled(t.token);
  assert.equal(one['last-delivery-status'], 200);
  rx.status = 500;
  const second = await addFull('dlv-overwrite', 'dlv-overwrite-item', t.token);
  const two = await settled(t.token, (x) => x['last-delivery-status'] === 500);
  assert.equal(two['last-delivery-status'], 500);
  assert.match(two['last-delivery-date'], ISO);
  assert.ok(two['last-delivery-date'] >= one['last-delivery-date'], 'the later attempt dated no earlier');
  assert.equal(rx.withId(first.id).length, 1);
  assert.equal(rx.withId(second.id).length, 1);
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
  assert.deepEqual(Object.keys(await post(notice('feature/on', 'open'))), ['id']);
  assert.equal((await statusOf('feature/on')).length, 1);
  assert.equal((await at('GET', '/', { headers: {} })).status, 200);
  assert.deepEqual(await at('GET', '/inventory', { headers: {} }), { status: 401, json: { error: 'token is required' } });
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
    assert.deepEqual(Object.keys(r), ['id']);
    assert.match(r.id, UUID);
  }
  assert.notEqual(one.id, two.id);
  const own = partTokenId();
  const db = new DatabaseSync(join(partDir, 'externalities.sqlite'));
  try {
    const columns = db.prepare('PRAGMA table_info(notices)').all().map((c) => c.name);
    assert.deepEqual(columns, ['id', 'item', 'state', 'what', 'body', 'received', 'token_id']);
    const rows = db.prepare('SELECT * FROM notices WHERE item = ?').all(item);
    assert.deepEqual(rows.map((r) => r.id).sort(), [one.id, two.id].sort());
    for (const row of rows) {
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

test('status: a record added by POST /add stays on inventory and is in no status read', async () => {
  const item = 'feature/old-kind';
  const r = await at('POST', '/add', { headers: byToken(PART_TOKEN, 'none', item), body: BODY });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(await statusOf(item), []);
  const inv = await at('GET', '/inventory', { headers: byToken(PART_TOKEN, 'none', item) });
  assert.equal(inv.status, 200);
  assert.deepEqual(inv.json.records.map((rec) => rec.id), [r.json.id]);
});

test('notify: a notice reaches no token address', async () => {
  const rx = await receiver();
  const t = await tokenAt(partBase, 'holder+rx@example.org', { url: rx.url });
  const added = await at('POST', '/add', { headers: byToken(t.token, 'none', 'feature/no-delivery'), body: BODY });
  assert.equal(added.status, 201);
  for (let i = 0; i < 60 && rx.requests.length === 0; i++) await sleep(50);
  assert.equal(rx.withId(added.json.id).length, 1, 'positive control: the add was delivered');
  const kept = await at('POST', `/${PART}/notify`, { headers: bearer(t.token), body: notice('feature/no-delivery', 'open') });
  assert.equal(kept.status, 201);
  await sleep(NEGATIVE_WAIT);
  assert.equal(rx.requests.length, 1, 'the notice was not delivered');
  assert.equal(rx.withId(kept.json.id).length, 0);
});

test("A24: an authorized address's token and its variation's each add a record and send a notice; neither reads, lists or changes the other's", async () => {
  await listEmail(partBase, 'pair@example.org');
  const p = (await tokenAt(partBase, 'pair@example.org')).token;
  const v = (await tokenAt(partBase, 'pair+v@example.org')).token;
  const atlas = 'a24';
  const item = 'feature/a24';
  const ids = {};
  const notices = {};
  for (const [name, token] of [['p', p], ['v', v]]) {
    const r = await at('POST', '/add', { headers: byToken(token, atlas, item), body: { ...BODY, what: `made by ${name}` } });
    assert.equal(r.status, 201, r.json && r.json.error);
    ids[name] = r.json.id;
    notices[name] = notice(item, 'open', { what: `sent by ${name}` });
    assert.equal((await at('POST', `/${PART}/notify`, { headers: bearer(token), body: notices[name] })).status, 201);
  }
  for (const [mine, other, token] of [['p', 'v', p], ['v', 'p', v]]) {
    const h = byToken(token, atlas, item);
    const inv = await at('GET', '/inventory', { headers: byToken(token) });
    assert.deepEqual(idsOf(inv.json.records), [ids[mine]], `${mine} lists its own only`);
    assert.deepEqual(await at('GET', '/status', { headers: h, params: { id: ids[other] } }), { status: 404, json: { error: 'unknown id' } }, `${mine} reads`);
    assert.deepEqual(await at('POST', '/update', { headers: h, body: { id: ids[other], what: 'changed by the other' } }),
      { status: 404, json: { error: 'unknown id' } }, `${mine} changes`);
    assert.deepEqual((await at('GET', statusPath(item), { headers: bearer(token) })).json, [notices[mine]], `${mine} reads its own notices only`);
    const own = await at('GET', '/status', { headers: h, params: { id: ids[mine] } });
    assert.equal(own.json.record.what, `made by ${mine}`, `${mine}'s record unchanged`);
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

test('thirdparty: a notice with an address reaches no token address', async () => {
  const third = await receiver();
  const tokenRx = await receiver();
  const s = await tpServer('127.0.0.1');
  try {
    const t = await tokenAt(s.base, 'holder+rx@example.org', { url: tokenRx.url });
    const added = await s.req('POST', '/add', { headers: byToken(t.token, 'none', 'feature/tp-token'), raw: JSON.stringify(BODY) });
    assert.equal(added.status, 201);
    for (let i = 0; i < 60 && tokenRx.requests.length === 0; i++) await sleep(50);
    assert.equal(tokenRx.withId(added.json.id).length, 1, 'positive control: the add was delivered');
    assert.equal((await s.notify(tpNotice('feature/tp-token', 'open', third.url), bearer(t.token))).status, 201);
    await tpSettled(s);
    await sleep(NEGATIVE_WAIT);
    assert.equal(third.requests.length, 1, 'the third party got the notice');
    assert.equal(tokenRx.requests.length, 1, 'the token address got nothing more');
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
    assert.deepEqual(fks('externalities'), [['token_id', 'tokens', 'id']]);
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
    for (const table of ['externalities', 'notices']) {
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
  const added = await addFull('an-atlas-not-named', 'a26-item', token);
  const inv = await call('GET', '/inventory', { headers: byToken(token) });
  assert.deepEqual(idsOf(inv.json.records), [added.id], 'records are the token\'s, under any atlas');
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
    assert.deepEqual(s.lines, [DROPPED], 'one line naming the three tables');
    const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
    try {
      for (const table of ['externalities', 'notices', 'tokens', 'authorized_emails']) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} is empty`);
      }
      assert.ok(!db.prepare('PRAGMA table_info(tokens)').all().some((c) => c.name === 'scope'), 'tokens made new');
      for (const table of ['externalities', 'notices']) {
        assert.ok(db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'token_id'), `${table} made new`);
      }
      assert.deepEqual({ ...db.prepare('SELECT * FROM thirdparty').get() },
        { id: 1, last_delivery_date: '2026-11-01T00:00:00.000Z', last_delivery_status: 204 }, 'the third-party outcome is kept');
    } finally {
      db.close();
    }
    assert.deepEqual(await request(s.base, 'GET', '/inventory', { headers: bearer('old-token-value-0123456789') }),
      { status: 401, json: { error: 'unknown token' } }, 'the old token opens nothing');
    await listEmail(s.base, HOLDER);
    const token = (await tokenAt(s.base, HOLDER)).token;
    assert.deepEqual((await request(s.base, 'GET', '/thirdparty', { headers: bearer(token) })).json,
      { 'last-delivery-date': '2026-11-01T00:00:00.000Z', 'last-delivery-status': 204 });
    assert.deepEqual((await request(s.base, 'GET', '/inventory', { headers: bearer(token) })).json, { records: [] });
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
  let s = await startOn(dir);
  let token;
  let id;
  try {
    assert.deepEqual(s.lines, [DROPPED], 'the one line, once');
    const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
    try {
      for (const table of ['externalities', 'notices', 'tokens']) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} is empty`);
      }
      for (const table of ['externalities', 'notices']) {
        assert.ok(db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'token_id'), `${table} made new`);
      }
      assert.equal(db.prepare('SELECT last_delivery_status AS s FROM thirdparty').get().s, 202, 'the third-party outcome is kept');
    } finally {
      db.close();
    }
    await listEmail(s.base, HOLDER);
    token = (await tokenAt(s.base, HOLDER)).token;
    const r = await request(s.base, 'POST', '/add', { headers: byToken(token, 'between', 'between-item'), body: BODY });
    assert.equal(r.status, 201, r.json && r.json.error);
    id = r.json.id;
  } finally {
    await s.close();
  }
  s = await startOn(dir);
  try {
    assert.deepEqual(s.lines, [], 'a second open drops nothing');
    const inv = await request(s.base, 'GET', '/inventory', { headers: byToken(token) });
    assert.equal(inv.status, 200);
    assert.deepEqual(idsOf(inv.json.records), [id], 'the record made in between is kept');
    assert.deepEqual((await request(s.base, 'GET', '/thirdparty', { headers: bearer(token) })).json,
      { 'last-delivery-date': '2026-11-02T00:00:00.000Z', 'last-delivery-status': 202 });
  } finally {
    await s.close();
  }
});

test('A28: records made after that survive a restart', async () => {
  const dir = mkdtempSync(join(dataDir, 'old-'));
  oldDatabase(dir);
  let s = await startOn(dir);
  let token;
  let id;
  try {
    assert.deepEqual(s.lines, [DROPPED]);
    await listEmail(s.base, HOLDER);
    token = (await tokenAt(s.base, HOLDER)).token;
    const r = await request(s.base, 'POST', '/add', { headers: byToken(token, 'after', 'after-item'), body: BODY });
    assert.equal(r.status, 201, r.json && r.json.error);
    id = r.json.id;
  } finally {
    await s.close();
  }
  s = await startOn(dir);
  try {
    assert.deepEqual(s.lines, [], 'a later start drops nothing');
    const inv = await request(s.base, 'GET', '/inventory', { headers: byToken(token) });
    assert.equal(inv.status, 200, 'the token survives the restart');
    assert.deepEqual(idsOf(inv.json.records), [id], 'the record survives the restart');
    const st = await request(s.base, 'GET', '/status', { headers: byToken(token, 'after', 'after-item'), params: { id } });
    assert.equal(st.json.record.what, BODY.what);
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
  const url = 'https://example.org/recall-a3';
  await listEmail(partBase, email);
  const t = (await tokenAt(partBase, email, { url })).token;
  const added = await request(partBase, 'POST', '/add', { headers: byToken(t, 'rc3', 'rc3-item'), body: BODY });
  assert.equal(added.status, 201, added.json && added.json.error);
  const item = 'feature/recall-a3';
  assert.equal((await at('POST', `/${PART}/notify`, { headers: bearer(t), body: notice(item, 'open') })).status, 201);
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
  const inv = await request(partBase, 'GET', '/inventory', { headers: bearer(t) });
  assert.deepEqual(idsOf(inv.json.records), [added.json.id], 'the record stands');
  const st = await at('GET', statusPath(item), { headers: bearer(t) });
  assert.deepEqual(st, { status: 200, json: [notice(item, 'open')] }, 'the notice stands');
});

test('re-call A4: a later ask with the current token answers 200 with three fields, a different token and that token\'s date', async () => {
  const email = 'recall-a4@example.org';
  await listEmail(base, email);
  const first = await tokenAt(base, email);
  const r = await askAt(base, email, {}, bearer(first.token));
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.deepEqual(Object.keys(r.json), ['token', 'url', 'date']);
  assert.ok(r.json.token !== first.token, 'a different token');
  assert.ok(BASE64URL_32_BYTES.test(r.json.token), 'the new token is 32 bytes as base64url');
  assert.match(r.json.date, ISO);
  assert.ok(r.json.date >= first.date, 'dated no earlier than the first');
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
  const email = 'recall-a6@example.org';
  await listEmail(partBase, email);
  const rx = await receiver();
  const old = (await tokenAt(partBase, email, { url: rx.url })).token;
  const added = await request(partBase, 'POST', '/add', { headers: byToken(old, 'rc6', 'rc6-item'), body: BODY });
  assert.equal(added.status, 201, added.json && added.json.error);
  let outcome;
  for (let i = 0; i < 60; i++) {
    outcome = (await request(partBase, 'GET', '/token', { headers: bearer(old) })).json;
    if (outcome['last-delivery-date'] !== null) break;
    await sleep(50);
  }
  assert.equal(outcome['last-delivery-status'], 200, 'the delivery settled');
  const item = 'feature/recall-a6';
  assert.equal((await at('POST', `/${PART}/notify`, { headers: bearer(old), body: notice(item, 'open') })).status, 201);
  const r = await askAt(partBase, email, {}, bearer(old));
  assert.equal(r.status, 200, r.json && r.json.error);
  const fresh = r.json.token;
  assert.equal(r.json.url, rx.url, 'the answer carries the kept URL');
  const info = await request(partBase, 'GET', '/token', { headers: bearer(fresh) });
  assert.equal(info.status, 200);
  assert.equal(info.json.url, rx.url, 'the URL');
  assert.equal(info.json['last-delivery-date'], outcome['last-delivery-date'], 'the delivery date');
  assert.equal(info.json['last-delivery-status'], outcome['last-delivery-status'], 'the delivery status');
  const inv = await request(partBase, 'GET', '/inventory', { headers: bearer(fresh) });
  assert.deepEqual(idsOf(inv.json.records), [added.json.id], 'the record');
  const st = await request(partBase, 'GET', '/status', { headers: byToken(fresh, 'rc6', 'rc6-item'), params: { id: added.json.id } });
  assert.equal(st.status, 200, 'the record by its id');
  assert.deepEqual(await at('GET', statusPath(item), { headers: bearer(fresh) }), { status: 200, json: [notice(item, 'open')] }, 'the notice');
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

test('re-call A12: a database made and filled in the shape main makes opens with every row kept and no dropped line', async () => {
  const dir = mkdtempSync(join(dataDir, 'recall-'));
  const held = randomBytes(32).toString('base64url');
  const made = new DatabaseSync(join(dir, 'externalities.sqlite'));
  try {
    // The tables exactly as src/db.js on main makes them; this change adds no table and no column.
    made.exec(`CREATE TABLE authorized_emails (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1)`);
    made.exec(`CREATE TABLE tokens (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
      authorized_email INTEGER NOT NULL REFERENCES authorized_emails(id), url TEXT, date TEXT NOT NULL,
      last_delivery_date TEXT, last_delivery_status INTEGER)`);
    made.exec(`CREATE TABLE externalities (
      id TEXT PRIMARY KEY, org TEXT, atlas TEXT, item TEXT, what TEXT,
      who_acts TEXT, how_observed TEXT, state TEXT, set_date TEXT,
      cleared_date TEXT, cleared_words TEXT, token_id INTEGER NOT NULL REFERENCES tokens(id))`);
    made.exec(`CREATE TABLE notices (id TEXT PRIMARY KEY, item TEXT, state TEXT, what TEXT, body TEXT, received TEXT,
      token_id INTEGER NOT NULL REFERENCES tokens(id))`);
    made.exec('CREATE TABLE thirdparty (id INTEGER PRIMARY KEY CHECK (id = 1), last_delivery_date TEXT, last_delivery_status INTEGER)');
    made.prepare('INSERT INTO authorized_emails (id, email, active) VALUES (1, ?, 1)').run(HOLDER);
    made.prepare('INSERT INTO tokens (id, email, token, authorized_email, url, date, last_delivery_date, last_delivery_status) VALUES (1, ?, ?, 1, ?, ?, ?, ?)')
      .run(HOLDER, held, 'https://example.org/kept', '2026-11-18T10:00:00.000Z', '2026-11-18T10:05:00.000Z', 200);
    made.prepare(`INSERT INTO externalities (id, org, atlas, item, what, who_acts, how_observed, state, set_date, cleared_date, cleared_words, token_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run('kept-1', ORG, 'kept-atlas', 'kept-item', 'kept before', 'someone', 'somehow', 'open',
      '2026-11-18T10:01:00.000Z', null, null);
    made.prepare('INSERT INTO notices (id, item, state, what, body, received, token_id) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run('kept-n1', 'feature/kept', 'open', 'w', '{"item":"feature/kept","state":"open","what":"w"}', '2026-11-18T10:02:00.000Z');
    made.prepare('INSERT INTO thirdparty (id, last_delivery_date, last_delivery_status) VALUES (1, ?, ?)').run('2026-11-18T10:03:00.000Z', 204);
  } finally {
    made.close();
  }
  const TABLES = ['authorized_emails', 'tokens', 'externalities', 'notices', 'thirdparty'];
  const rows = () => {
    const db = new DatabaseSync(join(dir, 'externalities.sqlite'));
    try {
      return Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map((r) => ({ ...r }))]));
    } finally {
      db.close();
    }
  };
  const before = rows();
  const s = await startOn(dir);
  try {
    assert.deepEqual(s.lines, [], 'no dropped line');
    assert.deepEqual(rows(), before, 'every row kept');
    const inv = await request(s.base, 'GET', '/inventory', { headers: bearer(held) });
    assert.equal(inv.status, 200, 'the token held from before opens a token route');
    assert.deepEqual(idsOf(inv.json.records), ['kept-1']);
    const r = await askAt(s.base, HOLDER, {}, bearer(held));
    assert.equal(r.status, 200, 'the held token renews');
    assert.equal(r.json.url, 'https://example.org/kept', 'its URL kept');
    const again = await request(s.base, 'GET', '/inventory', { headers: bearer(r.json.token) });
    assert.deepEqual(idsOf(again.json.records), ['kept-1'], 'the record passes to the new token');
  } finally {
    await s.close();
  }
});
