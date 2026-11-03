//! Projects only the supervisor's fixed worker failure codes into task-safe diagnostics.
use crate::plugin_source_dependencies::supervisor::{fixed_worker_code, WorkerFailure};

pub(super) fn diagnostic_code(failure: WorkerFailure) -> String {
    match failure {
        WorkerFailure::Cancelled => "SOURCE_DEPENDENCY_CANCELLED".to_owned(),
        WorkerFailure::TimedOut => "SOURCE_DEPENDENCY_WORKER_TIMEOUT".to_owned(),
        WorkerFailure::Spawn => "SOURCE_DEPENDENCY_WORKER_SPAWN".to_owned(),
        WorkerFailure::Wait => "SOURCE_DEPENDENCY_WORKER_WAIT".to_owned(),
        WorkerFailure::OutputLimit => "SOURCE_DEPENDENCY_WORKER_OUTPUT_LIMIT".to_owned(),
        WorkerFailure::ObservedFootprintLimit => {
            "SOURCE_DEPENDENCY_WORKER_RESOURCE_LIMIT".to_owned()
        }
        WorkerFailure::ResourceMonitorUnavailable => {
            "SOURCE_DEPENDENCY_WORKER_RESOURCE_UNAVAILABLE".to_owned()
        }
        WorkerFailure::Pipe => "SOURCE_DEPENDENCY_WORKER_PIPE".to_owned(),
        WorkerFailure::Protocol => "SOURCE_DEPENDENCY_WORKER_PROTOCOL".to_owned(),
        WorkerFailure::Unreaped => "SOURCE_DEPENDENCY_WORKER_UNREAPED".to_owned(),
        WorkerFailure::Worker(code) => match fixed_worker_code(code) {
            Some(code) => {
                let suffix = code
                    .strip_prefix("dependency_worker_")
                    .or_else(|| code.strip_prefix("dependency_"))
                    .unwrap_or("failed");
                format!("SOURCE_DEPENDENCY_WORKER_{}", suffix.to_ascii_uppercase())
            }
            None => "SOURCE_DEPENDENCY_WORKER_FAILED".to_owned(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_worker_diagnostic_preserves_allowlisted_failure_without_raw_output() {
        assert_eq!(
            diagnostic_code(WorkerFailure::Worker("dependency_archive_missing")),
            "SOURCE_DEPENDENCY_WORKER_ARCHIVE_MISSING"
        );
        assert_eq!(
            diagnostic_code(WorkerFailure::Worker("dependency_worker_sandbox_failed")),
            "SOURCE_DEPENDENCY_WORKER_SANDBOX_FAILED"
        );
        assert_eq!(
            diagnostic_code(WorkerFailure::Worker(
                "dependency_package_identity_mismatch"
            )),
            "SOURCE_DEPENDENCY_WORKER_PACKAGE_IDENTITY_MISMATCH"
        );
        assert_eq!(
            diagnostic_code(WorkerFailure::Worker("dependency_package_metadata_missing")),
            "SOURCE_DEPENDENCY_WORKER_PACKAGE_METADATA_MISSING"
        );
    }

    #[test]
    fn unknown_worker_detail_fails_closed_and_supervisor_categories_stay_distinct() {
        assert_eq!(
            diagnostic_code(WorkerFailure::Worker("/private/token=do-not-leak")),
            "SOURCE_DEPENDENCY_WORKER_FAILED"
        );
        assert_eq!(
            diagnostic_code(WorkerFailure::Protocol),
            "SOURCE_DEPENDENCY_WORKER_PROTOCOL"
        );
        assert_eq!(
            diagnostic_code(WorkerFailure::TimedOut),
            "SOURCE_DEPENDENCY_WORKER_TIMEOUT"
        );
    }
}
