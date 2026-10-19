import http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAuthConfig, resolveCall, refuse, authenticateToken, parseScope } from './auth.js';
import { openDb } from './db.js';
import { HttpError, add, mint, update, status, inventory } from './routes.js';

const STARTED = new Date(performance.timeOrigin).toISOString();
const MAX_BODY = 1024 * 1024;

// Each route reads one credential: the org key ('key') or a consumer token ('token').
const ROUTES = {
  'POST /add': { credential: 'key', handler: (db, call, url, body) => add(db, call, body) },
  'POST /tokens': { credential: 'key', handler: (db, call, url, body) => mint(db, call, body) },
  'POST /update': { credential: 'token', handler: (db, call, url, body) => update(db, call, body) },
  'GET /status': { credential: 'token', handler: (db, call, url) => status(db, call, url) },
  'GET /inventory': { credential: 'token', handler: (db, call, url) => inventory(db, call, url) },
};

function send(res, code, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(400, 'body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

export function createServer(env = process.env) {
  const config = loadAuthConfig(env);
  const db = openDb(env);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, { ok: true, service: 'externality-tracker', node: process.version, started: STARTED });
      }
      const route = ROUTES[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { error: 'not found' });
      const call = resolveCall(req, url);
      if (route.credential === 'key') {
        const reason = refuse(call, config);
        if (reason) return send(res, 401, { error: reason });
      } else {
        const scope = parseScope(authenticateToken(call, db, config).scope);
        call.scope = scope === 'all' ? null : scope ?? [];
        call.org = config.org;
      }
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const [code, payload] = route.handler(db, call, url, body);
      return send(res, code, payload);
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
