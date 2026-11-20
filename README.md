# externality-tracker

A small notice system for externalities: things that must happen out of band before a road plans item can complete. Roadwork tells the service, by a notice, when such a wait opens and when it clears, and reads back what it was told. The service accumulates notices and closes nothing: it keeps each notice as sent, for 90 days, and leaves what they mean to the agent that reads them. Node 24, zero dependencies, `node:http` and `node:sqlite`.

road plans: corhub/nexus/roadwork of the project `nexus-roadwork`

## Run

```
ORG_SLUG=acme ADMIN_TOKEN=<admin token> npm start
npm test
```

The server binds `0.0.0.0` on `PORT` (default 3000). It refuses to start when `ORG_SLUG` is empty or `ADMIN_TOKEN` is unset or malformed.

## Environment

- `ORG_SLUG` — the one org this instance serves.
- `ADMIN_TOKEN` — required; the admin token, which opens the two admin endpoints `POST /emails` and `POST /emails/active` and nothing else. Letters, digits, `-` and `_` only, 32 characters or more (a 32-byte base64url value qualifies); unset or any other value refuses the start.
- `ADDRESS_KEY` — optional; the hard-to-guess part of the two open addresses (see "Open addresses").
- `THIRDPARTY_ALLOW` — optional; addresses and networks exempt from the guard (see "The guard").
- `DELIVERY_TIMEOUT_MS` — optional; the timeout of each forwarding and passing-on, a positive integer of milliseconds (default 10 seconds).

No email address is ever a setting: the list of authorized emails lives in the database and changes only through the two admin endpoints. No setting changes how long a notice lasts.

## Volume

The database is `${DATA_DIR}/externalities.sqlite`. `DATA_DIR` is read from the `DATA_DIR` variable, else `RAILWAY_VOLUME_MOUNT_PATH`, else `./data` (made if missing). On Railway, mount a volume (for example at `/data`) and set `DATA_DIR=/data` so notices survive a redeploy.

The service once had a second store, the table `externalities`, filled by older calls that are now gone. The first start on a database that still holds that table drops it and everything in it, for good, keeps no copy, and writes one line to the log: `externality-tracker: dropped old table externalities`. The notices, the tokens, the email list and the third-party outcome stay as they were. No later start writes that line or drops anything.

The first start on a database made before tokens belonged to email addresses (known by an `externalities` or `notices` table without `token_id`, or a `tokens` table without the new columns) drops the tables `externalities`, `notices` and `tokens` in one transaction, makes `notices` and `tokens` new and empty, leaves the third-party outcome as it is, and writes one line to the log: `externality-tracker: dropped old tables externalities, notices, tokens`. That start writes no second line, and no later start drops anything.

## Call values

A call carries up to two values. The org slug travels by header or by URL parameter; where both are set, the header wins. The credential travels by header only; no credential is read from a URL parameter.

| Value | Header | URL parameter |
|---|---|---|
| org slug (optional; must be `ORG_SLUG` when sent) | `X-Org-Slug` | `org-slug` |
| token | `Authorization: Bearer <token>` | — |

No other call value is read: a header or parameter naming an atlas or an item is ignored. A notice's own fields, `item` and `atlas` among them, are kept as sent.

Three kinds of call:

- `POST /tokens`, under the limit on asking: a first ask for an address carries no credential; a later ask carries that address's current token as `Authorization: Bearer <token>` (see "Tokens and the email list").
- `POST /emails` and `POST /emails/active` want the admin token as `Authorization: Bearer <admin token>`, checked before anything else: 401 `admin token is required` without a bearer, 401 `wrong admin token` for any other value, a holder's token included.
- `GET /token`, `GET /thirdparty` and both open addresses want a holder's token as `Authorization: Bearer <token>` (the scheme in any case): 401 `token is required` without one, 401 `unknown token` for a value that is no token of an active authorized email, the admin token included. An org slug other than `ORG_SLUG` is refused with 401 `org slug does not match`.

`GET /` needs no credential.

## Tokens and the email list

A token belongs to one email address. An address may ask when it is on the list of authorized emails and active, or when it is a variation of one: the authorized address with a `+` and any text, even none, before its `@` (`jo+work@example.org` and `jo+@example.org` are variations of `jo@example.org`). A variation needs no listing of its own, and there is no cap on how many an authorized address may have. Each asking address, the authorized form or a variation, has its own token and its own notices: no token reads another's.

