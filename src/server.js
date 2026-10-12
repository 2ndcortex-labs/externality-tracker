import http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAuthConfig, resolveCall, refuse } from './auth.js';
import { openDb } from './db.js';
import { HttpError, add, update, status, inventory } from './routes.js';

const STARTED = new Date(performance.timeOrigin).toISOString();
const MAX_BODY = 1024 * 1024;

const ROUTES = {
  'POST /add': (db, call, url, body) => add(db, call, body),
  'POST /update': (db, call, url, body) => update(db, call, body),
  'GET /status': (db, call, url) => status(db, call, url),
  'GET /inventory': (db, call, url) => inventory(db, call, url),
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
      const handler = ROUTES[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: 'not found' });
      const call = resolveCall(req, url);
      const reason = refuse(call, config);
      if (reason) return send(res, 401, { error: reason });
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const [code, payload] = handler(db, call, url, body);
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
