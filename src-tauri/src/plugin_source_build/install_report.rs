//! Bounded translation of the shared install report into source-build errors.
use crate::ztools_import::ZToolsImportReport;

const MAX_ERROR_BYTES: usize = 1024;
const PREFLIGHT_CODE: &str = "PLUGIN_RUNTIME_DEPENDENCY_MISSING";

pub(super) fn installation_failure(report: &ZToolsImportReport) -> String {
    let Some(failure) = report
        .failed
        .iter()
        .find(|failure| failure.error.contains(PREFLIGHT_CODE))
    else {
        return "SOURCE_BUILD_INSTALL_NOT_COMMITTED".into();
    };
    let detail = truncate_utf8(&failure.error, MAX_ERROR_BYTES);
    format!("SOURCE_BUILD_INSTALL_NOT_COMMITTED: {detail}")
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ztools_import::{ZToolsImportCandidate, ZToolsImportFailure};

    fn report(errors: &[&str]) -> ZToolsImportReport {
        ZToolsImportReport {
            imported: Vec::new(),
            skipped: Vec::<ZToolsImportCandidate>::new(),
            failed: errors
                .iter()
                .map(|error| ZToolsImportFailure {
                    path: "fixture".into(),
                    error: (*error).into(),
                })
                .collect(),
        }
    }

    #[test]
    fn keeps_first_runtime_preflight_reason_with_stable_not_committed_status() {
        let result = installation_failure(&report(&[
            "unrelated earlier item",
            "[PLUGIN_RUNTIME_DEPENDENCY_MISSING] missing first (preload/first.cjs)",
            "[PLUGIN_RUNTIME_DEPENDENCY_MISSING] missing second (preload/second.cjs)",
        ]));
        assert!(result.starts_with("SOURCE_BUILD_INSTALL_NOT_COMMITTED:"));
        assert!(result.contains("PLUGIN_RUNTIME_DEPENDENCY_MISSING"));
        assert!(result.contains("preload/first.cjs"));
        assert!(!result.contains("preload/second.cjs"));
    }

    #[test]
    fn caps_forwarded_install_error_and_does_not_claim_success() {
        let mut value = "[PLUGIN_RUNTIME_DEPENDENCY_MISSING] ".to_string();
        value.push_str(&"缺".repeat(2000));
        let result = installation_failure(&report(&[&value]));
        assert!(result.starts_with("SOURCE_BUILD_INSTALL_NOT_COMMITTED:"));
        assert!(result.len() <= MAX_ERROR_BYTES + 64);
        assert!(!result.contains("dependencyClosureVerified:true"));
    }

    #[test]
    fn unrelated_import_failure_keeps_the_existing_stable_code() {
        let result = installation_failure(&report(&["some unrelated failure"]));
        assert_eq!(result, "SOURCE_BUILD_INSTALL_NOT_COMMITTED");
    }
}
