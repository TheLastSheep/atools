//! Atomic reservations and lifecycle for alias writes staged in a session.

use serde_json::Value;

use super::{
    base_not_read, ensure_open, invalid_data, token_invalid, write_in_flight, ActiveAliasWrite,
    AliasSnapshot, AliasWriteInput, AliasWriteReservation, CommandDataBuffers, DataKind, Snapshot,
    WritePhase, MAX_ALIAS_BYTES, MAX_ALIAS_RAW_BYTES, MAX_STAGED_BYTES,
};
use crate::renderer_settings_view::validation::BridgeError;

impl CommandDataBuffers {
    pub(crate) fn reserve_inline_write(
        &self,
        base_token: &str,
        bytes: Vec<u8>,
    ) -> Result<AliasWriteReservation, BridgeError> {
        if bytes.is_empty() || bytes.len() > MAX_STAGED_BYTES {
            return Err(invalid_data());
        }
        let mut buffers = self.buffers.lock();
        validate_write_base(self, &buffers, base_token)?;
        if buffers.active_alias_write.is_some() {
            return Err(write_in_flight());
        }
        let alias_snapshot = buffers.aliases.as_ref().ok_or_else(base_not_read)?;
        let base_token = alias_snapshot.snapshot.token.clone();
        let expected_raw = alias_snapshot.raw.clone();
        let reservation = AliasWriteReservation {
            write_token: uuid::Uuid::new_v4().to_string(),
        };
        buffers.active_alias_write = Some(ActiveAliasWrite {
            token: reservation.write_token.clone(),
            base_token,
            expected_raw,
            total_bytes: bytes.len(),
            bytes,
            phase: WritePhase::Staged,
        });
        Ok(reservation)
    }

    pub(crate) fn begin_alias_write(
        &self,
        base_token: &str,
        total_bytes: usize,
    ) -> Result<AliasWriteReservation, BridgeError> {
        if total_bytes == 0 || total_bytes > MAX_STAGED_BYTES {
            return Err(invalid_data());
        }
        let mut buffers = self.buffers.lock();
        validate_write_base(self, &buffers, base_token)?;
        if buffers.active_alias_write.is_some() {
            return Err(write_in_flight());
        }
        let alias_snapshot = buffers.aliases.as_ref().ok_or_else(base_not_read)?;
        let base_token = alias_snapshot.snapshot.token.clone();
        let expected_raw = alias_snapshot.raw.clone();
        let reservation = AliasWriteReservation {
            write_token: uuid::Uuid::new_v4().to_string(),
        };
        buffers.active_alias_write = Some(ActiveAliasWrite {
            token: reservation.write_token.clone(),
            base_token,
            expected_raw,
            total_bytes,
            bytes: Vec::with_capacity(total_bytes),
            phase: WritePhase::Staged,
        });
        Ok(reservation)
    }

    pub(crate) fn append_alias_write(
        &self,
        write_token: &str,
        offset: usize,
        chunk: &[u8],
    ) -> Result<usize, BridgeError> {
        let mut buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        let Some(active) = buffers.active_alias_write.as_mut() else {
            return Err(token_invalid());
        };
        if active.token != write_token || active.phase != WritePhase::Staged {
            return Err(token_invalid());
        }
        let new_len = active.bytes.len().checked_add(chunk.len());
        if chunk.is_empty()
            || chunk.len() > 16 * 1024
            || active.bytes.len() != offset
            || new_len.map_or(true, |length| length > active.total_bytes)
        {
            buffers.active_alias_write = None;
            return Err(invalid_data());
        }
        active.bytes.extend_from_slice(chunk);
        Ok(active.bytes.len())
    }

    pub(crate) fn discard_staged_write(&self, write_token: &str) {
        let mut buffers = self.buffers.lock();
        if buffers
            .active_alias_write
            .as_ref()
            .is_some_and(|active| active.token == write_token && active.phase == WritePhase::Staged)
        {
            buffers.active_alias_write = None;
        }
    }

    pub(crate) fn staged_write_offset(&self, write_token: &str) -> Result<usize, BridgeError> {
        let buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        let active = buffers
            .active_alias_write
            .as_ref()
            .filter(|active| active.token == write_token && active.phase == WritePhase::Staged)
            .ok_or_else(token_invalid)?;
        Ok(active.bytes.len())
    }

