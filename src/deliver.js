// After an add has answered: the record POSTed once, as JSON, to the URL of every token whose scope covers
// its atlas. No retry; each attempt under the timeout; the outcome written on the token, the latest only.

const DEFAULT_TIMEOUT_MS = 10000;

// The integer of DELIVERY_TIMEOUT_MS when it is a positive integer, else 10 seconds.
export function timeoutMs(env) {
  const text = String(env?.DELIVERY_TIMEOUT_MS ?? '');
  const n = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function covers(scope, atlas) {
  return scope === 'all' || (typeof scope === 'string' && scope.split(',').includes(atlas));
}

// One attempt: the status of the response, 0 when none came (refused, unreachable, timed out); the date is the
// instant the attempt started. A database closed before the attempt settles loses the outcome, nothing else.
async function attempt(db, row, record, env) {
  const date = new Date().toISOString();
  let status = 0;
  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(timeoutMs(env)),
    });
    status = res.status;
    await res.body?.cancel().catch(() => {});
  } catch {
    // no response: status stays 0
  }
  try {
    db.prepare('UPDATE tokens SET last_delivery_date = ?, last_delivery_status = ? WHERE token = ?')
      .run(date, status, row.token);
  } catch {
    // the outcome is lost; the add is unaffected
  }
}

// Every in-scope token with a URL, in parallel; the promise never rejects and the server never awaits it.
export function deliver(db, record, env) {
  try {
    const rows = db.prepare('SELECT token, scope, url FROM tokens WHERE url IS NOT NULL').all()
      .filter((row) => covers(row.scope, record['atlas-slug']));
    return Promise.allSettled(rows.map((row) => attempt(db, row, record, env))).then(() => undefined);
  } catch {
    return Promise.resolve();
  }
}
