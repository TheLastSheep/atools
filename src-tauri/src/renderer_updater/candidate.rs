//! Candidate selection shared by legacy show and Native-only expected About presentation.
use super::*;
pub(crate) fn expected_candidate(
    snapshot: &crate::updater::snapshot::Snapshot,
    expected: Option<&str>,
) -> Result<crate::updater::UpdateMetadata, Error> {
    let candidate = snapshot
        .candidate
        .clone()
        .ok_or_else(|| error("no_update"))?;
    if expected.is_some_and(|id| id != candidate.candidate_id) {
        return Err(error("stale_candidate"));
    }
    Ok(candidate)
}
