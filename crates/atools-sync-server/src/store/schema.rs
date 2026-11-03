use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use crate::{new_server_identity, Store, StoreError};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    uid TEXT PRIMARY KEY NOT NULL,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS refresh_tokens_uid_idx ON refresh_tokens(uid);
CREATE TABLE IF NOT EXISTS documents (
    uid TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    doc_json TEXT NOT NULL,
    rev TEXT NOT NULL,
    parent_rev TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL,
    doc_type TEXT NOT NULL DEFAULT 'doc',
    protocol_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (uid, doc_id)
);
CREATE TABLE IF NOT EXISTS changelog (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    rev TEXT NOT NULL,
    parent_rev TEXT,
    deleted INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    doc_json TEXT NOT NULL,
    doc_type TEXT NOT NULL DEFAULT 'doc',
    protocol_version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(uid, doc_id, rev)
);
CREATE INDEX IF NOT EXISTS changelog_uid_seq_idx ON changelog(uid, seq);
CREATE TABLE IF NOT EXISTS sync_checkpoints (
    uid TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (uid, checkpoint_id)
);
CREATE TABLE IF NOT EXISTS device_sync_state (
    uid TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL DEFAULT '',
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (uid, device_id)
);
CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
PRAGMA user_version = 1;
"#;

pub(super) fn initialize(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; \
         PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
    )?;
    connection.execute_batch(SCHEMA)?;
    Ok(())
}

pub(super) fn ensure_metadata(store: &Store) -> Result<(), StoreError> {
    let mut connection = store.lock()?;
    let tx = connection.transaction()?;
    let identity = tx
        .query_row(
            "SELECT value FROM sync_meta WHERE key='server_instance_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if identity.is_none() {
        tx.execute(
            "INSERT INTO sync_meta(key,value) VALUES('server_instance_id',?1)",
            [new_server_identity()],
        )?;
    }
    let epoch = tx
        .query_row(
            "SELECT value FROM sync_meta WHERE key='sync_epoch'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if epoch.is_none() {
        let max_seq: i64 =
            tx.query_row("SELECT COALESCE(MAX(seq),0) FROM changelog", [], |row| {
                row.get(0)
            })?;
        tx.execute(
            "INSERT INTO sync_meta(key,value) VALUES('sync_epoch',?1)",
            [max_seq.to_string()],
        )?;
    }
    tx.commit()?;
    Ok(())
}

impl Store {
    pub(crate) fn server_instance_id(&self) -> Result<String, StoreError> {
        self.lock()?
            .query_row(
                "SELECT value FROM sync_meta WHERE key='server_instance_id'",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }

    pub(crate) fn sync_epoch(&self) -> Result<i64, StoreError> {
        let value = self.lock()?.query_row(
            "SELECT value FROM sync_meta WHERE key='sync_epoch'",
            [],
            |row| row.get::<_, String>(0),
        )?;
        value
            .parse::<i64>()
            .map_err(|_| rusqlite::Error::InvalidQuery.into())
    }
}

pub(super) fn is_desktop_database(path: &Path) -> bool {
    crate::config::is_inside_desktop_data_tree(path)
}
