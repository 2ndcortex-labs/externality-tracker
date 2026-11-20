// The forwarding: after a notice is kept and answered, its text is POSTed once to the forwarding address stored with
// the token that sent it, and to no other, behind the guard of the passing-on (src/thirdparty.js) and through its
// single post: no retry, no redirect followed, under the timeout. The outcome is written on that token's row, the
// latest only; a refused address is sent nothing and its outcome is status 0 with the attempt's time.
import dns from 'node:dns';
import { postOnce } from './thirdparty.js';

const DEFAULT_TIMEOUT_MS = 10000;

// The integer of DELIVERY_TIMEOUT_MS when it is a positive integer, else 10 seconds.
export function timeoutMs(env) {
  const text = String(env?.DELIVERY_TIMEOUT_MS ?? '');
  const n = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// `row` is the sending token's row ({ id, url }); a row with no URL receives nothing. The status is the response's,
// 0 when none came (refused by the guard, unreachable, timed out); the date is the instant the attempt started.
// A database closed before the attempt settles loses the outcome, nothing else. Never rejects; never awaited.
export async function forward(db, row, text, { allow, timeout }) {
  try {
    if (!row || typeof row.url !== 'string' || row.url === '') return;
    const date = new Date().toISOString();
    const status = await postOnce(row.url, text, { lookup: dns.lookup, allow, timeout });
    db.prepare('UPDATE tokens SET last_delivery_date = ?, last_delivery_status = ? WHERE id = ?').run(date, status, row.id);
  } catch {
    // the outcome is lost; the notice is unaffected
  }
}
