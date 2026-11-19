# externality-tracker

A small service that records and tracks externalities: things that must happen out of band before a road plans item can complete. Node 24, zero dependencies, `node:http` and `node:sqlite`.

road plans: corhub/nexus/roadwork of the project `nexus-roadwork`

## Run

```
ORG_SLUG=acme EXTERNALITY_KEY=<key> npm start
npm test
```

The server binds `0.0.0.0` on `PORT` (default 3000). It refuses to start when `ORG_SLUG` or `EXTERNALITY_KEY` is empty.

## Environment

- `ORG_SLUG` — the one org this instance serves.
- `EXTERNALITY_KEY` — the static key for that org.
- `ADDRESS_KEY` — optional; the hard-to-guess part of the two open addresses (see "Open addresses").
- `THIRDPARTY_ALLOW` — optional; addresses and networks exempt from the third-party guard (see "The passing-on").

## Volume

The database is `${DATA_DIR}/externalities.sqlite`. `DATA_DIR` is read from the `DATA_DIR` variable, else `RAILWAY_VOLUME_MOUNT_PATH`, else `./data` (made if missing). On Railway, mount a volume (for example at `/data`) and set `DATA_DIR=/data` so records survive a redeploy.

## Call values

Every call carries five values. The three slugs travel by header or by URL parameter; where both are set, the header wins. The two credentials travel by header only; no credential is read from a URL parameter.

| Value | Header | URL parameter |
|---|---|---|
| org slug | `X-Org-Slug` | `org-slug` |
| atlas slug (free text; `none` for an item under no atlas) | `X-Atlas-Slug` | `atlas-slug` |
| item slug | `X-Item-Slug` | `item-slug` |
| key | `Authorization: Bearer <key>` | — |
| consumer token | `X-Consumer-Token` | — |

Each route reads one credential and ignores the other: `POST /add`, `POST /tokens` and `GET /thirdparty` read the org key (`Authorization: Bearer <key>`, the scheme in any case), while `GET /status`, `POST /update`, `GET /inventory` and `GET /token` read a consumer token (`X-Consumer-Token`, 401 `consumer token is required` without one), on which the org slug is optional but must match `ORG_SLUG` when sent.

A missing or wrong key, or an org slug other than `ORG_SLUG`, is refused with 401 and `{"error": "<reason>"}`.

## Endpoints

JSON in and out. Errors are `{"error": "<reason>"}`: 400 for a bad body or a missing field, 401 for a refused key or org, 404 for an unknown id, route or method.

- `POST /add` — body `{"what", "who-acts", "how-observed"}`, all non-empty strings; atlas and item slugs required. Returns 201 `{"id", "record"}`, state `open`.
- `POST /tokens` — org key; body `{"scope", "url"?}`: `scope` is `all` or a comma-delineated list of atlas slugs (entries trimmed, duplicates dropped), and the token sees and changes only records whose atlas is in it, any other answering as absent; `url`, optional, an absolute http or https URL stored as given; returns 201 `{"token", "scope", "url", "date"}`.
- `POST /update` — body `{"id"}` plus at least one of `what`, `who-acts`, `how-observed`, `state` (`open` | `cleared`), `cleared-words`. Clearing requires `cleared-words` and sets `cleared-date`; reopening empties both. The record must match the call's atlas and item slugs. Returns 200 `{"record"}`.
- `GET /status?id=<id>` — atlas and item slugs required and matching. Returns 200 `{"record"}`.
- `GET /inventory` — atlas and item slugs optional (none, either or both narrow the list); optional `state=open|cleared`; optional `q`, a case-insensitive substring of `what`, `who-acts` or `how-observed`, `%` and `_` matched literally, empty refused with 400. Returns 200 `{"records": [...]}`, newest `set-date` first, ties by id.
- `GET /token` — consumer token; the token's own record: returns 200 `{"scope", "url", "date", "last-delivery-date", "last-delivery-status"}`, the last two `null` until a delivery has settled; the token value is never returned.
- `GET /thirdparty` — org key; the latest outcome of the passing-on to a third party (see "The passing-on"): returns 200 `{"last-delivery-date", "last-delivery-status"}`, both `null` until an attempt has settled.
- `GET /` — no key; `{"ok": true, "service": "externality-tracker", "node", "started"}`.

