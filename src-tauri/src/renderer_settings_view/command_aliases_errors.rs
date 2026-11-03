use atools_core::error::AToolsError;

use super::super::super::validation::BridgeError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CoreWriteFailure {
    RevisionConflict,
    SessionClosed,
    InvalidCandidate,
    Storage,
}

impl CoreWriteFailure {
    pub(super) fn invalidate_base(self) -> bool {
        matches!(self, Self::RevisionConflict | Self::Storage)
    }
}

pub(super) fn classify_core_error(error: &AToolsError) -> CoreWriteFailure {
    match error {
        AToolsError::Config(message) if message == super::ALIAS_CAS_CONFLICT => {
            CoreWriteFailure::RevisionConflict
        }
        AToolsError::Config(message)
            if message == "Renderer command alias session closed before transaction start" =>
        {
            CoreWriteFailure::SessionClosed
        }
        AToolsError::Config(_) | AToolsError::Json(_) => CoreWriteFailure::InvalidCandidate,
        _ => CoreWriteFailure::Storage,
    }
}

pub(super) fn alias_read_failed() -> BridgeError {
    BridgeError::new(
        "SETTINGS_ALIAS_READ_FAILED",
        "Renderer command aliases could not be read",
    )
}

pub(super) fn revision_conflict() -> BridgeError {
    BridgeError::new(
        "SETTINGS_ALIAS_REVISION_CONFLICT",
        "Renderer command aliases changed; reread before saving",
    )
}

pub(super) fn commit_interrupted() -> BridgeError {
    BridgeError::new(
        "SETTINGS_ALIAS_COMMIT_INTERRUPTED",
        "Alias commit result is unknown; reread aliases before retrying",
    )
}
