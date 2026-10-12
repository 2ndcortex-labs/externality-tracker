import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from '../src/server.js';

const ORG = 'test-org';
const KEY = 'test-key-0123456789';
const FIELDS = ['id', 'org-slug', 'nav-slug', 'item-slug', 'what', 'who-acts', 'how-observed',
  'state', 'set-date', 'cleared-date', 'cleared-words'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let server;
let base;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'externality-tracker-'));
  server = createServer({ ORG_SLUG: ORG, EXTERNALITY_KEY: KEY, DATA_DIR: dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
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

const auth = (nav, item, extra = {}) => ({
  'X-Org-Slug': ORG, 'X-Externality-Key': KEY,
  ...(nav ? { 'X-Nav-Slug': nav } : {}), ...(item ? { 'X-Item-Slug': item } : {}), ...extra,
});

const BODY = { 'what': 'a thing is true', 'who-acts': 'the operator', 'how-observed': 'by a check' };

async function addOne(nav, item, body = BODY) {
  const r = await call('POST', '/add', { headers: auth(nav, item), body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

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
  const r = await call('POST', '/add', { headers: auth('nav-a', 'item-a'), body: BODY });
  assert.equal(r.status, 201);
  assert.equal(typeof r.json.id, 'string');
  assert.ok(r.json.id.length > 0);
  assert.equal(r.json.record.id, r.json.id);
  assert.equal(r.json.record.state, 'open');
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
  const id = await addOne('nav-s', 'item-s');
  const r = await call('GET', '/status', { headers: auth('nav-s', 'item-s'), params: { id } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json.record).sort(), [...FIELDS].sort());
  const rec = r.json.record;
  assert.equal(rec.id, id);
  assert.equal(rec['org-slug'], ORG);
  assert.equal(rec['nav-slug'], 'nav-s');
  assert.equal(rec['item-slug'], 'item-s');
  assert.equal(rec.what, BODY.what);
  assert.equal(rec['who-acts'], BODY['who-acts']);
  assert.equal(rec['how-observed'], BODY['how-observed']);
  assert.equal(rec.state, 'open');
  assert.match(rec['set-date'], ISO);
  assert.equal(rec['cleared-date'], null);
  assert.equal(rec['cleared-words'], null);
});

test('status: missing id 400, unknown id 404, wrong nav or item 404', async () => {
  const id = await addOne('nav-t', 'item-t');
  assert.equal((await call('GET', '/status', { headers: auth('nav-t', 'item-t') })).status, 400);
  assert.equal((await call('GET', '/status', { headers: auth('nav-t', 'item-t'), params: { id: 'nope' } })).status, 404);
  assert.equal((await call('GET', '/status', { headers: auth('other', 'item-t'), params: { id } })).status, 404);
  assert.equal((await call('GET', '/status', { headers: auth('nav-t', 'other'), params: { id } })).status, 404);
});

test('update changes text, clears with words and a date, reopens', async () => {
  const h = auth('nav-u', 'item-u');
  const id = await addOne('nav-u', 'item-u');

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

test('update: 404 on wrong nav, wrong item, unknown id; 400 on bad input', async () => {
  const id = await addOne('nav-v', 'item-v');
  assert.equal((await call('POST', '/update', { headers: auth('other', 'item-v'), body: { id, what: 'x' } })).status, 404);
  assert.equal((await call('POST', '/update', { headers: auth('nav-v', 'other'), body: { id, what: 'x' } })).status, 404);
  assert.equal((await call('POST', '/update', { headers: auth('nav-v', 'item-v'), body: { id: 'nope', what: 'x' } })).status, 404);
  assert.equal((await call('POST', '/update', { headers: auth('nav-v', 'item-v'), body: { id } })).status, 400);
  assert.equal((await call('POST', '/update', { headers: auth('nav-v', 'item-v'), body: { id, state: 'gone' } })).status, 400);
  assert.equal((await call('POST', '/update', { headers: auth('nav-v', 'item-v'), body: { what: 'x' } })).status, 400);
});

test('inventory by none, nav, item, both and state, newest first', async () => {
  const ids = {};
  for (const [nav, item] of [['inv-n1', 'inv-i1'], ['inv-n1', 'inv-i2'], ['inv-n2', 'inv-i1'], ['inv-n2', 'inv-i2']]) {
    ids[`${nav}/${item}`] = await addOne(nav, item);
    await sleep(5);
  }
  const ids4 = Object.values(ids);
  const list = async (nav, item, params = {}) => {
    const r = await call('GET', '/inventory', { headers: auth(nav, item), params });
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

  const byNav = await list('inv-n1', null);
  assert.deepEqual(byNav.map((r) => r.id), [ids['inv-n1/inv-i2'], ids['inv-n1/inv-i1']]);

  const byItem = await list(null, 'inv-i1');
  assert.deepEqual(byItem.map((r) => r.id), [ids['inv-n2/inv-i1'], ids['inv-n1/inv-i1']]);

  const both = await list('inv-n2', 'inv-i2');
  assert.deepEqual(both.map((r) => r.id), [ids['inv-n2/inv-i2']]);

  const h = auth('inv-n2', 'inv-i2');
  await call('POST', '/update', { headers: h, body: { id: ids['inv-n2/inv-i2'], state: 'cleared', 'cleared-words': 'ok' } });
  const cleared = await list('inv-n2', null, { state: 'cleared' });
  assert.deepEqual(cleared.map((r) => r.id), [ids['inv-n2/inv-i2']]);
  const open = await list('inv-n2', null, { state: 'open' });
  assert.deepEqual(open.map((r) => r.id), [ids['inv-n2/inv-i1']]);
  for (const r of await list(null, null, { state: 'open' })) assert.equal(r.state, 'open');

  assert.equal((await call('GET', '/inventory', { headers: auth(), params: { state: 'other' } })).status, 400);
  assert.equal((await list('inv-n1', null, { page: '2' })).length, 2, 'page is ignored');
});

test('precedence: org-slug from header, param, header wins', async () => {
  const p = { 'externality-key': KEY };
  assert.equal((await call('GET', '/inventory', { headers: { 'X-Org-Slug': ORG }, params: p })).status, 200);
  assert.equal((await call('GET', '/inventory', { params: { ...p, 'org-slug': ORG } })).status, 200);
  assert.equal((await call('GET', '/inventory', { headers: { 'X-Org-Slug': ORG }, params: { ...p, 'org-slug': 'wrong' } })).status, 200);
  assert.equal((await call('GET', '/inventory', { headers: { 'X-Org-Slug': 'wrong' }, params: { ...p, 'org-slug': ORG } })).status, 401);
});

test('precedence: externality-key from header, param, header wins', async () => {
  const p = { 'org-slug': ORG };
  assert.equal((await call('GET', '/inventory', { headers: { 'X-Externality-Key': KEY }, params: p })).status, 200);
  assert.equal((await call('GET', '/inventory', { params: { ...p, 'externality-key': KEY } })).status, 200);
  assert.equal((await call('GET', '/inventory', { headers: { 'X-Externality-Key': KEY }, params: { ...p, 'externality-key': 'wrong' } })).status, 200);
  assert.equal((await call('GET', '/inventory', { headers: { 'X-Externality-Key': 'wrong' }, params: { ...p, 'externality-key': KEY } })).status, 401);
});

for (const [name, header, param, field] of [
  ['nav-slug', 'X-Nav-Slug', 'nav-slug', 'nav-slug'],
  ['item-slug', 'X-Item-Slug', 'item-slug', 'item-slug'],
]) {
  test(`precedence: ${name} from header, param, header wins`, async () => {
    const other = name === 'nav-slug' ? { 'X-Item-Slug': 'prec-item' } : { 'X-Nav-Slug': 'prec-nav' };
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
    for (const [method, path, body] of [['GET', '/inventory'], ['POST', '/add', BODY], ['GET', '/status']]) {
      const r = await call(method, path, { headers: { ...headers, 'X-Nav-Slug': 'n', 'X-Item-Slug': 'i' }, body });
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
  assert.equal((await call('POST', '/update', { headers: auth('n', 'i'), raw: '' })).status, 400);
  assert.equal((await call('GET', '/status', { headers: auth('n', 'i'), params: { id: 'missing' } })).status, 404);
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
