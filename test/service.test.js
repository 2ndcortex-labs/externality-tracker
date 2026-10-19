import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from '../src/server.js';

const ORG = 'test-org';
const KEY = 'test-key-0123456789';
const FIELDS = ['id', 'org-slug', 'atlas-slug', 'item-slug', 'what', 'who-acts', 'how-observed',
  'state', 'set-date', 'cleared-date', 'cleared-words'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let server;
let base;
let dataDir;
let TOKEN; // a token of scope `all`, never printed

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'externality-tracker-'));
  server = createServer({ ORG_SLUG: ORG, EXTERNALITY_KEY: KEY, DATA_DIR: dataDir });
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
  'X-Org-Slug': ORG, 'X-Externality-Key': KEY,
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
  const p = { 'consumer-token': TOKEN };
  assert.equal((await call('GET', '/inventory', { headers: { 'X-Org-Slug': ORG }, params: p })).status, 200);
  assert.equal((await call('GET', '/inventory', { params: { ...p, 'org-slug': ORG } })).status, 200);
  assert.equal((await call('GET', '/inventory', { headers: { 'X-Org-Slug': ORG }, params: { ...p, 'org-slug': 'wrong' } })).status, 200);
  assert.equal((await call('GET', '/inventory', { headers: { 'X-Org-Slug': 'wrong' }, params: { ...p, 'org-slug': ORG } })).status, 401);
});

// The key is read by add and /tokens only, so its precedence is proved on add.
test('precedence: externality-key from header, param, header wins', async () => {
  const p = { 'org-slug': ORG };
  const s = { 'X-Atlas-Slug': 'prec-key', 'X-Item-Slug': 'prec-key' };
  assert.equal((await call('POST', '/add', { headers: { ...s, 'X-Externality-Key': KEY }, params: p, body: BODY })).status, 201);
  assert.equal((await call('POST', '/add', { headers: s, params: { ...p, 'externality-key': KEY }, body: BODY })).status, 201);
  assert.equal((await call('POST', '/add', { headers: { ...s, 'X-Externality-Key': KEY }, params: { ...p, 'externality-key': 'wrong' }, body: BODY })).status, 201);
  assert.equal((await call('POST', '/add', { headers: { ...s, 'X-Externality-Key': 'wrong' }, params: { ...p, 'externality-key': KEY }, body: BODY })).status, 401);
});

for (const [name, header, param, field] of [
  ['atlas-slug', 'X-Atlas-Slug', 'atlas-slug', 'atlas-slug'],
  ['item-slug', 'X-Item-Slug', 'item-slug', 'item-slug'],
]) {
  test(`precedence: ${name} from header, param, header wins`, async () => {
    const other = name === 'atlas-slug' ? { 'X-Item-Slug': 'prec-item' } : { 'X-Atlas-Slug': 'prec-atlas' };
    const base = { 'X-Org-Slug': ORG, 'X-Externality-Key': KEY, ...other };
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
    { 'X-Org-Slug': ORG, 'X-Externality-Key': 'wrong' },
    { 'X-Org-Slug': ORG },
    { 'X-Org-Slug': 'another-org', 'X-Externality-Key': KEY },
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
  const hook = 'https://example.com/hook?x=1&y=two';
  const withUrl = await mintToken(' b, a ,a', hook);
  assert.equal(withUrl.scope, 'b,a');
  assert.equal(withUrl.url, hook);
  assert.equal((await mintToken('none', 'http://localhost:8080/in')).url, 'http://localhost:8080/in');

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
    for (const headers of [slugs, { ...slugs, 'X-Org-Slug': ORG }, { ...slugs, 'X-Org-Slug': ORG, 'X-Externality-Key': KEY }]) {
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
    assert.equal(r.status, 200, `${at} by parameter`);
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
      [{ ...slugs, 'X-Org-Slug': ORG, 'X-Externality-Key': 'wrong' }, 'wrong externality key'],
      [{ ...slugs, 'X-Org-Slug': 'another-org', 'X-Externality-Key': KEY }, 'org slug does not match the key'],
    ]) {
      const r = await call('POST', path, { headers, body });
      assert.equal(r.status, 401, `${path}: ${reason}`);
      assert.equal(r.json.error, reason, path);
    }
  }
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
