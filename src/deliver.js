// After an add has answered: the record POSTed once, as JSON, to the URL of the token that made it, and to no other.
// No retry; the attempt under the timeout; the outcome written on that token's row, the latest only.

const DEFAULT_TIMEOUT_MS = 10000;

// The integer of DELIVERY_TIMEOUT_MS when it is a positive integer, else 10 seconds.
export function timeoutMs(env) {
  const text = String(env?.DELIVERY_TIMEOUT_MS ?? '');
  const n = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
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
    db.prepare('UPDATE tokens SET last_delivery_date = ?, last_delivery_status = ? WHERE id = ?')
      .run(date, status, row.id);
  } catch {
    // the outcome is lost; the add is unaffected
  }
}

// The making token's row, when it has a URL; the promise never rejects and the server never awaits it.
export function deliver(db, record, tokenId, env) {
  try {
    const row = db.prepare('SELECT id, url FROM tokens WHERE id = ? AND url IS NOT NULL').get(tokenId);
    if (!row) return Promise.resolve();
    return attempt(db, row, record, env).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}