The first ask for an address carries no credential and makes its token. The first ask stays open: anyone who knows an authorized address that has never asked can be handed its first token. A later ask, for an address that already has a token, carries that address's current token as `Authorization: Bearer <token>` and returns a new token. The old token stops working at once; the address's notices, forwarding address and last delivery outcome pass to the new one. A later ask with no token, a malformed header or any other value (another address's token, a variation's, the admin token, an old token) gets the same 401 `{"error": "refused"}` as an unknown address, and nothing changes.

**A support ticket.** A holder who has lost the current token, or never received the new one, raises a support ticket: an issue on the service's GitHub repository, `2ndcortex-labs/externality-tracker` (https://github.com/2ndcortex-labs/externality-tracker/issues). Issues there are public, so a ticket names no token, current or old. The service itself offers no other way back.

Addresses are trimmed and lowered before they are stored or matched. An authorized address has one `@`, text on both sides, no space and no `+`.

Deactivating an authorized email refuses its token, its asks and those of all its variations at once, with no restart; activating it again brings back the same tokens and their notices. No route deletes an email, and nothing is ever sent to an address.

**The forwarding address.** An ask may name a forwarding address, `url`, stored with that address's token. A later ask, bearing the current token, that names another URL replaces it; one naming none leaves it, and one naming `null` clears it. Every accepted ask answers with `url` as it now stands, `null` where none is stored. Every notice the token sends is posted on to its forwarding address (see "The forwarding").

**The limit on asking.** One caller gets 5 posts to `POST /tokens` a minute and the whole service 60; a further post answers 429 `{"error": "too many asks"}`. Every post counts toward the service's count, whatever its answer, and toward its caller's unless the service's count already refuses it. The caller is the header `X-Real-IP`, else the connection's own address. A count starts at a key's first post and ends one minute later; counts live in memory and are lost at a restart.

## Endpoints

JSON in and out. Errors are `{"error": "<reason>"}`: 400 for a bad body or a missing field, 401 for a refused credential, ask or org, 404 for an unknown address, route or method, 429 over the limit on asking. A route the service does not have answers 404 `{"error": "not found"}`, token or none.

- `POST /tokens` — a first ask needs no credential; a later ask wants the address's current token as `Authorization: Bearer <token>`; body `{"email", "url"?}`. The checks, in order: the limit, then the body (`email` a non-empty text; `url`, when present, an absolute http or https URL or `null`; anything else 400), then the address, then, on a later ask, the token. Accepted, first ask: 201 `{"token", "url", "date"}`, a bearer token sent with it not read; later ask: 200 with the same three fields, `token` new and `url` as it now stands, the old token refused from then on. `token` is 32 random bytes written base64url; `date` is the instant it was made; `url` is `null` where none is stored. Any field but `email` and `url` is ignored. An address not on the list, a deactivated one, the variations of either, and a later ask without the address's current token all get the one answer 401 `{"error": "refused"}`, and nothing changes.
- `POST /emails` — admin token; body `{"email"}`, any other field ignored. A new address answers 201 `{"email", "active": true}`; a known one answers 200 with its row as it stands, `{"email", "active"}`, and nothing changes. A malformed address answers 400.
- `POST /emails/active` — admin token; body `{"email", "active": true | false}`. Answers 200 `{"email", "active"}`; an unknown address answers 404, a malformed one or an `active` that is not `true` or `false` 400.
- `GET /token` — token; the token's own record: returns 200 `{"url", "date", "last-delivery-date", "last-delivery-status"}`, the last two `null` until a forwarding has been attempted; the token value is never returned.
- `GET /thirdparty` — token, any valid one; the latest outcome of the passing-on to a third party, one for the whole service (see "The passing-on"): returns 200 `{"last-delivery-date", "last-delivery-status"}`, both `null` until an attempt has settled.
- `GET /` — no credential; `{"ok": true, "service": "externality-tracker", "node", "started"}`.
- `POST /<part>/notify` and `GET /<part>/status?item=<reference>` — see "Open addresses".

For example, with made-up values:

```
curl -X POST https://<service>/emails -H 'Authorization: Bearer <admin token>' -d '{"email": "jo@example.org"}'
curl -X POST https://<service>/tokens -d '{"email": "jo+roadwork@example.org", "url": "https://hooks.example.org/in"}'
curl https://<service>/token -H 'Authorization: Bearer <token>'
```

