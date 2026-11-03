//! One-shot, bounded projection of the actual source-build inspection result.
//!
//! This is diagnostic-only: command transport success remains separate, and no
//! source path, blocker message, or unrecognized blocker code is retained.
use serde_json::{json, Value};

const MAX_BLOCKER_CODES: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InspectionStatus {
    Unobserved,
    CommandError,
    Eligible,
    Blocked,
    AlreadyReady,
    Invalid,
}

impl InspectionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unobserved => "unobserved",
            Self::CommandError => "command_error",
            Self::Eligible => "eligible",
            Self::Blocked => "blocked",
            Self::AlreadyReady => "already_ready",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct InspectionObservation {
    observed: bool,
    duplicate: bool,
    status: Option<InspectionStatus>,
    blocker_codes: Vec<&'static str>,
    blocker_code_overflow: bool,
}

impl InspectionObservation {
    /// Preserve the first completed inspection only; later calls cannot replace it.
    pub(super) fn record(&mut self, result: Result<&Value, &str>) {
        if self.observed {
            self.duplicate = true;
            return;
        }
        self.observed = true;
        let Ok(value) = result else {
            self.status = Some(InspectionStatus::CommandError);
            return;
        };
        let Some((status, codes)) = classify(value) else {
            self.status = Some(InspectionStatus::Invalid);
            return;
        };
        self.status = Some(status);
        for code in codes {
            if self.blocker_codes.len() == MAX_BLOCKER_CODES {
                self.blocker_code_overflow = true;
                break;
            }
            self.blocker_codes.push(allowlisted_code(code));
        }
    }

    pub(super) fn snapshot(&self) -> Value {
        json!({
            "status": self.status.unwrap_or(InspectionStatus::Unobserved).as_str(),
            "observed": self.observed,
            "duplicate": self.duplicate,
            "blockerCodes": self.blocker_codes,
            "blockerCodeCount": self.blocker_codes.len(),
            "blockerCodeOverflow": self.blocker_code_overflow,
        })
    }
}

fn classify(value: &Value) -> Option<(InspectionStatus, Vec<&str>)> {
    let object = value.as_object()?;
    let status = match object.get("status")?.as_str()? {
        "eligible" => InspectionStatus::Eligible,
        "blocked" => InspectionStatus::Blocked,
        "already_ready" => InspectionStatus::AlreadyReady,
        _ => return None,
    };
    let blockers = object.get("blockers")?.as_array()?;
    if blockers.len() > 64 {
        return None;
    }
    let mut codes = Vec::with_capacity(blockers.len().min(MAX_BLOCKER_CODES));
    for blocker in blockers {
        let blocker = blocker.as_object()?;
        let code = blocker.get("code")?.as_str()?;
        let message = blocker.get("message")?.as_str()?;
        if utf16_len(code) > 128 || utf16_len(message) > 4096 {
            return None;
        }
        codes.push(code);
    }
    if let Some(steps) = object.get("buildSteps") {
        if !valid_build_steps(steps) {
            return None;
        }
        if status == InspectionStatus::Eligible
            && steps
                .as_array()?
                .iter()
                .filter(|step| step["kind"] == "viteBuild")
                .count()
                != 1
        {
            return None;
        }
    }
    if status == InspectionStatus::Eligible {
        let plugin_id = object.get("pluginId")?.as_str()?;
        let version = object.get("version")?.as_str()?;
        let revision = object.get("sourceRevision")?.as_str()?;
        if !blockers.is_empty()
            || plugin_id.is_empty()
            || utf16_len(plugin_id) > 256
            || version.trim().is_empty()
            || utf16_len(version) > 4096
            || revision.len() != 64
            || !revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return None;
        }
    }
    Some((status, codes))
}

