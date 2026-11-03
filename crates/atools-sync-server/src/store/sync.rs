use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;

use super::{Store, StoreError};
use crate::model::{CheckpointPayload, FullChangeEntry};

const MAX_CHANGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PUSH_BYTES: usize = 8 * 1024 * 1024;
const MAX_PUSH_CHANGES: usize = 128;
const MAX_PULL_BYTES: usize = 16 * 1024 * 1024;
const MAX_SNAPSHOT_DOCUMENTS: usize = 4096;

impl Store {
    pub(crate) fn push_changes(
        &self,
        uid: &str,
        device_id: &str,
        changes: &[FullChangeEntry],
        negotiated_version: i32,
    ) -> Result<i64, StoreError> {
        if changes.len() > MAX_PUSH_CHANGES {
            return Err(StoreError::PayloadTooLarge);
        }
        let mut push_bytes = 0_usize;
        for change in changes {
            validate_supported_change(change)?;
            let bytes = serde_json::to_vec(change)?.len();
            push_bytes = push_bytes
                .checked_add(bytes)
                .ok_or(StoreError::PayloadTooLarge)?;
            if bytes > MAX_CHANGE_BYTES || push_bytes > MAX_PUSH_BYTES {
                return Err(StoreError::PayloadTooLarge);
            }
        }
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let mut last_seq = 0_i64;
        for change in changes {
            if change.rev.trim().is_empty() {
                return Err(StoreError::MissingRevision);
            }
            let doc = if change.deleted || change.doc.is_null() {
                Value::Object(serde_json::Map::new())
            } else {
                change.doc.clone()
            };
            let doc_json = serde_json::to_string(&doc)?;
            let timestamp = if change.timestamp > 0 {
                change.timestamp
            } else {
                now_ms()
            };
            let protocol_version = change
                .protocol_version
                .filter(|version| *version > 0)
                .unwrap_or(negotiated_version);
            let existing = tx
                .query_row(
                    "SELECT seq,parent_rev,deleted,doc_json,doc_type,protocol_version FROM changelog WHERE uid=?1 AND doc_id=?2 AND rev=?3",
                    params![uid, change.doc_id, change.rev],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, i64>(2)? != 0,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i32>(5)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((seq, parent_rev, deleted, stored_doc, doc_type, stored_version)) = existing
            {
                if parent_rev != change.parent_rev
                    || deleted != change.deleted
                    || stored_doc != doc_json
                    || doc_type != change.doc_type.as_deref().unwrap_or("doc")
                    || stored_version != protocol_version
                {
                    return Err(StoreError::RevisionConflict(
                        "duplicate revision content differs",
                    ));
                }
                last_seq = last_seq.max(seq);
                continue;
            }
            let generation = revision_generation(&change.rev)?;
            let current = tx
                .query_row(
                    "SELECT rev FROM documents WHERE uid=?1 AND doc_id=?2",
                    params![uid, change.doc_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            match current {
                None if generation != 1 || change.parent_rev.is_some() => {
                    return Err(StoreError::RevisionConflict(
                        "first revision must be generation one without a parent",
                    ));
                }
                None => {}
                Some(current_rev) => {
                    let current_generation = revision_generation(&current_rev)?;
                    let next_generation = current_generation
                        .checked_add(1)
                        .ok_or(StoreError::RevisionConflict("revision generation overflow"))?;
                    if change.parent_rev.as_deref() != Some(current_rev.as_str()) {
                        return Err(StoreError::RevisionConflict(
                            "parent revision must match the current revision",
                        ));
                    }
                    if generation != next_generation {
                        return Err(StoreError::RevisionConflict(
                            "revision generation must advance by one",
                        ));
                    }
                }
            }
            tx.execute(
                "INSERT INTO changelog(uid,doc_id,rev,parent_rev,deleted,timestamp,doc_json,doc_type,protocol_version) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    uid,
                    change.doc_id,
                    change.rev,
                    change.parent_rev,
                    bool_to_i64(change.deleted),
                    timestamp,
                    doc_json,
                    change.doc_type.as_deref().unwrap_or("doc"),
                    protocol_version,
                ],
            )?;
            let seq = tx.last_insert_rowid();
            last_seq = seq;
            tx.execute(
                "INSERT INTO documents(uid,doc_id,doc_json,rev,parent_rev,deleted,timestamp,doc_type,protocol_version) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(uid,doc_id) DO UPDATE SET doc_json=excluded.doc_json,rev=excluded.rev,parent_rev=excluded.parent_rev,deleted=excluded.deleted,timestamp=excluded.timestamp,doc_type=excluded.doc_type,protocol_version=excluded.protocol_version",
                params![uid, change.doc_id, doc_json, change.rev, change.parent_rev, bool_to_i64(change.deleted), timestamp, change.doc_type.as_deref().unwrap_or("doc"), protocol_version],
            )?;
        }
        if last_seq > 0 {
            upsert_device_state(&tx, uid, device_id, "", last_seq)?;
        }
        tx.commit()?;
        Ok(last_seq)
    }

    pub(crate) fn pull_changes(
        &self,
        uid: &str,
        since: i64,
        snapshot: bool,
    ) -> Result<(Vec<FullChangeEntry>, i64), StoreError> {
        let connection = self.lock()?;
        if snapshot {
            let sequence = max_user_seq(&connection, uid)?;
            let mut statement = connection.prepare(
                "SELECT doc_id,rev,parent_rev,deleted,timestamp,doc_json,doc_type,protocol_version FROM documents WHERE uid=?1 ORDER BY doc_id LIMIT ?2",
            )?;
            let rows =
                statement.query_map(params![uid, MAX_SNAPSHOT_DOCUMENTS + 1], row_to_snapshot)?;
            let mut changes = Vec::new();
            let mut response_bytes = 0_usize;
            for row in rows {
                let change = row?;
                response_bytes = response_bytes
                    .checked_add(serde_json::to_vec(&change)?.len())
                    .ok_or(StoreError::SnapshotTooLarge)?;
                if response_bytes > MAX_PULL_BYTES || changes.len() >= MAX_SNAPSHOT_DOCUMENTS {
                    return Err(StoreError::SnapshotTooLarge);
                }
                changes.push(change);
            }
            return Ok((changes, sequence));
        }
        let mut statement = connection.prepare(
            "SELECT seq,doc_id,rev,parent_rev,deleted,timestamp,doc_json,doc_type,protocol_version FROM changelog WHERE uid=?1 AND seq>?2 ORDER BY seq LIMIT 128",
        )?;
        let rows = statement.query_map(params![uid, since], row_to_change)?;
        let mut changes = Vec::new();
        let mut sequence = since;
        let mut response_bytes = 0_usize;
        for row in rows {
            let change = row?;
            let bytes = serde_json::to_vec(&change)?.len();
            if response_bytes.saturating_add(bytes) > MAX_PULL_BYTES && !changes.is_empty() {
                break;
            }
            response_bytes += bytes;
            sequence = change.seq;
            changes.push(change);
        }
        Ok((changes, sequence))
    }

    pub(crate) fn upsert_checkpoint(
        &self,
        uid: &str,
        mut checkpoint: CheckpointPayload,
        sync_epoch: i64,
    ) -> Result<CheckpointPayload, StoreError> {
        if checkpoint.id.trim().is_empty() {
            return Err(StoreError::MissingCheckpointId);
        }
        if checkpoint.last_seq == 0 && checkpoint.remote_pull_seq.unwrap_or_default() > 0 {
            checkpoint.last_seq = checkpoint.remote_pull_seq.unwrap_or_default();
        }
        checkpoint.updated_at = Some(now_ms());
        checkpoint.sync_epoch.get_or_insert(sync_epoch);
        let encoded = serde_json::to_string(&checkpoint)?;
        self.lock()?.execute(
            "INSERT INTO sync_checkpoints(uid,checkpoint_id,checkpoint_json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(uid,checkpoint_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,updated_at=excluded.updated_at",
            params![uid, checkpoint.id, encoded, checkpoint.updated_at.unwrap_or_default()],
        )?;
        Ok(checkpoint)
    }

    pub(crate) fn get_checkpoint(
        &self,
        uid: &str,
        checkpoint_id: &str,
    ) -> Result<CheckpointPayload, StoreError> {
        let encoded = self
            .lock()?
            .query_row(
                "SELECT checkpoint_json FROM sync_checkpoints WHERE uid=?1 AND checkpoint_id=?2",
                params![uid, checkpoint_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match encoded {
            Some(json) => Ok(serde_json::from_str(&json)?),
            None => Ok(CheckpointPayload::missing(checkpoint_id.to_owned())),
        }
    }

    pub(crate) fn upsert_device(
        &self,
        uid: &str,
        device_id: &str,
        name: &str,
    ) -> Result<(), StoreError> {
        self.lock()?.execute(
            "INSERT INTO device_sync_state(uid,device_id,device_name,last_seq,last_seen) VALUES(?1,?2,?3,0,?4) ON CONFLICT(uid,device_id) DO UPDATE SET device_name=excluded.device_name,last_seq=0,last_seen=excluded.last_seen",
            params![uid, device_id, name, now_ms()],
        )?;
        Ok(())
    }

    pub(crate) fn max_user_seq(&self, uid: &str) -> Result<i64, StoreError> {
        let connection = self.lock()?;
        max_user_seq(&connection, uid).map_err(StoreError::from)
    }
}

fn validate_supported_change(change: &FullChangeEntry) -> Result<(), StoreError> {
    if change.doc_id.trim().is_empty() {
        return Err(StoreError::MissingDocumentId);
    }
    if change.rev.trim().is_empty() {
        return Err(StoreError::MissingRevision);
    }
    if change.extra_fields.contains_key("resolution") {
        return Err(StoreError::UnsupportedPayload("revision resolution"));
    }
    if change.extra_fields.keys().any(|field| {
        matches!(
            field.as_str(),
            "winnerRev" | "isWinner" | "retireOtherLeaves" | "leaves"
        )
    }) {
        return Err(StoreError::UnsupportedPayload("revision winner metadata"));
    }
    if !change.extra_fields.is_empty() {
        return Err(StoreError::UnsupportedPayload("unknown change fields"));
    }
    if let Some(history) = &change.revision_history {
        if history.len() > 1 {
            return Err(StoreError::UnsupportedPayload("revision history branches"));
        }
        if history
            .first()
            .is_some_and(|revision| revision != &change.rev)
        {
            return Err(StoreError::UnsupportedPayload("revision history mismatch"));
        }
    }
    if change.doc.get("_attachments").is_some() {
        return Err(StoreError::UnsupportedPayload("attachments"));
    }
    Ok(())
}

fn revision_generation(revision: &str) -> Result<u64, StoreError> {
    let Some((generation, hash)) = revision.split_once('-') else {
        return Err(StoreError::RevisionConflict(
            "revision must be generation-hash",
        ));
    };
    let generation = generation
        .parse::<u64>()
        .ok()
        .filter(|generation| *generation > 0)
        .ok_or(StoreError::RevisionConflict(
            "revision generation is invalid",
        ))?;
    if hash.trim().is_empty() {
        return Err(StoreError::RevisionConflict("revision hash is required"));
    }
    Ok(generation)
}

fn max_user_seq(connection: &Connection, uid: &str) -> Result<i64, rusqlite::Error> {
    connection.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM changelog WHERE uid=?1",
        [uid],
        |row| row.get(0),
    )
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn upsert_device_state(
    tx: &Transaction<'_>,
    uid: &str,
    device_id: &str,
    name: &str,
    seq: i64,
) -> Result<(), rusqlite::Error> {
    tx.execute(
        "INSERT INTO device_sync_state(uid,device_id,device_name,last_seq,last_seen) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(uid,device_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq),last_seen=excluded.last_seen",
        params![uid, device_id, name, seq, now_ms()],
    )?;
    Ok(())
}

fn row_to_change(row: &rusqlite::Row<'_>) -> Result<FullChangeEntry, rusqlite::Error> {
    let doc_json: String = row.get(6)?;
    Ok(FullChangeEntry {
        seq: row.get(0)?,
        doc_id: row.get(1)?,
        rev: row.get(2)?,
        parent_rev: row.get(3)?,
        revision_history: None,
        deleted: row.get::<_, i64>(4)? != 0,
        timestamp: row.get(5)?,
        doc: serde_json::from_str(&doc_json).map_err(|_| rusqlite::Error::InvalidQuery)?,
        doc_type: row.get(7)?,
        protocol_version: row.get(8)?,
        extra_fields: Default::default(),
    })
}

fn row_to_snapshot(row: &rusqlite::Row<'_>) -> Result<FullChangeEntry, rusqlite::Error> {
    let doc_json: String = row.get(5)?;
    let rev: String = row.get(1)?;
    Ok(FullChangeEntry {
        seq: 0,
        doc_id: row.get(0)?,
        rev: rev.clone(),
        parent_rev: row.get(2)?,
        revision_history: None,
        deleted: row.get::<_, i64>(3)? != 0,
        timestamp: row.get(4)?,
        doc: serde_json::from_str(&doc_json).map_err(|_| rusqlite::Error::InvalidQuery)?,
        doc_type: row.get(6)?,
        protocol_version: row.get(7)?,
        extra_fields: std::collections::BTreeMap::from([
            ("winnerRev".into(), Value::String(rev)),
            ("isWinner".into(), Value::Bool(true)),
        ]),
    })
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
#[path = "revision_tests.rs"]
mod revision_tests;