After an add answers 201, the record is POSTed once as JSON (`content-type: application/json`, the same record inventory returns, no auth header) to the URL of every token whose scope covers its atlas; a token without a URL receives nothing, and updates are not re-sent. No retry: one attempt per token per add, each under a timeout of 10 seconds by default, `DELIVERY_TIMEOUT_MS` (a positive integer of milliseconds) the override. The outcome is stored on the token, the latest only: `last-delivery-date`, the instant the attempt started, and `last-delivery-status`, the HTTP status, 0 when no response came; `GET /token` reads it.

A record has exactly these fields: `id`, `org-slug`, `atlas-slug`, `item-slug`, `what`, `who-acts`, `how-observed`, `state`, `set-date`, `cleared-date`, `cleared-words`. Dates are ISO 8601 UTC; the last two are `null` while the record is open.

## Open addresses

Two addresses take a road plans notice as it is sent and answer a status read by an item's reference, in the terms of Roadwork's constitution ("Externalities and their notices"):

- `POST /<part>/notify` — the notice address, Roadwork's `notify-url`.
- `GET /<part>/status?item=<reference>` — the status address, Roadwork's `status-url`.

`<part>` is the value of `ADDRESS_KEY`. The owner chooses it and hands the two addresses to the project; there is one part per running service, and setting a new one and restarting changes both addresses together. `ADDRESS_KEY` unset or empty: the service starts as before and neither address exists. Set, it must be letters, digits, `-` and `_` only, 32 characters or more (a UUID or a 32-byte base64url value both qualify); any other value refuses the start, as an empty `ORG_SLUG` does.

**The part is the only guard on these two addresses.** Neither checks a key or a token, and one sent with a call is ignored: anyone who has an address can post notices to it and read every notice through it. A wrong part, a part while `ADDRESS_KEY` is unset, or another method at the right part answers exactly as an unknown route: 404 `{"error": "not found"}`.

### The notice

A post is taken when it passes this test, and only then:

- the body is a JSON record of named fields;
- its `item` is a text that is not empty once trimmed — the item's reference, `<kind>/<item-name>`;
- its `state` is exactly `open` or `cleared`, in lower case;
- its `what` is a text that is not empty once trimmed.

Nothing else is checked, and every field is kept as sent, the nine fields of Roadwork's notice and any others. Each notice is kept as an entry of its own; an opened and a cleared notice for one externality are two entries, and none replaces another. A kept notice answers 201 `{"id": "<id>"}`; the id is given there and nowhere else. The 1 MB body limit applies (400 `body too large`). A notice taken here is not delivered to any token's URL, and is not a record of `POST /add`: it is never listed by `GET /inventory` or `GET /status`.

A refused post answers 400 `{"error": "<message>"}`, one message naming each failed part, joined by `; ` in the order item, state, what:

- `the body must be a JSON record of named fields` — a blank body, or one that is not JSON.
- `the body must be a JSON record of named fields; got a list` — and likewise `; got a text`, `; got a number`, `; got a boolean`, `; got null`.
- `item must be a non-empty text, the item's reference`
- `state must be open or cleared; got <value>` — the value as sent where it is a text, `nothing` where the field is absent, its JSON form otherwise.
- `what must be a non-empty text`

For example, a record with no `item` and a `state` of `done` answers `item must be a non-empty text, the item's reference; state must be open or cleared; got done`.

### The status read

