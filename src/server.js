import http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAuthConfig, loadAddressKey, matchesPart, resolveCall, authenticateAdmin, authenticateToken } from './auth.js';
import { openDb } from './db.js';
import { HttpError, LIMITS, makeLimiter, ask, addEmail, setActive, tokenInfo, thirdpartyInfo } from './routes.js';
import { keep, readStatus } from './notices.js';
import { forward, timeoutMs } from './deliver.js';
import { PASSED_ON, parseAllow, passOn } from './thirdparty.js';

const STARTED = new Date(performance.timeOrigin).toISOString();
const MAX_BODY = 1024 * 1024;
// The two open addresses, `/<part>/notify` and `/<part>/status`; anything else falls through to the route table.
const ADDRESS = /^\/([^/]+)\/(notify|status)$/;

// Each route reads one credential: none (the ask, under the limit; a later ask's own token is checked by `ask`), the
// admin token ('admin') or a holder's token ('token').
const ROUTES = {
  'POST /tokens': { credential: 'none', handler: (db, call, url, body) => ask(db, body, call.bearer) },
  'POST /emails': { credential: 'admin', handler: (db, call, url, body) => addEmail(db, body) },
  'POST /emails/active': { credential: 'admin', handler: (db, call, url, body) => setActive(db, body) },
  'GET /token': { credential: 'token', handler: (db, call) => tokenInfo(call) },
  'GET /thirdparty': { credential: 'token', handler: (db) => thirdpartyInfo(db) },
};

// The caller of an ask: the header `X-Real-IP`, else the connection's own address.
function callerAddress(req) {
  const h = req.headers['x-real-ip'];
  return typeof h === 'string' && h.trim() !== '' ? h.trim() : String(req.socket.remoteAddress ?? '');
}

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

// `limits` sets the numbers and the window of the limit on asking ({ perCaller, total, windowMs }); `start` passes none,
// so the service runs on LIMITS. A test may give its own server its own numbers; the limit is never off.
export function createServer(env = process.env, { limits = LIMITS } = {}) {
  const config = loadAuthConfig(env);
  const part = loadAddressKey(env);
  const allow = parseAllow(env.THIRDPARTY_ALLOW ?? '');
  const db = openDb(env);
  const mayAsk = makeLimiter(limits);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, { ok: true, service: 'externality-tracker', node: process.version, started: STARTED });
      }
      // The open addresses want a holder's token once the part is right. A wrong part, the addresses off or another
      // method falls through to the route table, which answers 404 as for any unknown route.
      const open = ADDRESS.exec(url.pathname);
      if (open && matchesPart(open[1], part)) {
        const notify = req.method === 'POST' && open[2] === 'notify';
        const read = req.method === 'GET' && open[2] === 'status';
        const tokenRow = notify || read ? authenticateToken(resolveCall(req, url), db, config) : null;
        if (notify) {
          const text = await readText(req);
          const [code, payload, record] = keep(db, text, tokenRow.id);
          send(res, code, payload);
          // A notice that is itself a passing-on (it carries PASSED_ON, any value) is kept but neither forwarded nor
          // passed on again.
          if (Object.hasOwn(req.headers, PASSED_ON)) return;
          // The notice is kept and answered; its forwarding to the sending token's address and its passing-on to a
          // third party start now, side by side, and neither is awaited.
          void forward(db, tokenRow, text, { allow, timeout: timeoutMs(env) });
          void passOn(db, record, text, { allow, timeout: timeoutMs(env) });
          return;
        }
        if (read) return sendText(res, ...readStatus(db, url, tokenRow.id));
      }
      const name = `${req.method} ${url.pathname}`;
      const route = ROUTES[name];
      if (!route) return send(res, 404, { error: 'not found' });
      const call = resolveCall(req, url);
      if (route.credential === 'admin') {
        authenticateAdmin(call, config);
      } else if (route.credential === 'token') {
        call.tokenRow = authenticateToken(call, db, config);
      } else if (!mayAsk(callerAddress(req))) {
        // The limit comes before the body and the address; every post counts, whatever its answer.
        return send(res, 429, { error: 'too many asks' });
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
