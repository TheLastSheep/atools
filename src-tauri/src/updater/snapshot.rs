use super::{UpdateCommandError, UpdateMetadata};
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    Checking,
    NotAvailable,
    Available,
    Downloading,
    Downloaded,
    Installing,
    InstallUnknown,
    RestartPending,
    Restarting,
    Error,
}
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u8,
    pub sequence: u64,
    pub phase: Phase,
    pub candidate: Option<UpdateMetadata>,
    pub checked: bool,
    pub operation_id: Option<String>,
    pub progress: Progress,
    pub error: Option<UpdateCommandError>,
}
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Progress {
    pub downloaded: u64,
    pub total: Option<u64>,
}
pub(super) type Notify = std::sync::Arc<dyn Fn(Snapshot, bool) + Send + Sync>;

// Reserve the largest legal future projection, not just the smaller legacy/available response.
// Production errors are canonical fixed messages, with an enforced 2KiB encoded ceiling.
// This is encoded-retention admission; it does not bound the SDK network buffer.
pub(super) fn validate_candidate(candidate: &UpdateMetadata) -> Result<(), UpdateCommandError> {
    candidate.validate_status_fields()?;
    let worst = Snapshot {
        version: 1,
        sequence: 9_007_199_254_740_991,
        phase: Phase::RestartPending,
        candidate: Some(candidate.clone()),
        checked: false,
        operation_id: Some("f".repeat(32)),
        progress: Progress {
            downloaded: 9_007_199_254_740_991,
            total: Some(9_007_199_254_740_991),
        },
        error: None,
    };
    let encoded =
        serde_json::to_vec(&serde_json::json!({"windowId":"f".repeat(32),"snapshot":worst}))
            .map_err(|_| super::coordinator::failure("internal"))?
            .len();
    let empty_error = serde_json::to_vec(&None::<UpdateCommandError>)
        .map_err(|_| super::coordinator::failure("internal"))?
        .len();
    if encoded - empty_error + super::errors::MAX_ENCODED_ERROR > 64 * 1024 {
        return Err(UpdateCommandError::new(
            "state_response_too_large",
            "更新候选无法安全投影完整状态",
        ));
    }
    Ok(())
}
