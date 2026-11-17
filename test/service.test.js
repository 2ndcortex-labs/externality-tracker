import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createServer } from '../src/server.js';
import { timeoutMs } from '../src/deliver.js';
import { loadAddressKey } from '../src/auth.js';
import { networkInterfaces } from 'node:os';
import { parseAllow, resolveTarget, postOnce, refusedList } from '../src/thirdparty.js';

const ORG = 'test-org';
const KEY = 'test-key-0123456789';
const FIELDS = ['id', 'org-slug', 'atlas-slug', 'item-slug', 'what', 'who-acts', 'how-observed',
  'state', 'set-date', 'cleared-date', 'cleared-words'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELIVERY_TIMEOUT = 400; // the test server's DELIVERY_TIMEOUT_MS
const NEGATIVE_WAIT = DELIVERY_TIMEOUT + 300; // a wait for nothing to arrive: the timeout and a margin

let server;
let base;
let dataDir;
let TOKEN; // a token of scope `all`, never printed

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'externality-tracker-'));
  server = createServer({ ORG_SLUG: ORG, EXTERNALITY_KEY: KEY, DATA_DIR: dataDir, DELIVERY_TIMEOUT_MS: String(DELIVERY_TIMEOUT) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  TOKEN = (await mintToken('all')).token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { headers = {}, params = {}, body, raw } = {}) {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  if (init.body !== undefined) init.headers['content-type'] = 'application/json';
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const auth = (atlas, item, extra = {}) => ({
  'X-Org-Slug': ORG, 'Authorization': `Bearer ${KEY}`,
  ...(atlas ? { 'X-Atlas-Slug': atlas } : {}), ...(item ? { 'X-Item-Slug': item } : {}), ...extra,
});

// A consumer-token call: the token and the slugs, no org key.
const byToken = (token, atlas, item, extra = {}) => ({
  'X-Consumer-Token': token,
  ...(atlas ? { 'X-Atlas-Slug': atlas } : {}), ...(item ? { 'X-Item-Slug': item } : {}), ...extra,
});
const read = (atlas, item, extra) => byToken(TOKEN, atlas, item, extra);

const BODY = { 'what': 'a thing is true', 'who-acts': 'the operator', 'how-observed': 'by a check' };

async function addOne(atlas, item, body = BODY) {
  const r = await call('POST', '/add', { headers: auth(atlas, item), body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

// Mints through the endpoint under the org key; the failure message carries the reason only, never a token.
async function mintToken(scope, url) {
  const body = url === undefined ? { scope } : { scope, url };
  const r = await call('POST', '/tokens', { headers: auth(), body });
  assert.equal(r.status, 201, r.json && r.json.error);
  return r.json;
}

const idsOf = (recs) => recs.map((r) => r.id).sort();

test('GET / answers without a key', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['node', 'ok', 'service', 'started']);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.service, 'externality-tracker');
  assert.equal(r.json.node, process.version);
  assert.match(r.json.started, ISO);
});

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

// The key is read by add and /tokens only, from `Authorization: Bearer <key>`; no assertion message carries it.
test('bearer: the scheme case-insensitively, the key trimmed; another scheme, an empty value, the old header and the parameter are missing', async () => {
  const s = { 'X-Org-Slug': ORG, 'X-Atlas-Slug': 'bearer-atlas', 'X-Item-Slug': 'bearer-item' };
  for (const [path, body] of [['/add', BODY], ['/tokens', { scope: 'bearer-atlas' }]]) {
    for (const [label, headers] of [
      ['Bearer <key>', { ...s, 'Authorization': `Bearer ${KEY}` }],
      ['BEARER, two spaces, a trailing space', { ...s, 'authorization': `BEARER  ${KEY} ` }],
    ]) {
      const r = await call('POST', path, { headers, body });
      assert.equal(r.status, 201, `${path} ${label}: ${r.json && r.json.error}`);
    }
    for (const [label, headers, params, reason] of [
      ['another scheme', { ...s, 'Authorization': `Basic ${KEY}` }, {}, 'missing externality key'],
      ['the scheme alone', { ...s, 'Authorization': 'Bearer' }, {}, 'missing externality key'],
      ['the scheme and a space', { ...s, 'Authorization': 'Bearer ' }, {}, 'missing externality key'],
      ['a tab after the scheme', { ...s, 'Authorization': `Bearer\t${KEY}` }, {}, 'missing externality key'],
      ['the old header', { ...s, 'X-Externality-Key': KEY }, {}, 'missing externality key'],
      ['the parameter', s, { 'externality-key': KEY }, 'missing externality key'],
      ['a wrong key', { ...s, 'Authorization': 'Bearer wrong' }, {}, 'wrong externality key'],
      ['another org', { ...s, 'X-Org-Slug': 'other', 'Authorization': `Bearer ${KEY}` }, {}, 'org slug does not match the key'],
    ]) {
      const r = await call('POST', path, { headers, params, body });
      assert.equal(r.status, 401, `${path} ${label}`);
      assert.equal(r.json.error, reason, `${path} ${label}`);
    }
  }
});

for (const [name, header, param, field] of [
  ['atlas-slug', 'X-Atlas-Slug', 'atlas-slug', 'atlas-slug'],
  ['item-slug', 'X-Item-Slug', 'item-slug', 'item-slug'],
]) {
  test(`precedence: ${name} from header, param, header wins`, async () => {
    const other = name === 'atlas-slug' ? { 'X-Item-Slug': 'prec-item' } : { 'X-Atlas-Slug': 'prec-atlas' };
    const base = { 'X-Org-Slug': ORG, 'Authorization': `Bearer ${KEY}`, ...other };
    let r = await call('POST', '/add', { headers: { ...base, [header]: 'from-header' }, body: BODY });
    assert.equal(r.json.record[field], 'from-header');
    r = await call('POST', '/add', { headers: base, params: { [param]: 'from-param' }, body: BODY });
    assert.equal(r.json.record[field], 'from-param');
    r = await call('POST', '/add', { headers: { ...base, [header]: 'from-header' }, params: { [param]: 'from-param' }, body: BODY });
    assert.equal(r.status, 201);
    assert.equal(r.json.record[field], 'from-header');
  });
}

test('auth: wrong key, missing key, other org are 401 with a reason', async () => {
  for (const headers of [
    { 'X-Org-Slug': ORG, 'Authorization': 'Bearer wrong' },
    { 'X-Org-Slug': ORG },
    { 'X-Org-Slug': 'another-org', 'Authorization': `Bearer ${KEY}` },
  ]) {
    for (const [method, path, body] of [['GET', '/inventory'], ['POST', '/add', BODY], ['GET', '/status'],
      ['POST', '/update', { id: 'x', what: 'x' }], ['POST', '/tokens', { scope: 'all' }]]) {
      const r = await call(method, path, { headers: { ...headers, 'X-Atlas-Slug': 'n', 'X-Item-Slug': 'i' }, body });
      assert.equal(r.status, 401);
      assert.equal(typeof r.json.error, 'string');
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
  for (const path of ['/', '/add', '/update', '/status', '/inventory', '/elsewhere']) {
    r = await call('DELETE', path, { headers: auth('n', 'i') });
    assert.equal(r.status, 404, `DELETE ${path}`);
    assert.equal(typeof r.json.error, 'string');
  }
  for (const [method, path] of [['GET', '/elsewhere'], ['GET', '/add'], ['POST', '/status'], ['PUT', '/update'], ['POST', '/']]) {
    assert.equal((await call(method, path, { headers: auth('n', 'i') })).status, 404, `${method} ${path}`);
  }
});

test('the server refuses to start with EXTERNALITY_KEY or ORG_SLUG unset', () => {
  for (const env of [{ ORG_SLUG: 'x', EXTERNALITY_KEY: '' }, { ORG_SLUG: '', EXTERNALITY_KEY: 'k' }]) {
    const r = spawnSync(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...env, DATA_DIR: dataDir, PORT: '0' },
      timeout: 10000,
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, null, 'exited on its own');
    assert.match(r.stderr, /refusing to start/);
  }
});

// The consumer token: minted under the org key, read by status, update and inventory within its scope.
// No assertion message below carries a token.

const SCOPE_REASON = 'scope must be all or a comma-delineated list of atlas slugs';
const URL_REASON = 'url must be an absolute http or https URL';
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

test('tokens: a mint answers 201 with the token, the normalised scope, the url and the date', async () => {
  const t = await mintToken('all');
  assert.deepEqual(Object.keys(t), ['token', 'scope', 'url', 'date']);
  assert.ok(BASE64URL_32_BYTES.test(t.token), 'the token is 32 bytes as base64url');
  assert.ok(t.token !== TOKEN, 'each mint is a new token');
  assert.equal(t.scope, 'all');
  assert.equal(t.url, null);
  assert.match(t.date, ISO);
  assert.ok(t.date.endsWith('Z') && !Number.isNaN(Date.parse(t.date)), 'the date is ISO 8601 UTC');
  for (const scope of [' all ', 'all,all']) assert.equal((await mintToken(scope)).scope, 'all', scope);
  assert.equal((await mintToken('All')).scope, 'All');
  assert.equal((await mintToken('a', null)).url, null);
  const hook = 'http://127.0.0.1:1/hook?x=1&y=two';
  const withUrl = await mintToken(' b, a ,a', hook);
  assert.equal(withUrl.scope, 'b,a');
  assert.equal(withUrl.url, hook);
  assert.equal((await mintToken('none', 'http://127.0.0.1:1/in')).url, 'http://127.0.0.1:1/in');

  const db = new DatabaseSync(join(dataDir, 'externalities.sqlite'));
  try {
    const columns = db.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name);
    assert.deepEqual(columns, ['token', 'scope', 'url', 'date', 'last_delivery_date', 'last_delivery_status']);
    const row = db.prepare('SELECT * FROM tokens').all().find((r) => r.token === withUrl.token);
    assert.ok(row, 'the stored row holds the token as returned');
    assert.equal(row.scope, 'b,a');
    assert.equal(row.url, hook);
    assert.equal(row.date, withUrl.date);
    assert.equal(row.last_delivery_date, null);
    assert.equal(row.last_delivery_status, null);
  } finally {
    db.close();
  }
});

test('tokens: a bad body, scope or url answers 400 with its reason', async () => {
  const mint = (opts) => call('POST', '/tokens', { headers: auth(), ...opts });
  for (const body of [{}, { scope: '' }, { scope: 'all,a' }, { scope: 'a,,b' }, { scope: ' , ' }, { scope: 42 },
    { scope: ['a'] }, { url: 'https://example.com' }]) {
    const r = await mint({ body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, SCOPE_REASON);
  }
  for (const url of ['ftp://x', 'not a url', 42, '', '/relative', { href: 'https://example.com' }]) {
    const r = await mint({ body: { scope: 'all', url } });
    assert.equal(r.status, 400, JSON.stringify(url));
    assert.equal(r.json.error, URL_REASON);
  }
  let r = await mint({ body: [1] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'body must be a JSON object');
  r = await mint({ raw: '{not json' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'body is not valid JSON');
});

test('auth: status, update and inventory read the token; add and tokens read the key', async () => {
  const id = await addOne('cred-atlas', 'cred-item');
  const slugs = { 'X-Atlas-Slug': 'cred-atlas', 'X-Item-Slug': 'cred-item' };
  const unknown = byToken('not-a-token', 'cred-atlas', 'cred-item');
  for (const [method, path, opts] of [
    ['GET', '/status', { params: { id } }],
    ['POST', '/update', { body: { id, what: 'changed by a token' } }],
    ['GET', '/inventory', {}],
  ]) {
    const at = `${method} ${path}`;
    for (const headers of [slugs, { ...slugs, 'X-Org-Slug': ORG }, { ...slugs, 'X-Org-Slug': ORG, 'Authorization': `Bearer ${KEY}` }]) {
      const r = await call(method, path, { ...opts, headers });
      assert.equal(r.status, 401, at);
      assert.equal(r.json.error, 'consumer token is required', at);
    }
    for (const headers of [unknown, byToken(KEY, 'cred-atlas', 'cred-item')]) {
      const r = await call(method, path, { ...opts, headers });
      assert.equal(r.status, 401, at);
      assert.equal(r.json.error, 'unknown consumer token', at);
    }
    let r = await call(method, path, { ...opts, headers: read('cred-atlas', 'cred-item') });
    assert.equal(r.status, 200, `${at} by header`);
    r = await call(method, path, { ...opts, headers: slugs, params: { ...opts.params, 'consumer-token': TOKEN } });
    assert.equal(r.status, 401, `${at} by parameter`);
    assert.equal(r.json.error, 'consumer token is required', `${at} by parameter`);
    r = await call(method, path, { ...opts, headers: read('cred-atlas', 'cred-item'), params: { ...opts.params, 'consumer-token': 'not-a-token' } });
    assert.equal(r.status, 200, `${at}: the header wins`);
    r = await call(method, path, { ...opts, headers: unknown, params: { ...opts.params, 'consumer-token': TOKEN } });
    assert.equal(r.status, 401, `${at}: the header wins`);
    assert.equal(r.json.error, 'unknown consumer token', at);
  }
  for (const [path, body] of [['/add', BODY], ['/tokens', { scope: 'all' }]]) {
    for (const [headers, reason] of [
      [read('cred-atlas', 'cred-item'), 'missing externality key'],
      [read('cred-atlas', 'cred-item', { 'X-Org-Slug': ORG }), 'missing externality key'],
      [slugs, 'missing externality key'],
      [{ ...slugs, 'X-Org-Slug': ORG, 'Authorization': 'Bearer wrong' }, 'wrong externality key'],
      [{ ...slugs, 'X-Org-Slug': 'another-org', 'Authorization': `Bearer ${KEY}` }, 'org slug does not match the key'],
    ]) {
      const r = await call('POST', path, { headers, body });
      assert.equal(r.status, 401, `${path}: ${reason}`);
      assert.equal(r.json.error, reason, path);
    }
  }
});

test("url parameters: externality-key and consumer-token are not read, the slugs' parameters still are", async () => {
  const id = await addOne('urlp-atlas', 'urlp-item');
  const slugs = { 'X-Org-Slug': ORG, 'X-Atlas-Slug': 'urlp-atlas', 'X-Item-Slug': 'urlp-item' };
  const key = { 'externality-key': KEY };
  const token = { 'consumer-token': TOKEN };
  for (const [method, path, opts, reason] of [
    ['POST', '/add', { body: BODY }, 'missing externality key'],
    ['POST', '/tokens', { body: { scope: 'urlp-atlas' } }, 'missing externality key'],
    ['GET', '/status', { params: { id } }, 'consumer token is required'],
    ['POST', '/update', { body: { id, what: 'changed by a parameter' } }, 'consumer token is required'],
    ['GET', '/inventory', {}, 'consumer token is required'],
    ['GET', '/token', {}, 'consumer token is required'],
  ]) {
    for (const [label, p] of [['externality-key', key], ['consumer-token', token], ['both', { ...key, ...token }]]) {
      const r = await call(method, path, { ...opts, headers: slugs, params: { ...opts.params, ...p } });
      assert.equal(r.status, 401, `${method} ${path} by ${label}`);
      assert.equal(r.json.error, reason, `${method} ${path} by ${label}`);
    }
  }

  // The slugs as parameters beside the accepted headers: all three on add, the org slug on tokens and GET /token,
  // the atlas and item slugs on status, update and inventory.
  const bearerOnly = { 'Authorization': `Bearer ${KEY}` };
  const tp = { 'atlas-slug': 'urlp-param-atlas', 'item-slug': 'urlp-param-item' };
  let r = await call('POST', '/add', { headers: bearerOnly, params: { 'org-slug': ORG, ...tp }, body: BODY });
  assert.equal(r.status, 201, r.json && r.json.error);
  assert.equal(r.json.record['atlas-slug'], 'urlp-param-atlas');
  assert.equal(r.json.record['item-slug'], 'urlp-param-item');
  const pid = r.json.id;
  r = await call('POST', '/tokens', { headers: bearerOnly, params: { 'org-slug': ORG }, body: { scope: 'urlp-param-atlas' } });
  assert.equal(r.status, 201, r.json && r.json.error);
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

  const db = new DatabaseSync(join(dataDir, 'externalities.sqlite'));
  try {
    db.prepare(`INSERT INTO externalities
      (id, org, atlas, item, what, who_acts, how_observed, state, set_date, cleared_date, cleared_words)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'other-org-1', 'another-org', 'org-atlas', 'org-item', 'not ours', 'someone else', 'elsewhere',
      'open', new Date().toISOString(), null, null);
  } finally {
    db.close();
  }
  for (const headers of [read(), h]) {
    const r = await call('GET', '/inventory', { headers });
    assert.equal(r.status, 200);
    assert.ok(!r.json.records.some((rec) => rec.id === 'other-org-1'), 'absent from a scope-all inventory');
    assert.ok(r.json.records.every((rec) => rec['org-slug'] === ORG));
  }
  for (const [method, path, opts] of routes('other-org-1').slice(1)) {
    const r = await call(method, path, { ...opts, headers: h });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.json.error, 'unknown id');
  }
});

test('scope: a token sees and changes only the atlases it names', async () => {
  const item = 'scope-item';
  const ida = await addOne('a', item);
  const idb = await addOne('b', item);
  const idn = await addOne('none', item);
  const tokA = (await mintToken('a')).token;
  const tokAN = (await mintToken('a,none')).token;

  let r = await call('GET', '/status', { headers: byToken(tokA, 'a', item), params: { id: ida } });
  assert.equal(r.status, 200);
  assert.equal(r.json.record.id, ida);
  r = await call('POST', '/update', { headers: byToken(tokA, 'a', item), body: { id: ida, what: 'changed within scope' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.record.what, 'changed within scope');
  for (const [atlas, id] of [['b', idb], ['none', idn]]) {
    r = await call('GET', '/status', { headers: byToken(tokA, atlas, item), params: { id } });
    assert.equal(r.status, 404, `status under ${atlas}`);
    assert.equal(r.json.error, 'unknown id');
    r = await call('POST', '/update', { headers: byToken(tokA, atlas, item), body: { id, what: 'out of scope' } });
    assert.equal(r.status, 404, `update under ${atlas}`);
    assert.equal(r.json.error, 'unknown id');
  }
  r = await call('GET', '/status', { headers: byToken(tokAN, 'none', item), params: { id: idn } });
  assert.equal(r.status, 200, 'none in a scope sees records under none');

  const list = async (token, atlas, itm) => {
    const res = await call('GET', '/inventory', { headers: byToken(token, atlas, itm) });
    assert.equal(res.status, 200);
    return res.json.records;
  };
  const onlyA = await list(tokA);
  assert.ok(onlyA.some((rec) => rec.id === ida));
  assert.ok(onlyA.every((rec) => rec['atlas-slug'] === 'a'), 'scope a lists only a');
  const aNone = await list(tokAN);
  assert.ok(aNone.every((rec) => ['a', 'none'].includes(rec['atlas-slug'])), 'scope a,none lists only a and none');
  const aNoneIds = aNone.map((rec) => rec.id);
  assert.ok(aNoneIds.includes(ida) && aNoneIds.includes(idn) && !aNoneIds.includes(idb));
  const everything = (await list(TOKEN)).map((rec) => rec.id);
  for (const id of [ida, idb, idn]) assert.ok(everything.includes(id), 'scope all lists all three');

  // The atlas and item slugs keep their meaning within the scope.
  for (const [atlas, itm, reason] of [[null, item, 'atlas-slug is required'], ['a', null, 'item-slug is required']]) {
    r = await call('GET', '/status', { headers: byToken(tokA, atlas, itm), params: { id: ida } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, reason);
    r = await call('POST', '/update', { headers: byToken(tokA, atlas, itm), body: { id: ida, what: 'x' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, reason);
  }
  assert.deepEqual(idsOf(await list(tokAN, 'none', item)), [idn]);
  assert.deepEqual(idsOf(await list(tokAN, null, item)), [ida, idn].sort());
  assert.deepEqual(idsOf(await list(TOKEN, null, item)), [ida, idb, idn].sort());
  assert.deepEqual(await list(tokA, 'b', null), []);
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
  const tokA = (await mintToken('a')).token;
  const find = async (token, params, atlas) => {
    const r = await call('GET', '/inventory', { headers: byToken(token, atlas, null), params });
    assert.equal(r.status, 200, JSON.stringify(params));
    return idsOf(r.json.records);
  };

  assert.deepEqual(await find(TOKEN, { q: 'quokka' }), [qa1, qb2].sort(), 'what, any case');
  assert.deepEqual(await find(TOKEN, { q: 'WOMB' }), [qa2], 'who-acts');
  assert.deepEqual(await find(TOKEN, { q: 'tYpU' }), [qb1], 'how-observed');
  assert.deepEqual(await find(tokA, { q: 'quokka' }), [qa1], 'within the scope');
  assert.deepEqual(await find(tokA, { q: 'platypus' }), []);

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

// The two tests below are the only place the old navigation-slug names remain in this file.

test('the old column is renamed at start and the rows kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'externality-tracker-old-'));
  const old = new DatabaseSync(join(dir, 'externalities.sqlite'));
  old.exec(`CREATE TABLE IF NOT EXISTS externalities (
    id TEXT PRIMARY KEY, org TEXT, nav TEXT, item TEXT, what TEXT,
    who_acts TEXT, how_observed TEXT, state TEXT, set_date TEXT,
    cleared_date TEXT, cleared_words TEXT)`);
  old.prepare(`INSERT INTO externalities
    (id, org, nav, item, what, who_acts, how_observed, state, set_date, cleared_date, cleared_words)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'old-1', ORG, 'old-nav', 'old-item', 'kept', 'someone', 'somehow', 'open', '2026-10-12T00:00:00.000Z', null, null);
  old.close();
  const expectRecord = (rec) => {
    assert.equal(rec.id, 'old-1');
    assert.equal(rec['atlas-slug'], 'old-nav');
    assert.equal(rec['item-slug'], 'old-item');
    assert.equal(rec.what, 'kept');
    assert.equal(rec['who-acts'], 'someone');
    assert.equal(rec['how-observed'], 'somehow');
    assert.equal(rec.state, 'open');
    assert.equal(rec['set-date'], '2026-10-12T00:00:00.000Z');
    assert.equal('nav-slug' in rec, false);
  };
  for (const start of [1, 2]) {
    const s = createServer({ ORG_SLUG: ORG, EXTERNALITY_KEY: KEY, DATA_DIR: dir });
    await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
    const b = `http://127.0.0.1:${s.address().port}`;
    const minted = await fetch(`${b}/tokens`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'all' }),
    });
    assert.equal(minted.status, 201, `start ${start}`);
    const h = byToken((await minted.json()).token, 'old-nav', 'old-item');
    const inv = await (await fetch(`${b}/inventory`, { headers: h })).json();
    assert.equal(inv.records.length, 1, `start ${start}`);
    expectRecord(inv.records[0]);
    const st = await (await fetch(`${b}/status?id=old-1`, { headers: h })).json();
    expectRecord(st.record);
    await new Promise((resolve) => s.close(resolve));
  }
  const after2 = new DatabaseSync(join(dir, 'externalities.sqlite'));
  const columns = after2.prepare('PRAGMA table_info(externalities)').all().map((c) => c.name);
  after2.close();
  assert.ok(columns.includes('atlas') && !columns.includes('nav'), columns.join(','));
  // the directory is left in place on purpose (the item's concern C1, option (a))
});

test('the old header alone is refused', async () => {
  const r = await call('POST', '/add', { headers: auth(null, 'i', { 'X-Nav-Slug': 'n' }), body: BODY });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'atlas-slug is required');
  const p = await call('POST', '/add', { headers: auth(null, 'i'), params: { 'nav-slug': 'n' }, body: BODY });
  assert.equal(p.status, 400);
  assert.equal(p.json.error, 'atlas-slug is required');
});

// Delivery: every add re-sent once to the URL of each in-scope token. The one test server delivers every add to
// every in-scope token with a URL, so each test mints its own token with its own receiver under its own atlas,
// and counts only the requests carrying its own record's id. No assertion message below carries a token.

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

async function addFull(atlas, item) {
  const r = await call('POST', '/add', { headers: auth(atlas, item), body: BODY });
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

const TOKEN_FIELDS = ['date', 'last-delivery-date', 'last-delivery-status', 'scope', 'url'];

test('delivery: a scoped token with a URL receives the add once, JSON, no auth header, the inventory record', async () => {
  const rx = await receiver();
  const atlas = 'dlv-scoped';
  const item = 'dlv-scoped-item';
  const t = await mintToken(atlas, rx.url);
  const added = await addFull(atlas, item);
  const outcome = await settled(t.token);
  const got = rx.withId(added.id);
  assert.equal(got.length, 1, 'exactly one request with the id');
  assert.ok(String(got[0].headers['content-type']).startsWith('application/json'), got[0].headers['content-type']);
  assert.equal('authorization' in got[0].headers, false, 'no auth header');
  const body = JSON.parse(got[0].body);
  assert.deepEqual(body, added.record, 'the add response record');
  const inv = await call('GET', '/inventory', { headers: read(atlas, item) });
  assert.equal(inv.status, 200);
  const fromInventory = inv.json.records.find((rec) => rec.id === added.id);
  assert.ok(fromInventory, 'inventory lists the record');
  assert.deepEqual(body, fromInventory, 'the inventory record');
  assert.equal(outcome['last-delivery-status'], 200);
  assert.match(outcome['last-delivery-date'], ISO);
});

test('delivery: an add under another atlas does not reach the scoped token', async () => {
  const rx = await receiver();
  const t = await mintToken('dlv-mine', rx.url);
  const added = await addFull('dlv-not-mine', 'dlv-not-mine-item');
  await sleep(NEGATIVE_WAIT);
  assert.equal(rx.withId(added.id).length, 0);
  assert.equal(rx.requests.length, 0, 'the receiver was not called');
  const rec = await tokenRecord(t.token);
  assert.equal(rec['last-delivery-date'], null);
  assert.equal(rec['last-delivery-status'], null);
});

test('delivery: a token of scope all with a URL receives the add', async () => {
  const rx = await receiver();
  const t = await mintToken('all', rx.url);
  const added = await addFull('dlv-all-atlas', 'dlv-all-item');
  const outcome = await settled(t.token);
  assert.equal(rx.withId(added.id).length, 1);
  assert.deepEqual(JSON.parse(rx.withId(added.id)[0].body), added.record);
  assert.equal(outcome['last-delivery-status'], 200);
  assert.match(outcome['last-delivery-date'], ISO);
});

test('delivery: a token without a URL stays at nulls', async () => {
  const atlas = 'dlv-no-url';
  const t = await mintToken(atlas);
  assert.equal(t.url, null);
  await addFull(atlas, 'dlv-no-url-item');
  await sleep(NEGATIVE_WAIT);
  const rec = await tokenRecord(t.token);
  assert.equal(rec.url, null);
  assert.equal(rec['last-delivery-date'], null);
  assert.equal(rec['last-delivery-status'], null);
});

test('delivery: a receiver answering 500 stores 500 and is called once', async () => {
  const rx = await receiver(500);
  const atlas = 'dlv-500';
  const t = await mintToken(atlas, rx.url);
  const added = await addFull(atlas, 'dlv-500-item');
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
  const atlas = 'dlv-silent';
  const t = await mintToken(atlas, rx.url);
  const started = performance.now();
  const r = await call('POST', '/add', { headers: auth(atlas, 'dlv-silent-item'), body: BODY });
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
  const atlas = 'dlv-closed';
  const t = await mintToken(atlas, await closedPortUrl());
  const r = await call('POST', '/add', { headers: auth(atlas, 'dlv-closed-item'), body: BODY });
  assertAddShape(r);
  const outcome = await settled(t.token);
  assert.equal(outcome['last-delivery-status'], 0);
  assert.match(outcome['last-delivery-date'], ISO);
});

test('delivery: an update is not re-sent', async () => {
  const rx = await receiver();
  const atlas = 'dlv-update';
  const item = 'dlv-update-item';
  const t = await mintToken(atlas, rx.url);
  const added = await addFull(atlas, item);
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
  const atlas = 'dlv-overwrite';
  const t = await mintToken(atlas, rx.url);
  const first = await addFull(atlas, 'dlv-overwrite-item');
  const one = await settled(t.token);
  assert.equal(one['last-delivery-status'], 200);
  rx.status = 500;
  const second = await addFull(atlas, 'dlv-overwrite-item');
  const two = await settled(t.token, (x) => x['last-delivery-status'] === 500);
  assert.equal(two['last-delivery-status'], 500);
  assert.match(two['last-delivery-date'], ISO);
  assert.ok(two['last-delivery-date'] >= one['last-delivery-date'], 'the later attempt dated no earlier');
  assert.equal(rx.withId(first.id).length, 1);
  assert.equal(rx.withId(second.id).length, 1);
});

test('GET /token: the token record without the token value, nulls before any delivery', async () => {
  const rx = await receiver();
  const t = await mintToken('dlv-token-info', rx.url);
  const r = await call('GET', '/token', { headers: byToken(t.token) });
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.deepEqual(Object.keys(r.json).sort(), TOKEN_FIELDS);
  assert.equal('token' in r.json, false, 'no token field');
  assert.equal(r.json.scope, t.scope);
  assert.equal(r.json.url, t.url);
  assert.equal(r.json.url, rx.url);
  assert.equal(r.json.date, t.date);
  assert.equal(r.json['last-delivery-date'], null);
  assert.equal(r.json['last-delivery-status'], null);
  assert.equal(rx.requests.length, 0);
});

test('GET /token: the org key alone is refused with 401', async () => {
  const r = await call('GET', '/token', { headers: auth() });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'consumer token is required');
});

test('timeoutMs: 10000 by default, the variable when a positive integer, else 10000', () => {
  assert.equal(timeoutMs({}), 10000);
  assert.equal(timeoutMs({ DELIVERY_TIMEOUT_MS: '500' }), 500);
  assert.equal(timeoutMs({ DELIVERY_TIMEOUT_MS: 'abc' }), 10000);
  assert.equal(timeoutMs({ DELIVERY_TIMEOUT_MS: '0' }), 10000);
  assert.equal(timeoutMs({ DELIVERY_TIMEOUT_MS: '-5' }), 10000);
});

// The two open addresses, `/<part>/notify` and `/<part>/status`. The server above runs without ADDRESS_KEY, so its
// addresses are off; a second server runs with a part, on its own data folder inside the first one's (removed with it).
// No assertion message below carries the part.

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

before(async () => {
  partDir = join(dataDir, 'addresses');
  partServer = createServer({ ORG_SLUG: ORG, EXTERNALITY_KEY: KEY, ADDRESS_KEY: PART, DATA_DIR: partDir, DELIVERY_TIMEOUT_MS: String(DELIVERY_TIMEOUT) });
  await new Promise((resolve) => partServer.listen(0, '127.0.0.1', resolve));
  partBase = `http://127.0.0.1:${partServer.address().port}`;
});

after(async () => {
  await new Promise((resolve) => partServer.close(resolve));
});

// A call to the server with the part; `raw` is sent as the body text when given.
async function at(method, path, { headers = {}, body, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  if (init.body !== undefined) init.headers['content-type'] = 'application/json';
  const res = await fetch(new URL(path, partBase), init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

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
      env: { PATH: process.env.PATH, ORG_SLUG: ORG, EXTERNALITY_KEY: KEY, ADDRESS_KEY: part, DATA_DIR: dataDir, PORT: '0' },
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
  assert.deepEqual(await call('POST', `/${PART}/notify`, { body: notice('feature/off', 'open') }), NOT_FOUND);
  assert.deepEqual(await call('GET', statusPath('feature/off')), NOT_FOUND);
});

test('addresses: on with ADDRESS_KEY, both answer; the present routes still answer', async () => {
  assert.deepEqual(Object.keys(await post(notice('feature/on', 'open'))), ['id']);
  assert.equal((await statusOf('feature/on')).length, 1);
  assert.equal((await at('GET', '/')).status, 200);
  assert.deepEqual(await at('GET', '/inventory'), { status: 401, json: { error: 'consumer token is required' } });
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

test('addresses: no credential is read; one sent is ignored', async () => {
  const item = 'feature/no-credential';
  const variants = [{}, { 'Authorization': 'Bearer wrong', 'X-Consumer-Token': 'wrong', 'X-Org-Slug': 'another-org' },
    { 'Authorization': `Bearer ${KEY}`, 'X-Org-Slug': ORG }];
  for (const [i, headers] of variants.entries()) {
    const r = await at('POST', `/${PART}/notify`, { headers, body: notice(item, 'open', { what: `posted ${i}` }) });
    assert.equal(r.status, 201, `notice ${i}`);
  }
  const reads = [];
  for (const headers of variants) {
    const r = await at('GET', statusPath(item), { headers });
    assert.equal(r.status, 200);
    reads.push(r.json);
  }
  assert.equal(reads[0].length, 3);
  assert.deepEqual(reads[1], reads[0]);
  assert.deepEqual(reads[2], reads[0]);
});

test('notify: a kept notice answers 201 with its id alone; two notices, two ids; one row each', async () => {
  const item = 'feature/ids';
  const one = await post(notice(item, 'open'));
  const two = await post(notice(item, 'open'));
  for (const r of [one, two]) {
    assert.deepEqual(Object.keys(r), ['id']);
    assert.match(r.id, UUID);
  }
  assert.notEqual(one.id, two.id);
  const db = new DatabaseSync(join(partDir, 'externalities.sqlite'));
  try {
    const columns = db.prepare('PRAGMA table_info(notices)').all().map((c) => c.name);
    assert.deepEqual(columns, ['id', 'item', 'state', 'what', 'body', 'received']);
    const rows = db.prepare('SELECT * FROM notices WHERE item = ?').all(item);
    assert.deepEqual(rows.map((r) => r.id).sort(), [one.id, two.id].sort());
    for (const row of rows) {
      assert.equal(row.state, 'open');
      assert.equal(row.what, 'a vendor key is issued');
      assert.deepEqual(JSON.parse(row.body), notice(item, 'open'));
      assert.match(row.received, ISO);
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
  const res = await fetch(new URL(statusPath('feature/n'), partBase));
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
  const db = new DatabaseSync(join(partDir, 'externalities.sqlite'));
  try {
    const insert = db.prepare('INSERT INTO notices (id, item, state, what, body, received) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [id, state] of [['z-first', 'open'], ['a-second', 'cleared']]) {
      insert.run(id, item, state, 'w', JSON.stringify({ item, state, what: 'w', id }), '2026-11-17T09:00:00.000Z');
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
  const r = await at('POST', '/add', { headers: auth('none', item), body: BODY });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(await statusOf(item), []);
  const token = (await at('POST', '/tokens', { headers: auth(), body: { scope: 'all' } })).json.token;
  const inv = await at('GET', '/inventory', { headers: byToken(token, 'none', item) });
  assert.equal(inv.status, 200);
  assert.deepEqual(inv.json.records.map((rec) => rec.id), [r.json.id]);
});

test('notify: a notice reaches no token address', async () => {
  const rx = await receiver();
  const m = await at('POST', '/tokens', { headers: auth(), body: { scope: 'all', url: rx.url } });
  assert.equal(m.status, 201);
  const added = await at('POST', '/add', { headers: auth('none', 'feature/no-delivery'), body: BODY });
  assert.equal(added.status, 201);
  for (let i = 0; i < 60 && rx.requests.length === 0; i++) await sleep(50);
  assert.equal(rx.withId(added.json.id).length, 1, 'positive control: the add was delivered');
  const kept = await post(notice('feature/no-delivery', 'open'));
  await sleep(NEGATIVE_WAIT);
  assert.equal(rx.requests.length, 1, 'the notice was not delivered');
  assert.equal(rx.withId(kept.id).length, 0);
});

// The passing-on: a notice's `3rdparty-notice-url` posted to once, behind the guard. Every receiver here listens on
// loopback, which the guard refuses, so a server that must post runs with THIRDPARTY_ALLOW=127.0.0.1; each test
// starts its own, on its own data folder inside the first server's (removed with it). No assertion message carries a part.

const TP = '3rdparty-notice-url';
const OUTSIDE = '93.184.216.34';

// A server with its notice address on and the given THIRDPARTY_ALLOW (undefined: unset).
async function tpServer(allow) {
  const part = randomBytes(32).toString('base64url');
  const env = { ORG_SLUG: ORG, EXTERNALITY_KEY: KEY, ADDRESS_KEY: part, DATA_DIR: mkdtempSync(join(dataDir, 'tp-')),
    DELIVERY_TIMEOUT_MS: String(DELIVERY_TIMEOUT), ...(allow === undefined ? {} : { THIRDPARTY_ALLOW: allow }) };
  const s = createServer(env);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const b = `http://127.0.0.1:${s.address().port}`;
  const req = async (method, path, { headers = {}, raw } = {}) => {
    const init = { method, headers: { ...headers } };
    if (raw !== undefined) { init.body = raw; init.headers['content-type'] = 'application/json'; }
    const res = await fetch(new URL(path, b), init);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return {
    req,
    notifyUrl: `${b}/${part}/notify`,
    notify: (raw, headers) => req('POST', `/${part}/notify`, { raw, headers }),
    statusOf: (item) => req('GET', `/${part}/status?item=${encodeURIComponent(item)}`),
    outcome: () => req('GET', '/thirdparty', { headers: auth() }),
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
      const r = await s.notify(raw, i === 1 ? { 'Authorization': 'Bearer notice-side-0123' } : {});
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
      env: { PATH: process.env.PATH, ORG_SLUG: ORG, EXTERNALITY_KEY: KEY, THIRDPARTY_ALLOW: allow, DATA_DIR: dataDir, PORT: '0' },
      timeout: 10000,
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, null, 'exited on its own');
    assert.match(r.stderr, /refusing to start: THIRDPARTY_ALLOW/);
  }
});

test('GET /thirdparty: refused without the org key; null at first, the latest outcome after, replaced by the next', async () => {
  const rx = await receiver(200);
  const s = await tpServer('127.0.0.1');
  try {
    for (const headers of [{}, { 'X-Org-Slug': ORG }, { 'X-Org-Slug': ORG, 'Authorization': 'Bearer wrong' },
      { 'X-Org-Slug': 'another-org', 'Authorization': `Bearer ${KEY}` }, { 'X-Consumer-Token': TOKEN }]) {
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
    assert.equal((await s.req('POST', '/tokens', { headers: auth(), raw: JSON.stringify({ scope: 'all', url: tokenRx.url }) })).status, 201);
    const added = await s.req('POST', '/add', { headers: auth('none', 'feature/tp-token'), raw: JSON.stringify(BODY) });
    assert.equal(added.status, 201);
    for (let i = 0; i < 60 && tokenRx.requests.length === 0; i++) await sleep(50);
    assert.equal(tokenRx.withId(added.json.id).length, 1, 'positive control: the add was delivered');
    assert.equal((await s.notify(tpNotice('feature/tp-token', 'open', third.url))).status, 201);
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

test('thirdparty: a notice naming the service\'s own notice address is kept twice, the original and one copy, no more', async () => {
  const s = await tpServer('127.0.0.1');
  try {
    const item = 'feature/tp-self';
    assert.equal((await s.notify(tpNotice(item, 'open', s.notifyUrl))).status, 201);
    for (let i = 0; i < 60 && (await s.statusOf(item)).json.length < 2; i++) await sleep(50);
    await sleep(NEGATIVE_WAIT);
    assert.equal((await s.statusOf(item)).json.length, 2, 'the original and one copy');
    assert.equal((await tpSettled(s))['last-delivery-status'], 201, 'the copy was posted and kept');
    await sleep(NEGATIVE_WAIT);
    assert.equal((await s.statusOf(item)).json.length, 2, 'the count is stable');
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
