# ATools private sync server

This is an optional, separately deployed service. It is not part of desktop
startup and does not open the desktop `~/.atools` database. Its default SQLite
file is `data/standalone/ztools.db`; `SQLITE_PATH` can select another dedicated
file. The service uses SQLite WAL and rejects paths under the desktop
`~/.atools` data tree.

The server implements a first stateful ZTools sync slice based on the pinned
protocol source at commit
`8ae1e14fd1071b6762fdb59f05162bc0779a5564`:

- `GET /`, `GET /health`, `POST /api/auth`, `POST /api/login`,
  `POST /api/auth/refresh`, `GET /api/auth/captcha-config`, and optional
  `POST /api/register`;
- WebSocket sync at `/ws` and `/`, with access-token authentication, `ping`,
  document `push`/incremental `pull`, explicit `snapshot` pull, tombstones, and
  per-user checkpoint read/write;
- bcrypt password hashes, HS256 access tokens, and single-use random refresh
  tokens stored only as SHA-256 hashes.

Incoming WebSocket messages are capped at 16 MiB. A serialized change entry
including its metadata is capped at 2 MiB; one push accepts at most 128 entries
and 8 MiB total serialized change data, and one pull response is capped at 16 MiB.
Explicit snapshots are limited to 4,096 current documents and 16 MiB. These
limits keep this first implementation's materialized JSON responses bounded;
they are stricter than the upstream Go server's streaming pull path.

Resource admission is fail-fast: at most 16 WebSocket connections are admitted
including unauthenticated sockets; up to 4 authentication/bcrypt operations, 1
push, 4 pulls, and 8 checkpoint database operations can run concurrently. Auth,
push, pull, checkpoint, and startup SQLite/bcrypt work runs on Tokio's blocking
pool, with each permit retained until the blocking operation actually finishes
even if its request is cancelled. Full capacity returns HTTP 503 or a fixed
WebSocket error; work is not queued without a bound. The single SQLite
connection still serializes actual SQL execution. A push is one atomic SQLite
transaction and is limited to 128 change entries, compared with upstream's
20-entry transaction chunking.

The server reports capabilities explicitly in `auth_ok`. `documentSync`,
`tombstones`, `checkpoints`, and explicit `snapshotPull` are enabled.
`revisionRetention`, `attachments`, automatic snapshot thresholds, and live
change broadcasts are disabled. Pushes containing attachment metadata,
conflict/winner metadata, unknown change fields, or multi-revision history are
rejected before any document write. A document starts at `1-<hash>` without a
parent; later updates must supply the exact current `parentRev` and advance the
generation by one. Identical revision retries are idempotent; branch, backfill,
missing-parent, and changed-content retries are rejected atomically. Empty
revisions are rejected rather than treated as successful no-ops. These are
deliberate restrictions of this slice. The storage model keeps one current
revision per document plus an append-only sync
changelog; it does not implement ZTools conflict trees, revision-history
retention, attachment routes, or compaction. Clients that require those paths
must not treat this service as a full protocol-2 implementation.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DATA_DIR` | `data/standalone` | Dedicated sync-server directory. |
| `SQLITE_PATH` | `$DATA_DIR/ztools.db` | Must not point to the desktop ATools database. |
| `DB_DRIVER` | `sqlite` | Other values are rejected; MySQL is not implemented. |
| `PORT` | `23517` | TCP port. |
| `BIND_ADDRESS` | `0.0.0.0` | Upstream-compatible all-interface default; set `127.0.0.1` for local-only use. |
| `JWT_SECRET` | generated and persisted in `$DATA_DIR/server-secret` | At least 32 bytes. The file is created with owner-only permissions on Unix. |
| `ALLOW_REGISTRATION` | `false` | Go `ParseBool` spellings only; when enabled, `/api/auth` creates missing accounts and `/api/register` is mounted. |
| `ZTOOLS_USERNAME` / `ZTOOLS_PASSWORD` | unset | Optional bootstrap owner; configure both or neither. |

The service does not terminate TLS. Do not expose it outside a trusted private
network without a TLS-terminating proxy and deployment-specific access controls.

## Verification scope

The crate includes private temporary-database and loopback WebSocket tests for
authentication/refresh, user isolation, document round trips, tombstones,
reconnect sequence retention, snapshots, and checkpoint persistence. Passing
these tests establishes only this implemented subset; it does not establish
wire compatibility with every ZTools client. Golden tests against the pinned Go
server and separate migration acceptance remain required.
