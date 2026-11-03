# ZTools Sync Server source contract

## Scope and evidence

This contract is pinned to `ZToolsCenter/ztools-sync-server` commit
`8ae1e14fd1071b6762fdb59f05162bc0779a5564` at
`.scratch/atools-replication/upstream/ztools-sync-server`. The checkout was
clean when inspected. The JSON file records source-relative paths, line ranges,
and SHA-256 hashes for each route, WebSocket event, schema table, and supporting
source file.

This is a static source extraction. No Go build, Go tests, server process, or
protocol client was run. The source has no semantic release version in
`go.mod`; the commit is the version identity. The project is licensed under
MPL-2.0. `go.mod` declares Go 1.23.

## Confirmed route inventory

It is **not** limited to `/health` and `/ws`. `transport/router.go:39-55`
registers the auth endpoints, conditional registration, two attachment route
families, health, and WebSocket. `Handler` also handles `/` as either a WebSocket
upgrade or JSON identity response (`router.go:57-71`). There is no REST document
push/pull or HTTP checkpoint endpoint in this standalone router: document sync
and checkpoints use WebSocket messages. REST attachment metadata/blob operations
are present.

The route and status/body details are in `transport.routes` in the JSON
contract. Application handlers return JSON `404` for wrong methods on their
known paths; unregistered paths fall through to Go `ServeMux`'s default 404.
Root and health handlers do not restrict the HTTP method. The JSON writer sets
`Content-Type: application/json` and uses Go's newline-terminated JSON encoder.
The request decoder has no application-level size limit.

## Auth and credentials

Standalone defaults to `ALLOW_REGISTRATION=false`. If the database has no user
and no `ZTOOLS_USERNAME`/`ZTOOLS_PASSWORD` bootstrap pair, process startup fails.
The public registration route is only mounted when registration is enabled.
`/api/auth` is login-only by default; with registration enabled it creates a
missing user and reports `isNew`.

Access JWTs are issued as HS256 with `uid`, `ver`, `exp`, and `iat`; their
lifetime is 48 hours. Refresh tokens are 32 random bytes encoded with raw
Base64URL, persisted as SHA-256 hashes, expire after 30 days, and rotate
single-use inside a transaction. Protected attachment routes parse the exact
`Authorization: Bearer ` prefix and resolve the token to a user.

The captcha-config endpoint returns `{"enabled":false}` and the current captcha
verifier is a no-op. Login/auth handlers do not return the same invalid-credential
text (`密码错误` for `/api/auth`, `Invalid credentials` for `/api/login`). Keep
these distinct if matching the observed HTTP contract.

## WebSocket protocol

The server protocol is version 2. The client sends JSON `ClientMessage` objects
with `type` and optional type-specific fields. The server emits `ServerMessage`
objects. Several fields (`serverSeq`, `protocolVersion`, `syncEpoch`, `changes`,
`seq`) are not tagged `omitempty`, so the Go encoder includes their zero/null
values even in messages that mainly use another payload field.

The event inventory, required fields, concrete success/error branches, and
source references are in `websocketProtocol.events` and its shared type blocks
in the JSON contract. Flow:

1. Upgrade `/ws` or root `/`; the origin callback accepts every origin.
2. The client sends `type=auth` with its token. The server gives it 30 seconds,
   stores device state, and returns `auth_ok` with `serverInstanceId`,
   `serverSeq`, protocol 2, `syncEpoch`, and feature flags.
3. `pull` streams `changes` with an outer `seq`. Pull generation has a five-minute
   deadline and aborts the socket if output is incomplete. The server does not
   advance a checkpoint when it streams; the client separately sends
   `put_checkpoint` after accepting the result.
4. `push` first checks referenced non-deleted document attachments. Missing
   blobs produce `push_missing` before revision writes. A successful empty push
   returns `push_ok` with `seq=0`. Non-empty changes commit in chunks of 20;
   already-committed chunk broadcasts are not rolled back if a later chunk
   fails.

The inbound message queue has capacity four. The application does not call
`SetReadLimit`; the Gorilla library's own default is outside this static
contract. A pre-auth request for pull/push/checkpoint returns an `error` message
and leaves the connection open; invalid auth and auth timeout send an error and
close it. A pull-generation error closes the connection without converting the
failure to an `error` event. `ping` returns `pong`, including before auth.

