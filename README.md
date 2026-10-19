# externality-tracker

A small service that records and tracks externalities: things that must happen out of band before a road plans item can complete. Node 24, zero dependencies, `node:http` and `node:sqlite`.

road plans: nethub/roadwork of the BAA Workspace (temporary authority)

## Run

```
ORG_SLUG=acme EXTERNALITY_KEY=<key> npm start
npm test
```

The server binds `0.0.0.0` on `PORT` (default 3000). It refuses to start when `ORG_SLUG` or `EXTERNALITY_KEY` is empty.

## Environment

- `ORG_SLUG` — the one org this instance serves.
- `EXTERNALITY_KEY` — the static key for that org.

## Volume

The database is `${DATA_DIR}/externalities.sqlite`. `DATA_DIR` is read from the `DATA_DIR` variable, else `RAILWAY_VOLUME_MOUNT_PATH`, else `./data` (made if missing). On Railway, mount a volume (for example at `/data`) and set `DATA_DIR=/data` so records survive a redeploy.

## Call values

Every call carries four values, each by header or by URL parameter. Where both are set, the header wins.

| Value | Header | URL parameter |
|---|---|---|
| org slug | `X-Org-Slug` | `org-slug` |
| atlas slug (free text; `none` for an item under no atlas) | `X-Atlas-Slug` | `atlas-slug` |
| item slug | `X-Item-Slug` | `item-slug` |
| key | `X-Externality-Key` | `externality-key` |
| consumer token | `X-Consumer-Token` | `consumer-token` |

Each route reads one credential and ignores the other: `POST /add` and `POST /tokens` read the org key (`X-Externality-Key`), while `GET /status`, `POST /update` and `GET /inventory` read a consumer token (`X-Consumer-Token`, 401 `consumer token is required` without one), on which the org slug is optional but must match `ORG_SLUG` when sent.

A missing or wrong key, or an org slug other than `ORG_SLUG`, is refused with 401 and `{"error": "<reason>"}`.

## Endpoints

JSON in and out. Errors are `{"error": "<reason>"}`: 400 for a bad body or a missing field, 401 for a refused key or org, 404 for an unknown id, route or method.

- `POST /add` — body `{"what", "who-acts", "how-observed"}`, all non-empty strings; atlas and item slugs required. Returns 201 `{"id", "record"}`, state `open`.
- `POST /tokens` — org key; body `{"scope", "url"?}`: `scope` is `all` or a comma-delineated list of atlas slugs (entries trimmed, duplicates dropped), and the token sees and changes only records whose atlas is in it, any other answering as absent; `url`, optional, an absolute http or https URL stored as given; returns 201 `{"token", "scope", "url", "date"}`.
- `POST /update` — body `{"id"}` plus at least one of `what`, `who-acts`, `how-observed`, `state` (`open` | `cleared`), `cleared-words`. Clearing requires `cleared-words` and sets `cleared-date`; reopening empties both. The record must match the call's atlas and item slugs. Returns 200 `{"record"}`.
- `GET /status?id=<id>` — atlas and item slugs required and matching. Returns 200 `{"record"}`.
- `GET /inventory` — atlas and item slugs optional (none, either or both narrow the list); optional `state=open|cleared`; optional `q`, a case-insensitive substring of `what`, `who-acts` or `how-observed`, `%` and `_` matched literally, empty refused with 400. Returns 200 `{"records": [...]}`, newest `set-date` first, ties by id.
- `GET /` — no key; `{"ok": true, "service": "externality-tracker", "node", "started"}`.

A record has exactly these fields: `id`, `org-slug`, `atlas-slug`, `item-slug`, `what`, `who-acts`, `how-observed`, `state`, `set-date`, `cleared-date`, `cleared-words`. Dates are ISO 8601 UTC; the last two are `null` while the record is open.