## Open addresses

Two addresses take a road plans notice as it is sent and answer a status read by an item's reference, in the terms of Roadwork's constitution ("Externalities and their notices"). The notice is the one way in.

- `POST /<part>/notify` — the notice address, Roadwork's `notify-url`.
- `GET /<part>/status?item=<reference>` — the status address, Roadwork's `status-url`.

`<part>` is the value of `ADDRESS_KEY`. The owner chooses it and hands the two addresses to the project; there is one part per running service, and setting a new one and restarting changes both addresses together. `ADDRESS_KEY` unset or empty: the service starts and neither address exists. Set, it must be letters, digits, `-` and `_` only, 32 characters or more (a UUID or a 32-byte base64url value both qualify); any other value refuses the start, as an empty `ORG_SLUG` does.

**Both addresses want a holder's token** as `Authorization: Bearer <token>`, Roadwork's `notify-token` and `status-token`, beside the part. A wrong part, a part while `ADDRESS_KEY` is unset, or another method at the right part answers exactly as an unknown route, token or none: 404 `{"error": "not found"}`. The right part without a valid token answers 401, as any token route does. Each notice belongs to the token that sent it, and a status read returns the calling token's notices only.

### The notice

A post is taken when it passes this test, and only then:

- the body is a JSON record of named fields;
- its `item` is a text that is not empty once trimmed — the item's reference, `<kind>/<item-name>`;
- its `state` is exactly `open` or `cleared`, in lower case;
- its `what` is a text that is not empty once trimmed.

Nothing else is checked, and every field is kept as sent, the nine fields of Roadwork's notice and any others. Each notice that passes is kept as a notice of its own; an opening and a closing notice for one externality are two notices, and none replaces or changes another. The service matches, merges, sorts and closes nothing by `what` or by state: it accumulates notices, and the agent that reads them sorts out what they mean. A kept notice answers 201 `{"kept": true}` and nothing more; no id is given out. The 1 MB body limit applies (400 `body too large`).

A refused post answers 400 `{"error": "<message>"}`, one message naming each failed part, joined by `; ` in the order item, state, what:

- `the body must be a JSON record of named fields` — a blank body, or one that is not JSON.
- `the body must be a JSON record of named fields; got a list` — and likewise `; got a text`, `; got a number`, `; got a boolean`, `; got null`.
- `item must be a non-empty text, the item's reference`
- `state must be open or cleared; got <value>` — the value as sent where it is a text, `nothing` where the field is absent, its JSON form otherwise.
- `what must be a non-empty text`

For example, a record with no `item` and a `state` of `done` answers `item must be a non-empty text, the item's reference; state must be open or cleared; got done`.

### The status read

`item`, URL-decoded, is matched to the `item` of each notice the calling token kept, exactly, case and spaces included. The answer is 200 with a JSON list of those notices for that reference, each whole as it was sent, newest received first (notices received in the same instant: the later one first). A reference with no notice answers 200 `[]`. Several notices may carry one externality's `what`; the newest tells its state. A missing or empty `item` answers 400 `{"error": "item is required: the item's reference"}`.

### 90 days

A notice lasts 90 days from the moment the service received it; the dates inside the notice are the sender's and are not used. Each time a notice is kept, every notice in the service received more than 90 days (90 times 24 hours) before that moment is deleted, whichever token sent it. A notice received 90 days ago or less stays. Nothing else deletes a notice: no other call starts a clean-up, so on a quiet service old notices stay until the next notice is kept. A clean-up that fails costs the arriving notice nothing; it is still kept and answered 201.

So a wait open longer than 90 days loses its opening notice: a status read then shows no notice for it, which Roadwork reads as still open. Roadwork's own files keep the wait.

### The forwarding

After a notice is kept and answered 201, it is posted on to the forwarding address stored with the token that sent it, and to no other token's: every notice, opened and cleared alike.

- one `POST` of the notice's text exactly as received, `content-type: application/json`, no authorization header and no other credential, whatever the notice's own post carried;
- once, with no retry, under the delivery timeout (10 seconds by default, `DELIVERY_TIMEOUT_MS` the override); a redirect is not followed — the 3xx answer is the outcome, and nothing more is sent;
- behind the guard (see "The guard"); a forwarding address the guard refuses, or one with a user or password in it, is sent nothing.