`auth_ok.features` currently reports `revisionRetention=true` and
`snapshotPull=true`. Automatic snapshots apply to protocol 2+ when an incremental
backlog exceeds 512 changes or 32 MiB, and only when a complete candidate
snapshot is no larger than 16 MiB and has no more documents than the delta.
Snapshots emit current leaf revisions (including tombstones and branches),
with the outer sequence captured before enumeration. The source also has a
legacy filter for protocol < 2 that skips changelog entries whose stored
protocol version is < 2; this is recorded as source behavior rather than
interpreted as a compatibility guarantee.

## Revisions, checkpoints, and attachments

`FullChangeEntry` carries `docId`, `rev`, optional `parentRev` and
`revisionHistory`, deletion flag, timestamp, raw JSON `doc`, winner metadata,
resolution, and protocol version. The server assigns changelog sequence values.
An empty revision string is silently ignored; there is no explicit `docId`
validation in the insertion path. Positive client timestamps are used, otherwise
server time in milliseconds. Deleted, empty, or JSON-null bodies persist as `{}`.
Duplicate revisions do not append a changelog row, although the source may
repair ancestry/projection metadata. Winner selection prefers non-deleted leaves
and compares parsed generation then revision text.

Checkpoint IDs are required and unique per user. If `lastSeq` is zero while
`remotePullSeq` is positive, the server copies that value into `lastSeq`;
otherwise source/target IDs are not validated at this service layer. `updatedAt`
is server Unix milliseconds. Missing checkpoint reads return an empty payload
with the requested ID. Checkpoints are stored separately from device
`last_seq`.

Attachment blobs are capped at 10 MiB and stored by `(uid,digest)`. The digest is
MD5 rendered as `md5-<lowercase hex>`; an upload with a supplied digest must
match its bytes. Content type defaults to `application/octet-stream`. Document
`_attachments` metadata becomes revision-scoped references and is emitted as
stubs during pull. A push with missing blobs returns sorted digests before any
revision write. The attachment list represents current winning revisions.

## Configuration and storage

Environment defaults are recorded individually in JSON. Important standalone
defaults are `PORT=23517`, `DATA_DIR=data/standalone`, `DB_DRIVER=sqlite`,
`SQLITE_PATH=$DATA_DIR/ztools.db`, and `ALLOW_REGISTRATION=false`. SQLite uses
WAL, 5-second busy timeout, foreign keys, `synchronous=NORMAL`, and one open/idle
connection. MySQL is also supported with its own migration set and bounded
connection pool. The process binds `:<port>` (all interfaces); TLS is not
terminated in this server.

The SQLite schema includes users/refresh tokens, document projection/revisions,
write locks, changelog, device sync state, attachment blobs/references, metadata,
and checkpoints, plus migration bookkeeping. Both SQLite and MySQL have V001
and V002 migrations; V002 adds `doc_json_bytes`. Model declarations for
`daily_activity` and `daily_activity_stats` are not in the standalone migration
set and should not be treated as standalone sync tables.

ATools currently uses SQLite for its local core, while this server defaults to
SQLite and also supports MySQL. Replacing this persistence with heed is not a
protocol-only change. Before such a substitution, require a migration/snapshot
acceptance that covers existing user data, revision branches, changelog order,
checkpoints, attachment bytes and references, reopen/recovery, and round-trip
equality. This contract does not prove that a heed store can reproduce SQL
transaction or query semantics.

## Axum implementation dependency order

The first standalone vertical slice can be implemented independently as
configuration + SQLite schema initialization + `GET /health` and `/` + login
and Bearer verification + WebSocket upgrade/auth/auth_ok. It must preserve the
wildcard bind decision only when explicitly intended by the caller; the source
default is all interfaces.

The next slice depends on the exact serialized message types, revision/changelog
transactions, per-user sequence lookup, streaming pull and snapshot rules,
checkpoint persistence, and the blob upload → `push_missing` → push cycle.
Passing this source contract is necessary but not sufficient: an Axum server
still needs golden request/response tests against the pinned Go server and
separate data migration evidence. No Go server or Rust server was run here.
