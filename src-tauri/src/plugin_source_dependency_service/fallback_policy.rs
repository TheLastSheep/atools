//! Narrow conversion fallback policy for an already verified dependency set.
use atools_plugin::source_build::{SourceBuildBlocker, SourceBuildStatus};

pub(in crate::plugin_source_build) fn allows_prepared_dependency_fallback(
    status: SourceBuildStatus,
    blockers: &[SourceBuildBlocker],
) -> bool {
    status == SourceBuildStatus::Blocked
        && blockers.len() == 1
        && blockers[0].code == "dependencies_missing"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocker(code: &str) -> SourceBuildBlocker {
        SourceBuildBlocker {
            code: code.into(),
            message: "fixture".into(),
        }
    }

    #[test]
    fn fallback_requires_the_sole_blocked_reason_to_be_missing_dependencies() {
        assert!(allows_prepared_dependency_fallback(
            SourceBuildStatus::Blocked,
            &[blocker("dependencies_missing")],
        ));
        assert!(!allows_prepared_dependency_fallback(
            SourceBuildStatus::Eligible,
            &[blocker("dependencies_missing")],
        ));
        assert!(!allows_prepared_dependency_fallback(
            SourceBuildStatus::AlreadyReady,
            &[],
        ));
        assert!(!allows_prepared_dependency_fallback(
            SourceBuildStatus::Blocked,
            &[blocker("dependencies_missing"), blocker("vite_missing")],
        ));
        assert!(!allows_prepared_dependency_fallback(
            SourceBuildStatus::Blocked,
            &[blocker("vite_missing")],
        ));
    }
}
