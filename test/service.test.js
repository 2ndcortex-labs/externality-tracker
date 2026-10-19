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

const auth = (atlas, item, extra = {}) => ({
  'X-Org-Slug': ORG, 'X-Externality-Key': KEY,
  ...(atlas ? { 'X-Atlas-Slug': atlas } : {}), ...(item ? { 'X-Item-Slug': item } : {}), ...extra,
});

const BODY = { 'what': 'a thing is true', 'who-acts': 'the operator', 'how-observed': 'by a check' };

async function addOne(atlas, item, body = BODY) {
  const r = await call('POST', '/add', { headers: auth(atlas, item), body });
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
  const r = await call('GET', '/status', { headers: auth('atlas-s', 'item-s'), params: { id } });
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
  assert.equal((await call('GET', '/status', { headers: auth('atlas-t', 'item-t') })).status, 400);
  assert.equal((await call('GET', '/status', { headers: auth('atlas-t', 'item-t'), params: { id: 'nope' } })).status, 404);
  assert.equal((await call('GET', '/status', { headers: auth('other', 'item-t'), params: { id } })).status, 404);
  assert.equal((await call('GET', '/status', { headers: auth('atlas-t', 'other'), params: { id } })).status, 404);
});

test('update changes text, clears with words and a date, reopens', async () => {
  const h = auth('atlas-u', 'item-u');
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
  assert.equal((await call('POST', '/update', { headers: auth('other', 'item-v'), body: { id, what: 'x' } })).status, 404);
  assert.equal((await call('POST', '/update', { headers: auth('atlas-v', 'other'), body: { id, what: 'x' } })).status, 404);
  assert.equal((await call('POST', '/update', { headers: auth('atlas-v', 'item-v'), body: { id: 'nope', what: 'x' } })).status, 404);
  assert.equal((await call('POST', '/update', { headers: auth('atlas-v', 'item-v'), body: { id } })).status, 400);
  assert.equal((await call('POST', '/update', { headers: auth('atlas-v', 'item-v'), body: { id, state: 'gone' } })).status, 400);
  assert.equal((await call('POST', '/update', { headers: auth('atlas-v', 'item-v'), body: { what: 'x' } })).status, 400);
});

test('inventory by none, atlas, item, both and state, newest first', async () => {
  const ids = {};
  for (const [atlas, item] of [['inv-n1', 'inv-i1'], ['inv-n1', 'inv-i2'], ['inv-n2', 'inv-i1'], ['inv-n2', 'inv-i2']]) {
    ids[`${atlas}/${item}`] = await addOne(atlas, item);
    await sleep(5);
  }
  const ids4 = Object.values(ids);
  const list = async (atlas, item, params = {}) => {
    const r = await call('GET', '/inventory', { headers: auth(atlas, item), params });
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
    for (const [method, path, body] of [['GET', '/inventory'], ['POST', '/add', BODY], ['GET', '/status']]) {
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
    const h = auth('old-nav', 'old-item');
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