A token with no forwarding address receives nothing. The outcome of each attempt is stored on the sending token, the latest only: `last-delivery-date`, the instant the attempt started (ISO 8601 UTC), and `last-delivery-status`, the HTTP status of the answer, 0 when none came (a refused address, a name that does not resolve, a refused connection, a timeout). `GET /token` reads it; it is the holder's one way to learn whether the third party was reached.

Neither the keeping of the notice nor its answer waits on the forwarding address; a slow, failing or absent one changes neither.

### The passing-on

A notice may also name a third party of its own: the field `3rdparty-notice-url`, which Roadwork puts in its notice when the project sets the key `3rdparty-notice-url` in Roadwork's settings. This is the quiet way, for occasional use. After the notice is kept and answered 201, the service reads that field of the notice and posts the notice on to it, opened and cleared alike:

- one `POST` of the notice's text exactly as received, `content-type: application/json`, no authorization header and no other credential, whatever the notice's own post carried;
- to a web address only: an absolute `http` or `https` URL, any port, with no user or password in it; anything else (no field, an `ftp://` address, a bare word, a URL with a user) is no address, and nothing is sent;
- once, with no retry, under the delivery timeout; a redirect is not followed — the 3xx answer is the outcome, and nothing more is sent;
- behind the guard; a refused address is handled as no address: nothing is sent and no outcome is kept.

A notice that names a third party, sent under a token with a forwarding address, is posted to both, each on its own: the failure of one changes nothing for the other. Neither the answer to the notice nor its keeping waits on the third party.

**The loop guard.** Every post the service makes, forwarding or passing-on, carries the header `x-externality-passed-on: 1`. A notice that arrives carrying `x-externality-passed-on`, whatever its value, is kept and answered as any other but is neither forwarded nor passed on, so two tokens that forward to each other's notice address cannot post without end. Since a post carries no token, a notice naming this service's own notice address is posted there once and refused with 401; nothing further is sent.

**The outcome of the passing-on.** The service keeps one outcome for all third-party posts, the latest only: `last-delivery-date`, the instant the attempt started (ISO 8601 UTC), and `last-delivery-status`, the HTTP status of the answer, 0 when none came (a name that does not resolve, a refused connection, a timeout). Each attempt writes it as it settles, and the last to settle is kept. Any holder reads it with `GET /thirdparty` under a valid token (401 without one); both fields are `null` until an attempt has settled. The forwarding never writes it.

### The guard

The forwarding and the passing-on share one guard. The service refuses the ranges listed below and the addresses of the machine's own network interfaces, read at start; an address the machine is reached at only through an outside translator or proxy (a public address mapped onto it by a router or a cloud) is not known to it and is not refused. An address given in the URL is checked as it stands; a host name is resolved once, for all its addresses, before anything is sent, and is refused when any one of them is refused; the post then connects only to the addresses that were checked. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is checked as its IPv4 address. The refused ranges:

- IPv4: `0.0.0.0/8` (this network), `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16` (private networks), `100.64.0.0/10` (shared carrier space), `127.0.0.0/8` (this machine), `169.254.0.0/16` (link-local, cloud metadata among it), `224.0.0.0/4` (multicast);
- IPv6: `::/128` (unspecified), `::1/128` (this machine), `fc00::/7` (private), `fe80::/10` (link-local), `ff00::/8` (multicast), `64:ff9b::/96` and `64:ff9b:1::/48` (IPv4 translation).

A refused forwarding address is sent nothing, and its token's outcome is status 0 with the attempt's time. A refused third-party address is sent nothing, and no outcome is kept. The guard is a deny list: it removes the inside addresses, and it is not full protection — anyone who holds a token can name any outside address as a forwarding address, and anyone who holds a token and the notice address can name one as a third party.

`THIRDPARTY_ALLOW` exempts addresses from the guard, for an owner whose forwarding address or third party sits on a private network. It is read at start: comma-separated entries, each trimmed, each an IPv4 or IPv6 address or a CIDR subnet (`10.1.2.3`, `10.1.0.0/16`, `fd00::/8`); a host name is not an entry. Unset or empty, nothing is exempt. Any other value refuses the start, naming `THIRDPARTY_ALLOW`, as a bad `ADDRESS_KEY` does. An exempt address, given or resolved, passes the guard; it must still be a web address.
