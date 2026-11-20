// The two open addresses: a notice taken as sent once it passes the test, and the status read by an item's reference.
// Both want a token as `Authorization: Bearer <token>` beside the hard-to-guess part in the path (see server.js);
// each notice belongs to the token's row that sent it, and a status read returns that row's notices only.
import { randomUUID } from 'node:crypto';
import { HttpError } from './auth.js';

const RECORD = 'the body must be a JSON record of named fields';
const STATES = ['open', 'cleared'];
// How long a notice lasts from its receipt: 90 times 24 hours, fixed; no setting changes it.
const LASTS_MS = 90 * 24 * 60 * 60 * 1000;

function isText(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// What a JSON value that is not a record is called in the refusal.
function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'string') return 'a text';
  if (typeof v === 'number') return 'a number';
  return 'a boolean';
}

// The state as the refusal names it: the text as sent, `nothing` when absent, its JSON form otherwise.
function shown(body) {
  if (!Object.hasOwn(body, 'state')) return 'nothing';
  return typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
}

// Returns the parsed record, else throws the 400 naming every failed part, in the order item, state, what.
export function test(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, RECORD);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, `${RECORD}; got ${kindOf(body)}`);
  }
  const failed = [];
  if (!isText(Object.hasOwn(body, 'item') ? body.item : undefined)) failed.push("item must be a non-empty text, the item's reference");
  if (!Object.hasOwn(body, 'state') || !STATES.includes(body.state)) failed.push(`state must be open or cleared; got ${shown(body)}`);
  if (!isText(Object.hasOwn(body, 'what') ? body.what : undefined)) failed.push('what must be a non-empty text');
  if (failed.length) throw new HttpError(400, failed.join('; '));
  return body;
}

// Keeps the notice as its own row under the sending token's row, the body's text as received; answers that it was kept
// and nothing else (the row's id is given out nowhere). Then the clean-up: every notice of any token received more than
// 90 days before this one is deleted; a failed delete costs the notice nothing. The parsed record follows the answer,
// for the caller's passing-on; it is never sent back.
export function keep(db, text, tokenId) {
  const body = test(text);
  const now = Date.now();
  db.prepare('INSERT INTO notices (id, item, state, what, body, received, token_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), body.item, body.state, body.what, text, new Date(now).toISOString(), tokenId);
  try {
    db.prepare('DELETE FROM notices WHERE received < ?').run(new Date(now - LASTS_MS).toISOString());
  } catch {
    // the old notices stay until the next notice is kept; this one is kept and answered
  }
  return [201, { kept: true }, body];
}

// The calling token's notices for the reference, matched exactly, newest received first, the later-inserted first in
// one instant. Answers the JSON list as text, built from the stored bodies themselves, so each comes back whole as sent.
export function readStatus(db, url, tokenId) {
  const item = url.searchParams.get('item');
  if (!item) throw new HttpError(400, "item is required: the item's reference");
  const rows = db.prepare('SELECT body FROM notices WHERE item = ? AND token_id = ? ORDER BY received DESC, rowid DESC').all(item, tokenId);
  return [200, `[${rows.map((row) => row.body).join(',')}]`];
}