fn valid_build_steps(value: &Value) -> bool {
    let Some(steps) = value.as_array() else {
        return false;
    };
    if steps.is_empty() || steps.len() > 12 {
        return false;
    }
    let mut node_test_files = 0_u64;
    for step in steps {
        let Some(object) = step.as_object() else {
            return false;
        };
        let Some(kind) = object.get("kind").and_then(Value::as_str) else {
            return false;
        };
        match kind {
            "nodeTests" => {
                if object.len() != 2 {
                    return false;
                }
                let Some(files) = object.get("files").and_then(Value::as_u64) else {
                    return false;
                };
                if files == 0 || files > 128 {
                    return false;
                }
                node_test_files += files;
                if node_test_files > 128 {
                    return false;
                }
            }
            "typecheck" | "viteBuild" | "packageScript" => {
                if object.len() != 1 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn allowlisted_code(code: &str) -> &'static str {
    match code {
        "manifest_missing" => "manifest_missing",
        "manifest_invalid" => "manifest_invalid",
        "plugin_id_invalid" => "plugin_id_invalid",
        "unsupported_runtime" => "unsupported_runtime",
        "remote_entry" => "remote_entry",
        "entry_path_invalid" => "entry_path_invalid",
        "package_missing" => "package_missing",
        "lock_missing" => "lock_missing",
        "dependencies_missing" => "dependencies_missing",
        "vite_missing" => "vite_missing",
        "build_scripts_invalid" => "build_scripts_invalid",
        "unsupported_build" => "unsupported_build",
        "build_script_recursive" => "build_script_recursive",
        "build_script_limit" => "build_script_limit",
        "build_script_path_invalid" => "build_script_path_invalid",
        "build_toolchain_invalid" => "build_toolchain_invalid",
        "build_backend_missing" => "build_backend_missing",
        "build_backend_ambiguous" => "build_backend_ambiguous",
        "build_lock_mismatch" => "build_lock_mismatch",
        "build_vite_count_invalid" => "build_vite_count_invalid",
        "esbuild_missing" => "esbuild_missing",
        "build_toolchain_unsupported" => "build_toolchain_unsupported",
        "native_addon" => "native_addon",
        "source_scan_bounded" => "source_scan_bounded",
        "source_scan_unsafe" => "source_scan_unsafe",
        "source_scan_error" => "source_scan_error",
        "source_scan_unsupported" => "source_scan_unsupported",
        "platform_unsupported" => "platform_unsupported",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn eligible() -> Value {
        json!({"status":"eligible","pluginId":"fixture.plugin","version":"1.2.3",
            "sourceRevision":"a".repeat(64),"blockers":[],"buildSteps":[{"kind":"viteBuild"}]})
    }

    #[test]
    fn keeps_unobserved_command_error_and_all_inspection_statuses_distinct() {
        assert_eq!(
            InspectionObservation::default().snapshot()["status"],
            "unobserved"
        );
        let mut failed = InspectionObservation::default();
        failed.record(Err("private path and error text"));
        assert_eq!(failed.snapshot()["status"], "command_error");
        for (value, status) in [
            (eligible(), "eligible"),
            (
                json!({"status":"blocked","blockers":[{"code":"vite_missing","message":"detail"}]}),
                "blocked",
            ),
            (
                json!({"status":"already_ready","blockers":[]}),
                "already_ready",
            ),
        ] {
            let mut observed = InspectionObservation::default();
            observed.record(Ok(&value));
            assert_eq!(observed.snapshot()["status"], status);
        }
    }

    #[test]
    fn invalid_shapes_never_become_eligible() {
        for value in [
            json!({"status":"eligible","pluginId":"x","version":"1","sourceRevision":"a".repeat(64),"blockers":[{"code":"vite_missing","message":"x"}]}),
            json!({"status":"eligible","pluginId":"x","version":"1","sourceRevision":"bad","blockers":[]}),
            json!({"status":"eligible","pluginId":"x","version":"1","sourceRevision":"a".repeat(64),"blockers":[],"buildSteps":[{"kind":"nodeTests","files":129}]}),
            json!({"status":"blocked","blockers":[{"code":"x","message":4}]}),
        ] {
            let mut observed = InspectionObservation::default();
            observed.record(Ok(&value));
            assert_eq!(observed.snapshot()["status"], "invalid");
        }
    }

    #[test]
    fn blocker_codes_are_allowlisted_bounded_and_private_text_is_not_retained() {
        let private = "/private/secret/source/project";
        let value = json!({"status":"blocked","blockers":[
            {"code":"vite_missing","message":private},
            {"code":"unknown_reason","message":private},
            {"code":"manifest_missing","message":"safe"},
            {"code":"plugin_id_invalid","message":"safe"},
            {"code":"unsupported_runtime","message":"safe"},
            {"code":"remote_entry","message":"safe"},
            {"code":"entry_path_invalid","message":"safe"},
            {"code":"package_missing","message":"safe"},
            {"code":"lock_missing","message":"safe"}
        ]});
        let mut observed = InspectionObservation::default();
        observed.record(Ok(&value));
        let output = observed.snapshot();
        let serialized = output.to_string();
        assert_eq!(output["blockerCodeCount"], MAX_BLOCKER_CODES);
        assert_eq!(output["blockerCodeOverflow"], true);
        assert_eq!(output["blockerCodes"][1], "other");
        assert!(!serialized.contains(private));
        assert!(!serialized.contains("unknown_"));
        assert_eq!(
            allowlisted_code("build_backend_missing"),
            "build_backend_missing"
        );
        assert_eq!(
            allowlisted_code("build_backend_ambiguous"),
            "build_backend_ambiguous"
        );

        let long_code = json!({"status":"blocked","blockers":[
            {"code":"x".repeat(10000),"message":private}
        ]});
        let mut invalid = InspectionObservation::default();
        invalid.record(Ok(&long_code));
        let serialized = invalid.snapshot().to_string();
        assert_eq!(invalid.snapshot()["status"], "invalid");
        assert!(!serialized.contains(private));
        assert!(!serialized.contains(&"x".repeat(1000)));
    }

    #[test]
    fn only_first_inspection_result_is_kept() {
        let first = eligible();
        let second = json!({"status":"blocked","blockers":[{"code":"vite_missing","message":"x"}]});
        let mut observed = InspectionObservation::default();
        observed.record(Ok(&first));
        observed.record(Ok(&second));
        assert_eq!(observed.snapshot()["status"], "eligible");
        assert_eq!(observed.snapshot()["duplicate"], true);
        assert_eq!(observed.snapshot()["blockerCodeCount"], 0);
    }
}