    pub(crate) fn staged_write_ready(&self, write_token: &str) -> Result<bool, BridgeError> {
        let buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        let active = buffers
            .active_alias_write
            .as_ref()
            .filter(|active| active.token == write_token && active.phase == WritePhase::Staged)
            .ok_or_else(token_invalid)?;
        Ok(active.bytes.len() == active.total_bytes)
    }

    pub(crate) fn take_staged_write(
        &self,
        write_token: &str,
    ) -> Result<AliasWriteInput, BridgeError> {
        let mut buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        let active = buffers
            .active_alias_write
            .as_ref()
            .filter(|active| active.token == write_token && active.phase == WritePhase::Staged)
            .ok_or_else(token_invalid)?;
        if active.bytes.len() != active.total_bytes {
            return Err(invalid_data());
        }
        let desired = match serde_json::from_slice::<Value>(&active.bytes) {
            Ok(value) => value,
            Err(_) => {
                buffers.active_alias_write = None;
                return Err(invalid_data());
            }
        };
        let write_token = active.token.clone();
        let expected_raw = active.expected_raw.clone();
        let active = buffers
            .active_alias_write
            .as_mut()
            .filter(|active| active.token == write_token)
            .ok_or_else(token_invalid)?;
        active.phase = WritePhase::Committing;
        let bytes = std::mem::take(&mut active.bytes);
        drop(bytes);
        Ok(AliasWriteInput {
            expected_raw,
            desired,
        })
    }

    pub(crate) fn abort_staged_write(&self, write_token: &str) -> Result<bool, BridgeError> {
        let mut buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        let Some(active) = buffers.active_alias_write.as_ref() else {
            return Err(token_invalid());
        };
        if active.token != write_token {
            return Err(token_invalid());
        }
        if active.phase == WritePhase::Committing {
            return Ok(false);
        }
        buffers.active_alias_write = None;
        Ok(true)
    }

    pub(crate) fn finish_alias_write_success(
        &self,
        write_token: &str,
        raw: Option<String>,
        value: &Value,
        bytes: Vec<u8>,
    ) -> Result<Option<String>, BridgeError> {
        let mut buffers = self.buffers.lock();
        if buffers.closed {
            return Ok(None);
        }
        let active = buffers
            .active_alias_write
            .as_ref()
            .filter(|active| active.token == write_token && active.phase == WritePhase::Committing)
            .ok_or_else(token_invalid)?;
        if active.base_token
            != buffers
                .aliases
                .as_ref()
                .map(|snapshot| snapshot.snapshot.token.as_str())
                .unwrap_or_default()
        {
            return Err(token_invalid());
        }
        if raw
            .as_ref()
            .is_some_and(|raw| raw.len() > MAX_ALIAS_RAW_BYTES)
            || bytes.is_empty()
            || bytes.len() > MAX_ALIAS_BYTES
            || serde_json::from_slice::<Value>(&bytes).ok().as_ref() != Some(value)
        {
            return Err(invalid_data());
        }
        let token = uuid::Uuid::new_v4().to_string();
        let next_offset = super::first_page_end(bytes.len());
        buffers.active_alias_write = None;
        buffers.aliases = Some(AliasSnapshot {
            snapshot: Snapshot {
                token: token.clone(),
                session_id: self.session_id.clone(),
                bundle_revision: self.bundle_revision.clone(),
                kind: DataKind::Aliases,
                bytes,
                // The writer already has the candidate; a subsequent read still begins at page 0.
                next_offset,
                read_complete: true,
            },
            raw,
        });
        Ok(Some(token))
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.buffers.lock().closed
    }

    pub(crate) fn finish_alias_write_failure(&self, write_token: &str, invalidate_base: bool) {
        let mut buffers = self.buffers.lock();
        if buffers
            .active_alias_write
            .as_ref()
            .is_some_and(|active| active.token == write_token)
        {
            buffers.active_alias_write = None;
            if invalidate_base {
                buffers.aliases = None;
            }
        }
    }
}

fn validate_write_base(
    buffers_owner: &CommandDataBuffers,
    buffers: &super::Buffers,
    base_token: &str,
) -> Result<(), BridgeError> {
    ensure_open(buffers)?;
    if buffers.active_alias_write.is_some() {
        return Err(write_in_flight());
    }
    let snapshot = buffers.aliases.as_ref().ok_or_else(base_not_read)?;
    if !buffers_owner.snapshot_matches(&snapshot.snapshot, DataKind::Aliases)
        || snapshot.snapshot.token != base_token
    {
        return Err(token_invalid());
    }
    if !snapshot.snapshot.read_complete {
        return Err(base_not_read());
    }
    Ok(())
}
