//! Session-owned bounded snapshots and staged alias writes.

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::renderer_settings_view::validation::BridgeError;

#[path = "command_data_settings.rs"]
mod settings;
#[path = "command_data_write_state.rs"]
mod write_state;
pub(crate) use settings::MAX_COMMAND_SETTINGS_BYTES;

pub(crate) const MAX_COMMAND_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_ALIAS_BYTES: usize = 512 * 1024;
pub(crate) const MAX_ALIAS_RAW_BYTES: usize = 128 * 1024;
pub(crate) const MAX_PAGE_BYTES: usize = 32 * 1024;
pub(crate) const MAX_STAGED_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DataKind {
    Commands,
    Aliases,
    CommandSettings,
}

impl DataKind {
    pub(crate) fn parse(value: &str) -> Result<Self, BridgeError> {
        match value {
            "commands" => Ok(Self::Commands),
            "aliases" => Ok(Self::Aliases),
            "commandSettings" => Ok(Self::CommandSettings),
            _ => Err(token_invalid()),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Commands => "commands",
            Self::Aliases => "aliases",
            Self::CommandSettings => "commandSettings",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AliasBase {
    pub(crate) token: String,
    pub(crate) raw: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PageData {
    pub(crate) token: String,
    pub(crate) offset: usize,
    pub(crate) next_offset: usize,
    pub(crate) total_bytes: usize,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AliasWriteInput {
    pub(crate) expected_raw: Option<String>,
    pub(crate) desired: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AliasWriteReservation {
    pub(crate) write_token: String,
}

struct Snapshot {
    token: String,
    session_id: String,
    bundle_revision: String,
    kind: DataKind,
    bytes: Vec<u8>,
    next_offset: usize,
    read_complete: bool,
}

struct AliasSnapshot {
    snapshot: Snapshot,
    raw: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WritePhase {
    Staged,
    Committing,
}

struct ActiveAliasWrite {
    token: String,
    base_token: String,
    expected_raw: Option<String>,
    total_bytes: usize,
    bytes: Vec<u8>,
    phase: WritePhase,
}

#[derive(Default)]
struct Buffers {
    closed: bool,
    commands: Option<Snapshot>,
    aliases: Option<AliasSnapshot>,
    command_settings: Option<Snapshot>,
    active_alias_write: Option<ActiveAliasWrite>,
}

pub(crate) struct CommandDataBuffers {
    session_id: String,
    bundle_revision: String,
    buffers: Mutex<Buffers>,
    pub(crate) commands_read_gate: AsyncMutex<()>,
    pub(crate) aliases_read_gate: AsyncMutex<()>,
    pub(crate) settings_read_gate: AsyncMutex<()>,
}

impl CommandDataBuffers {
    pub(crate) fn new(session_id: String, bundle_revision: String) -> Self {
        Self {
            session_id,
            bundle_revision,
            buffers: Mutex::new(Buffers::default()),
            commands_read_gate: AsyncMutex::new(()),
            aliases_read_gate: AsyncMutex::new(()),
            settings_read_gate: AsyncMutex::new(()),
        }
    }

    /// Marks the owning session as closing, then clears every session-owned transfer buffer.
    pub(crate) fn close_after_mark<T>(
        &self,
        mark_closing: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let result = mark_closing();
        self.clear_locked();
        result
    }

    pub(crate) fn close(&self) {
        self.clear_locked();
    }

    fn clear_locked(&self) {
        let mut buffers = self.buffers.lock();
        buffers.closed = true;
        buffers.commands = None;
        buffers.aliases = None;
        buffers.command_settings = None;
        buffers.active_alias_write = None;
    }

    pub(crate) fn commands_token(&self) -> Result<Option<String>, BridgeError> {
        let buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        Ok(buffers.commands.as_ref().and_then(|snapshot| {
            self.snapshot_matches(snapshot, DataKind::Commands)
                .then(|| snapshot.token.clone())
        }))
    }

    /// Discards the canonical command directory after a backing catalog mutation.
    /// Serializing with readers prevents an in-flight old catalog capture from
    /// being stored after invalidation has completed.
    pub(crate) async fn invalidate_commands(&self) -> bool {
        let _read_gate = self.commands_read_gate.lock().await;
        let discarded = {
            let mut buffers = self.buffers.lock();
            if buffers.closed {
                return false;
            }
            buffers.commands.take()
        };
        let invalidated = discarded.is_some();
        drop(discarded);
        invalidated
    }

    pub(crate) fn store_commands(&self, bytes: Vec<u8>) -> Result<String, BridgeError> {
        if bytes.is_empty() || bytes.len() > MAX_COMMAND_BYTES {
            return Err(invalid_data());
        }
        std::str::from_utf8(&bytes).map_err(|_| invalid_data())?;
        serde_json::from_slice::<Value>(&bytes).map_err(|_| invalid_data())?;

        let mut buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        if let Some(snapshot) = buffers.commands.as_ref() {
            if self.snapshot_matches(snapshot, DataKind::Commands) {
                return Ok(snapshot.token.clone());
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        let next_offset = first_page_end(bytes.len());
        buffers.commands = Some(Snapshot {
            token: token.clone(),
            session_id: self.session_id.clone(),
            bundle_revision: self.bundle_revision.clone(),
            kind: DataKind::Commands,
            bytes,
            next_offset,
            read_complete: false,
        });
        Ok(token)
    }

    pub(crate) fn alias_base(&self) -> Result<Option<AliasBase>, BridgeError> {
        let buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        if buffers.active_alias_write.is_some() {
            return Err(write_in_flight());
        }
        Ok(buffers.aliases.as_ref().and_then(|snapshot| {
            if !self.snapshot_matches(&snapshot.snapshot, DataKind::Aliases) {
                return None;
            }
            Some(AliasBase {
                token: snapshot.snapshot.token.clone(),
                raw: snapshot.raw.clone(),
            })
        }))
    }

    pub(crate) fn store_alias_base(
        &self,
        raw: Option<String>,
        value: Value,
        bytes: Vec<u8>,
    ) -> Result<AliasBase, BridgeError> {
        if raw
            .as_ref()
            .is_some_and(|raw| raw.len() > MAX_ALIAS_RAW_BYTES)
            || bytes.is_empty()
            || bytes.len() > MAX_ALIAS_BYTES
        {
            return Err(invalid_data());
        }
        std::str::from_utf8(&bytes).map_err(|_| invalid_data())?;
        let parsed = serde_json::from_slice::<Value>(&bytes).map_err(|_| invalid_data())?;
        if parsed != value {
            return Err(invalid_data());
        }

        let mut buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        if buffers.active_alias_write.is_some() {
            return Err(write_in_flight());
        }
        if let Some(snapshot) = buffers.aliases.as_ref() {
            if self.snapshot_matches(&snapshot.snapshot, DataKind::Aliases) {
                return Ok(AliasBase {
                    token: snapshot.snapshot.token.clone(),
                    raw: snapshot.raw.clone(),
                });
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        buffers.aliases = Some(AliasSnapshot {
            snapshot: Snapshot {
                token: token.clone(),
                session_id: self.session_id.clone(),
                bundle_revision: self.bundle_revision.clone(),
                kind: DataKind::Aliases,
                next_offset: first_page_end(bytes.len()),
                read_complete: bytes.len() <= MAX_PAGE_BYTES,
                bytes,
            },
            raw: raw.clone(),
        });
        Ok(AliasBase { token, raw })
    }

    pub(crate) fn first_page(&self, kind: DataKind, token: &str) -> Result<PageData, BridgeError> {
        let mut buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        if kind == DataKind::Aliases && buffers.active_alias_write.is_some() {
            return Err(write_in_flight());
        }
        let snapshot = match kind {
            DataKind::Commands => buffers.commands.as_mut(),
            DataKind::Aliases => buffers.aliases.as_mut().map(|value| &mut value.snapshot),
            DataKind::CommandSettings => buffers.command_settings.as_mut(),
        }
        .filter(|snapshot| snapshot.token == token && self.snapshot_matches(snapshot, kind))
        .ok_or_else(token_invalid)?;
        // Re-reading the same immutable snapshot begins a fresh sequential page walk.
        snapshot.next_offset = first_page_end(snapshot.bytes.len());
        let first = page(snapshot, 0)?;
        if first.next_offset == first.total_bytes {
            snapshot.read_complete = true;
        }
        Ok(first)
    }

    pub(crate) fn next_page(
        &self,
        kind: DataKind,
        token: &str,
        offset: usize,
    ) -> Result<PageData, BridgeError> {
        let mut buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        if kind == DataKind::Aliases && buffers.active_alias_write.is_some() {
            return Err(write_in_flight());
        }
        let snapshot = match kind {
            DataKind::Commands => buffers.commands.as_mut(),
            DataKind::Aliases => buffers.aliases.as_mut().map(|value| &mut value.snapshot),
            DataKind::CommandSettings => buffers.command_settings.as_mut(),
        }
        .filter(|snapshot| snapshot.token == token && self.snapshot_matches(snapshot, kind))
        .ok_or_else(token_invalid)?;
        if offset != snapshot.next_offset || offset >= snapshot.bytes.len() {
            return Err(token_invalid());
        }
        let result = page(snapshot, offset)?;
        snapshot.next_offset = result.next_offset;
        if result.next_offset == result.total_bytes {
            snapshot.read_complete = true;
        }
        Ok(result)
    }

    fn snapshot_matches(&self, snapshot: &Snapshot, kind: DataKind) -> bool {
        snapshot.kind == kind
            && snapshot.session_id == self.session_id
            && snapshot.bundle_revision == self.bundle_revision
    }

    pub(crate) fn diagnostics(&self) -> (usize, usize, usize, bool) {
        let buffers = self.buffers.lock();
        (
            buffers
                .commands
                .as_ref()
                .map_or(0, |value| value.bytes.len()),
            buffers
                .aliases
                .as_ref()
                .map_or(0, |value| value.snapshot.bytes.len()),
            buffers
                .active_alias_write
                .as_ref()
                .map_or(0, |value| value.bytes.len()),
            buffers.closed,
        )
    }
}

fn first_page_end(total_bytes: usize) -> usize {
    total_bytes.min(MAX_PAGE_BYTES)
}

fn page(snapshot: &Snapshot, offset: usize) -> Result<PageData, BridgeError> {
    if offset >= snapshot.bytes.len() {
        return Err(token_invalid());
    }
    let next_offset = offset
        .saturating_add(MAX_PAGE_BYTES)
        .min(snapshot.bytes.len());
    if next_offset <= offset {
        return Err(token_invalid());
    }
    Ok(PageData {
        token: snapshot.token.clone(),
        offset,
        next_offset,
        total_bytes: snapshot.bytes.len(),
        bytes: snapshot.bytes[offset..next_offset].to_vec(),
    })
}

fn ensure_open(buffers: &Buffers) -> Result<(), BridgeError> {
    if buffers.closed {
        Err(token_invalid())
    } else {
        Ok(())
    }
}

fn base_not_read() -> BridgeError {
    BridgeError::new(
        "SETTINGS_ALIAS_BASE_NOT_READ",
        "Read the complete alias snapshot before writing aliases",
    )
}

fn token_invalid() -> BridgeError {
    BridgeError::new(
        "SETTINGS_ALIAS_TOKEN_INVALID",
        "Settings alias data token is invalid or expired",
    )
}

fn write_in_flight() -> BridgeError {
    BridgeError::new(
        "SETTINGS_ALIAS_WRITE_IN_FLIGHT",
        "An alias write is already in flight",
    )
}

fn invalid_data() -> BridgeError {
    BridgeError::new(
        "SETTINGS_ALIAS_TOKEN_INVALID",
        "Settings alias data payload is invalid",
    )
}

#[cfg(test)]
#[path = "command_data_buffers_tests.rs"]
mod tests;