`item`, URL-decoded, is matched to the `item` of each kept notice exactly, case and spaces included. The answer is 200 with a JSON list of the notices for that reference, each whole as it was sent, newest received first (notices received in the same instant: the later one first). A reference with no notice answers 200 `[]`. Several entries may carry one externality's `what`; the newest tells its state. A missing or empty `item` answers 400 `{"error": "item is required: the item's reference"}`.

Records added by `POST /add` stay where they are, listed by the routes that list them today; the status read never lists them.

### The passing-on

A notice may name a third party: the field `3rdparty-notice-url`, which Roadwork puts in its notice when the project sets the key `3rdparty-notice-url` in Roadwork's settings. After the notice is kept and answered 201, the service reads that field of the notice and posts the notice on to it, opened and cleared alike:

- one `POST` of the notice's text exactly as received, `content-type: application/json`, no authorization header and no other credential, whatever the notice's own post carried;
- to a web address only: an absolute `http` or `https` URL, any port, with no user or password in it; anything else (no field, an `ftp://` address, a bare word, a URL with a user) is no address, and nothing is sent;
- once, with no retry, under the delivery timeout (10 seconds by default, `DELIVERY_TIMEOUT_MS` the override); a redirect is not followed — the 3xx answer is the outcome, and nothing more is sent.

Neither the answer to the notice nor its keeping waits on the third party; a slow, failing or absent third party changes nothing about the notice. The passing-on is not token delivery: a notice still reaches no token's URL, and token delivery is as described under "Endpoints". Every post carries the header `x-externality-passed-on: 1`, and a notice that arrives carrying `x-externality-passed-on`, whatever its value, is kept and answered as any other but is not passed on a second time, so a notice naming this service's own notice address, or another such service, is posted once and no further.

**The guard.** The service refuses the ranges listed below and the addresses of the machine's own network interfaces, read at start; an address the machine is reached at only through an outside translator or proxy (a public address mapped onto it by a router or a cloud) is not known to it and is not refused. An address given in the URL is checked as it stands; a host name is resolved once, for all its addresses, before anything is sent, and is refused when any one of them is refused; the post then connects only to the addresses that were checked. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is checked as its IPv4 address. The refused ranges:

- IPv4: `0.0.0.0/8` (this network), `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16` (private networks), `100.64.0.0/10` (shared carrier space), `127.0.0.0/8` (this machine), `169.254.0.0/16` (link-local, cloud metadata among it), `224.0.0.0/4` (multicast);
- IPv6: `::/128` (unspecified), `::1/128` (this machine), `fc00::/7` (private), `fe80::/10` (link-local), `ff00::/8` (multicast), `64:ff9b::/96` and `64:ff9b:1::/48` (IPv4 translation).

A refused address is handled as no address: nothing is sent, no outcome is kept, and the notice is taken in as any other. The guard is a deny list: it removes the inside addresses, and it is not full protection — anyone who holds the notice address can still name any outside address as a third party.

`THIRDPARTY_ALLOW` exempts addresses from the guard, for an owner whose third party sits on a private network. It is read at start: comma-separated entries, each trimmed, each an IPv4 or IPv6 address or a CIDR subnet (`10.1.2.3`, `10.1.0.0/16`, `fd00::/8`); a host name is not an entry. Unset or empty, nothing is exempt. Any other value refuses the start, naming `THIRDPARTY_ALLOW`, as a bad `ADDRESS_KEY` does. An exempt address, given or resolved, passes the guard; it must still be a web address.

**The outcome.** The service keeps one outcome for all third-party posts, the latest only: `last-delivery-date`, the instant the attempt started (ISO 8601 UTC), and `last-delivery-status`, the HTTP status of the answer, 0 when none came (a name that does not resolve, a refused connection, a timeout). Each attempt writes it as it settles, and the last to settle is kept. The owner reads it with `GET /thirdparty` under the org key (`X-Org-Slug` and `Authorization: Bearer <key>`, 401 without them, as `POST /add`); both fields are `null` until an attempt has settled.
