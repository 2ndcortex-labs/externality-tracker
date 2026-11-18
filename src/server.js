import http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAuthConfig, loadAddressKey, matchesPart, resolveCall, refuse, authenticateToken, parseScope } from './auth.js';
import { openDb } from './db.js';
import { HttpError, add, mint, update, status, inventory, tokenInfo, thirdpartyInfo } from './routes.js';
import { keep, readStatus } from './notices.js';
import { deliver, timeoutMs } from './deliver.js';
import { PASSED_ON, parseAllow, passOn } from './thirdparty.js';

const STARTED = new Date(performance.timeOrigin).toISOString();
const MAX_BODY = 1024 * 1024;
// The two open addresses, `/<part>/notify` and `/<part>/status`; anything else falls through to the route table.
const ADDRESS = /^\/([^/]+)\/(notify|status)$/;

// Each route reads one credential: the org key ('key') or a consumer token ('token').
const ROUTES = {
  'POST /add': { credential: 'key', handler: (db, call, url, body) => add(db, call, body) },
  'POST /tokens': { credential: 'key', handler: (db, call, url, body) => mint(db, call, body) },
  'POST /update': { credential: 'token', handler: (db, call, url, body) => update(db, call, body) },
  'GET /status': { credential: 'token', handler: (db, call, url) => status(db, call, url) },
  'GET /inventory': { credential: 'token', handler: (db, call, url) => inventory(db, call, url) },
  'GET /token': { credential: 'token', handler: (db, call) => tokenInfo(call) },
  'GET /thirdparty': { credential: 'key', handler: (db) => thirdpartyInfo(db) },
};

function send(res, code, payload) {
  sendText(res, code, JSON.stringify(payload));
}

// Writes JSON text already formed, as-is.
function sendText(res, code, text) {
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readText(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(400, 'body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  const text = await readText(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

export function createServer(env = process.env) {
  const config = loadAuthConfig(env);
  const part = loadAddressKey(env);
  const allow = parseAllow(env.THIRDPARTY_ALLOW ?? '');
  const db = openDb(env);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, { ok: true, service: 'externality-tracker', node: process.version, started: STARTED });
      }
      // The open addresses read no credential. A wrong part, the addresses off or another method falls through
      // to the route table, which answers 404 as for any unknown route.
      const open = ADDRESS.exec(url.pathname);
      if (open && matchesPart(open[1], part)) {
        if (req.method === 'POST' && open[2] === 'notify') {
          const text = await readText(req);
          const [code, payload, record] = keep(db, text);
          send(res, code, payload);
          // A notice that is itself a passing-on (it carries PASSED_ON, any value) is kept but never passed on again.
          if (Object.hasOwn(req.headers, PASSED_ON)) return;
          // The notice is kept and answered; its passing-on to a third party starts now and is never awaited.
          void passOn(db, record, text, { allow, timeout: timeoutMs(env) });
          return;
        }
        if (req.method === 'GET' && open[2] === 'status') return sendText(res, ...readStatus(db, url));
      }
      const name = `${req.method} ${url.pathname}`;
      const route = ROUTES[name];
      if (!route) return send(res, 404, { error: 'not found' });
      const call = resolveCall(req, url);
      if (route.credential === 'key') {
        const reason = refuse(call, config);
        if (reason) return send(res, 401, { error: reason });
      } else {
        call.tokenRow = authenticateToken(call, db, config);
        const scope = parseScope(call.tokenRow.scope);
        call.scope = scope === 'all' ? null : scope ?? [];
        call.org = config.org;
      }
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const [code, payload] = route.handler(db, call, url, body);
      send(res, code, payload);
      // The add has answered; its deliveries start now and are never awaited.
      if (name === 'POST /add' && code === 201) void deliver(db, payload.record, env);
      return;
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'internal error' });
    }
  });
  server.on('close', () => db.close());
  return server;
}

export function start(env = process.env) {
  let server;
  try {
    server = createServer(env);
  } catch (err) {
    console.error(`externality-tracker: refusing to start: ${err.message}`);
    process.exit(1);
  }
  const port = Number(env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => {
    console.log(`externality-tracker listening on 0.0.0.0:${server.address().port}`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  start();
}
