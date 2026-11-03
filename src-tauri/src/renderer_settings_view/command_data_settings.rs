//! Immutable command-settings snapshots and complete-read CAS bases.

use serde_json::Value;

use super::{ensure_open, first_page_end, CommandDataBuffers, DataKind, Snapshot};
use crate::renderer_settings_view::validation::BridgeError;

pub(crate) const MAX_COMMAND_SETTINGS_BYTES: usize = 1024 * 1024;

impl CommandDataBuffers {
    pub(crate) fn command_settings_token(&self) -> Result<Option<String>, BridgeError> {
        let buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        Ok(buffers.command_settings.as_ref().and_then(|snapshot| {
            self.snapshot_matches(snapshot, DataKind::CommandSettings)
                .then(|| snapshot.token.clone())
        }))
    }

    pub(crate) fn store_command_settings(&self, bytes: Vec<u8>) -> Result<String, BridgeError> {
        if bytes.is_empty() || bytes.len() > MAX_COMMAND_SETTINGS_BYTES {
            return Err(invalid_command_settings_data());
        }
        std::str::from_utf8(&bytes).map_err(|_| invalid_command_settings_data())?;
        serde_json::from_slice::<Value>(&bytes).map_err(|_| invalid_command_settings_data())?;

        let mut buffers = self.buffers.lock();
        ensure_open(&buffers)?;
        if let Some(snapshot) = buffers.command_settings.as_ref() {
            if self.snapshot_matches(snapshot, DataKind::CommandSettings) {
                return Ok(snapshot.token.clone());
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        let next_offset = first_page_end(bytes.len());
        buffers.command_settings = Some(Snapshot {
            token: token.clone(),
            session_id: self.session_id.clone(),
            bundle_revision: self.bundle_revision.clone(),
            kind: DataKind::CommandSettings,
            bytes,
            next_offset,
            read_complete: false,
        });
        Ok(token)
    }

    /// Returns the expected disabled-command value only for a complete,
    /// session-owned command-settings snapshot.
    pub(crate) fn command_settings_disabled_commands_base(
        &self,
        token: &str,
    ) -> Result<Value, BridgeError> {
        let buffers = self.buffers.lock();
        if buffers.closed {
            return Err(settings_token_invalid());
        }
        let snapshot = buffers
            .command_settings
            .as_ref()
            .filter(|snapshot| {
                snapshot.token == token
                    && self.snapshot_matches(snapshot, DataKind::CommandSettings)
            })
            .ok_or_else(settings_token_invalid)?;
        if !snapshot.read_complete {
            return Err(settings_base_not_read());
        }

        let document = serde_json::from_slice::<Value>(&snapshot.bytes)
            .map_err(|_| invalid_command_settings_data())?;
        let expected = document
            .as_object()
            .and_then(|object| object.get("disable-commands"))
            .ok_or_else(invalid_command_settings_data)?;
        if let Some(ids) = expected.as_array() {
            if ids.len() > 4096
                || !ids.iter().all(|id| {
                    id.as_str()
                        .is_some_and(|id| !id.is_empty() && id.len() <= 16_448)
                })
            {
                return Err(invalid_command_settings_data());
            }
        } else if !expected.is_null() {
            return Err(invalid_command_settings_data());
        }
        Ok(expected.clone())
    }

    /// Returns the bounded immutable command-settings snapshot size without
    /// changing the established four-field diagnostics tuple.
    pub(crate) fn command_settings_bytes(&self) -> usize {
        let buffers = self.buffers.lock();
        buffers
            .command_settings
            .as_ref()
            .filter(|snapshot| self.snapshot_matches(snapshot, DataKind::CommandSettings))
            .map_or(0, |snapshot| snapshot.bytes.len())
    }

    /// Drops the immutable command settings snapshot after any write attempt
    /// that can make its compare-and-swap base stale.
    pub(crate) fn invalidate_command_settings(&self) -> bool {
        let discarded = {
            let mut buffers = self.buffers.lock();
            if buffers.closed {
                return false;
            }
            buffers.command_settings.take()
        };
        drop(discarded);
        true
    }
}

fn invalid_command_settings_data() -> BridgeError {
    BridgeError::new(
        "SETTINGS_COMMAND_SETTINGS_READ_FAILED",
        "Command settings snapshot is invalid",
    )
}

fn settings_token_invalid() -> BridgeError {
    BridgeError::new(
        "SETTINGS_DISABLED_COMMANDS_BASE_INVALID",
        "Disabled command settings snapshot token is invalid",
    )
}

fn settings_base_not_read() -> BridgeError {
    BridgeError::new(
        "SETTINGS_DISABLED_COMMANDS_BASE_INVALID",
        "Disabled command settings snapshot token is invalid",
    )
}

#[cfg(test)]
#[path = "command_data_settings_tests.rs"]
mod tests;
