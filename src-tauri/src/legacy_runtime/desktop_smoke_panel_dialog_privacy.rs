//! Bounded fixture diagnostics. Never return a value, matched substring or dynamic key.
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const MAX_DEPTH: usize = 24;
const MAX_NODES: usize = 65_536;
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_MATCHES: usize = 128;

#[derive(Clone, Copy, Default)]
struct Markers {
    fixture_root: bool,
    selected_tree: bool,
    save_target: bool,
    dialog_endpoint: bool,
}
impl Markers {
    fn any(self) -> bool {
        self.fixture_root || self.selected_tree || self.save_target || self.dialog_endpoint
    }
    fn merge(&mut self, other: Self) {
        self.fixture_root |= other.fixture_root;
        self.selected_tree |= other.selected_tree;
        self.save_target |= other.save_target;
        self.dialog_endpoint |= other.dialog_endpoint;
    }
    fn value(self) -> Value {
        json!({"fixtureRoot":self.fixture_root,"selectedTree":self.selected_tree,
            "saveTarget":self.save_target,"dialogEndpoint":self.dialog_endpoint})
    }
}
struct Targets<'a> {
    root: &'a str,
    tree: &'a str,
    save: &'a str,
    installation_metadata_verified: bool,
    activation: bool,
}
impl Targets<'_> {
    fn expected_installation(&self, field: &str, text: &str) -> bool {
        self.installation_metadata_verified
            && self.activation
            && match field {
                "/output/plugin_path" => text == format!("{}/plugins/file-tree", self.root),
                "/output/preload_path" => {
                    text == format!("{}/plugins/file-tree/preload.js", self.root)
                }
                _ => false,
            }
    }
    fn classify(&self, text: &str) -> Markers {
        Markers {
            fixture_root: !self.root.is_empty() && text.contains(self.root),
            selected_tree: !self.tree.is_empty() && text == self.tree,
            save_target: !self.save.is_empty() && text == self.save,
            dialog_endpoint: dialog_endpoint(text),
        }
    }
}
fn dialog_endpoint(text: &str) -> bool {
    text.match_indices("http://127.0.0.1:")
        .any(|(index, prefix)| {
            let rest = &text[index + prefix.len()..];
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            digits > 0
                && digits <= 5
                && rest[digits..].starts_with("/dialog/")
                && rest[digits + "/dialog/".len()..]
                    .bytes()
                    .next()
                    .is_some_and(|byte| {
                        byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
                    })
        })
}

// A fixed vocabulary keeps unknown payload keys (including path/token keys) out of output.
fn schema_key(key: &str) -> &'static str {
    match key {
        "id" => "id",
        "capabilityId" => "capabilityId",
        "initiator" => "initiator",
        "type" => "type",
        "clientId" => "clientId",
        "status" => "status",
        "input" => "input",
        "output" => "output",
        "summary" => "summary",
        "progress" => "progress",
        "artifacts" => "artifacts",
        "warnings" => "warnings",
        "errors" => "errors",
        "actions" => "actions",
        "memoryIds" => "memoryIds",
        "metrics" => "metrics",
        "validation" => "validation",
        "auditId" => "auditId",
        "retryOf" => "retryOf",
        "createdAt" => "createdAt",
        "updatedAt" => "updatedAt",
        "startedAt" => "startedAt",
        "finishedAt" => "finishedAt",
        "code" => "code",
        "operation" => "operation",
        "intentId" => "intentId",
        "sessionId" => "sessionId",
        "invocationId" => "invocationId",
        "method" => "method",
        "payload" => "payload",
        "expectedPluginId" => "expectedPluginId",
        "plugin_id" => "plugin_id",
        "plugin_name" => "plugin_name",
        "feature_code" => "feature_code",
        "feature_label" => "feature_label",
        "main_url" => "main_url",
        "plugin_path" => "plugin_path",
        "preload_path" => "preload_path",
        "plugin_permissions" => "plugin_permissions",
        "plugin_providers" => "plugin_providers",
        "kind" => "kind",
        "label" => "label",
        "mediaType" => "mediaType",
        "uri" => "uri",
        "path" => "path",
        "sizeBytes" => "sizeBytes",
        "metadata" => "metadata",
        "message" => "message",
        "details" => "details",
        "retryable" => "retryable",
        "parameters" => "parameters",
        "endpoint" => "endpoint",
        _ => "*",
    }
}
fn safe_identity(value: Option<&str>, targets: &Targets<'_>) -> String {
    value
        .filter(|text| {
            !text.is_empty()
                && text.len() <= 256
                && !targets.classify(text).any()
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        })
        .unwrap_or("[redacted]")
        .to_string()
}
#[derive(Default)]
struct Budget {
    nodes: usize,
    text_bytes: usize,
    matches: usize,
    truncated: bool,
    halted: bool,
    serialization_failed: bool,
}
struct Match {
    markers: Markers,
    expected_installation_metadata: bool,
}
impl Budget {
    fn text(&mut self, text: &str) -> bool {
        if text.len() > MAX_TEXT_BYTES.saturating_sub(self.text_bytes) {
            self.truncated = true;
            self.halted = true;
            return false;
        }
        self.text_bytes += text.len();
        true
    }
    fn record(
        &mut self,
        matches: &mut BTreeMap<String, Match>,
        field: &str,
        markers: Markers,
        expected: bool,
    ) {
        if !markers.any() {
            return;
        }
        if let Some(previous) = matches.get_mut(field) {
            previous.markers.merge(markers);
            previous.expected_installation_metadata &= expected;
            return;
        }
        if self.matches == MAX_MATCHES {
            self.truncated = true;
            self.halted = true;
            return;
        }
        self.matches += 1;
        matches.insert(
            field.to_string(),
            Match {
                markers,
                expected_installation_metadata: expected,
            },
        );
    }
    fn visit(
        &mut self,
        value: &Value,
        field: &str,
        depth: usize,
        targets: &Targets<'_>,
        matches: &mut BTreeMap<String, Match>,
    ) {
        if self.halted {
            return;
        }
        if depth > MAX_DEPTH {
            self.truncated = true;
            return;
        }
        if self.nodes == MAX_NODES {
            self.truncated = true;
            self.halted = true;
            return;
        }
        self.nodes += 1;
        match value {
            Value::String(text) => {
                if self.text(text) {
                    self.record(
                        matches,
                        field,
                        targets.classify(text),
                        targets.expected_installation(field, text),
                    );
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    if self.halted {
                        break;
                    }
                    let next = format!("{field}/{}", schema_key(key));
                    if !self.text(key) {
                        break;
                    }
                    self.record(matches, &next, targets.classify(key), false);
                    self.visit(value, &next, depth + 1, targets, matches);
                }
            }
            Value::Array(values) => {
                for value in values {
                    if self.halted {
                        break;
                    }
                    self.visit(value, &format!("{field}/*"), depth + 1, targets, matches);
                }
            }
            _ => {}
        }
    }
}

/// Every returned TaskRun is scanned, including activation and non-dialog capabilities.
/// Hitting either query or scan limits is incomplete evidence, never a privacy pass.
pub(super) fn inspect<T: Serialize>(
    runs: &[T],
    root: &str,
    tree: &str,
    save: &str,
    query_limit: usize,
    installation_metadata_verified: bool,
) -> Value {
    let mut budget = Budget::default();
    let mut output = Vec::new();
    let mut selection_private = installation_metadata_verified;
    let query_limit_reached = query_limit == 0 || runs.len() >= query_limit;
    for run in runs.iter().take(query_limit) {
        if budget.halted {
            break;
        }
        let Ok(value) = serde_json::to_value(run) else {
            budget.serialization_failed = true;
            continue;
        };
        let targets = Targets {
            root,
            tree,
            save,
            installation_metadata_verified,
            activation: value["capabilityId"] == "plugin.feature.file-tree",
        };
        let run_id = safe_identity(value["id"].as_str(), &targets);
        let capability = safe_identity(value["capabilityId"].as_str(), &targets);
        let mut matches = BTreeMap::new();
        budget.visit(&value, "", 0, &targets, &mut matches);
        output.extend(matches.into_iter().map(|(field, found)| {
            let markers = found.markers;
            selection_private &= found.expected_installation_metadata
                && markers.fixture_root
                && !markers.selected_tree
                && !markers.save_target
                && !markers.dialog_endpoint;
            json!({
                "runId":run_id,"capability":capability,"field":field,"markers":markers.value(),
                "expectedInstallationMetadata":found.expected_installation_metadata,
            })
        }));
    }
    let complete = !query_limit_reached && !budget.truncated && !budget.serialization_failed;
    json!({"schemaVersion":1,"complete":complete,"selectionPrivacyVerified":complete && selection_private,
        "installationMetadataVerified":installation_metadata_verified,
        "selectionPrivacyScope":"All returned TaskRun fields are scanned. Exact reviewed activation installation paths remain in history; picker selections, unknown fixture paths and dialog endpoints must be absent. The all-root absence diagnostic remains independent.",
        "truncated":budget.truncated,"queryLimitReached":query_limit_reached,
        "serializationFailed":budget.serialization_failed,"matches":output,
        "budget":{"queryLimit":query_limit,"returnedRuns":runs.len(),"maxDepth":MAX_DEPTH,
            "maxNodes":MAX_NODES,"scannedNodes":budget.nodes,"maxTextBytes":MAX_TEXT_BYTES,
            "scannedTextBytes":budget.text_bytes,"maxMatches":MAX_MATCHES,"returnedMatches":budget.matches},
        "scope":"All returned TaskRun fields and keys; fixed schema pointers with dynamic keys and array indices hidden"})
}

#[cfg(test)]
mod tests {
    use super::*;
    const ROOT: &str = "/private/synthetic-private-root";
    fn inspect_values(runs: &[Value], limit: usize) -> Value {
        inspect(
            runs,
            ROOT,
            &format!("{ROOT}/tree-data"),
            &format!("{ROOT}/export/private.png"),
            limit,
            true,
        )
    }
    fn run(output: Value) -> Value {
        json!({"id":"run-synthetic","capabilityId":"plugin.feature.file-tree","output":output})
    }
    #[test]
    fn non_dialog_activation_install_paths_are_reported_by_fixed_field_not_value() {
        let report = inspect_values(
            &[run(
                json!({"plugin_path":format!("{ROOT}/plugins/file-tree"),
            "preload_path":format!("{ROOT}/plugins/file-tree/preload.js")}),
            )],
            1000,
        );
        assert_eq!(report["complete"], true);
        assert_eq!(report["selectionPrivacyVerified"], true);
        let matches = report["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 2);
        for (entry, field) in matches
            .iter()
            .zip(["/output/plugin_path", "/output/preload_path"])
        {
            assert_eq!(entry["capability"], "plugin.feature.file-tree");
            assert_eq!(entry["field"], field);
            assert_eq!(entry["markers"]["fixtureRoot"], true);
            assert_eq!(entry["expectedInstallationMetadata"], true);
        }
        assert!(!report.to_string().contains(ROOT));
    }
    #[test]
    fn expected_fields_never_exempt_selections_other_paths_or_other_capabilities() {
        for field in ["plugin_path", "preload_path"] {
            for path in [
                format!("{ROOT}/tree-data"),
                format!("{ROOT}/export/private.png"),
                format!("{ROOT}/plugins/file-tree/unknown"),
            ] {
                let output =
                    Value::Object([(field.to_string(), json!(path))].into_iter().collect());
                let report = inspect_values(&[run(output)], 1000);
                assert_eq!(report["selectionPrivacyVerified"], false);
                assert_eq!(report["matches"][0]["field"], format!("/output/{field}"));
                assert_eq!(report["matches"][0]["expectedInstallationMetadata"], false);
            }
        }
        let mut other = run(json!({"plugin_path":format!("{ROOT}/plugins/file-tree")}));
        other["capabilityId"] = json!("other.capability");
        assert_eq!(
            inspect_values(&[other], 1000)["selectionPrivacyVerified"],
            false
        );
        let exact = run(json!({"plugin_path":format!("{ROOT}/plugins/file-tree")}));
        assert_eq!(
            inspect(&[exact], ROOT, "tree", "save", 1000, false)["selectionPrivacyVerified"],
            false
        );
    }
    #[test]
    fn sensitive_dynamic_keys_and_endpoint_tokens_never_escape_diagnostics() {
        let endpoint = "http://127.0.0.1:48321/dialog/never-export-this-secret-token";
        let report = inspect_values(
            &[run(json!({format!("{ROOT}/secret-dynamic-key"):endpoint}))],
            1000,
        );
        let entry = &report["matches"][0];
        assert_eq!(entry["field"], "/output/*");
        assert_eq!(entry["markers"]["fixtureRoot"], true);
        assert_eq!(entry["markers"]["dialogEndpoint"], true);
        assert_eq!(report["selectionPrivacyVerified"], false);
        let text = report.to_string();
        for secret in [
            ROOT,
            "secret-dynamic-key",
            "never-export-this-secret-token",
            endpoint,
        ] {
            assert!(!text.contains(secret));
        }
    }
    #[test]
    fn selected_targets_require_exact_value_and_all_error_and_artifact_fields_are_scanned() {
        let report = inspect_values(
            &[
                json!({"id":"run-synthetic","capabilityId":"legacy_node_synthetic",
            "errors":[{"message":format!("{ROOT}/tree-data"),"details":{"private":format!("{ROOT}/tree-data/child")}}],
            "artifacts":[{"path":format!("{ROOT}/export/private.png")}],"summary":ROOT}),
            ],
            1000,
        );
        let entries = report["matches"].as_array().unwrap();
        assert!(entries
            .iter()
            .any(|x| x["field"] == "/errors/*/message" && x["markers"]["selectedTree"] == true));
        assert!(entries
            .iter()
            .any(|x| x["field"] == "/errors/*/details/*" && x["markers"]["selectedTree"] == false));
        assert!(entries
            .iter()
            .any(|x| x["field"] == "/artifacts/*/path" && x["markers"]["saveTarget"] == true));
        assert!(entries.iter().any(|x| x["field"] == "/summary"));
    }
    #[test]
    fn query_depth_byte_node_and_output_limits_are_never_a_pass() {
        let clean = run(json!({}));
        let queried = inspect_values(&vec![clean.clone(); 1000], 1000);
        assert_eq!(queried["queryLimitReached"], true);
        assert_eq!(queried["complete"], false);
        assert_eq!(queried["selectionPrivacyVerified"], false);
        let mut deep = Value::Null;
        for _ in 0..MAX_DEPTH + 2 {
            deep = json!([deep]);
        }
        let cases = [
            run(deep),
            run(json!("x".repeat(MAX_TEXT_BYTES + 1))),
            run(json!(vec![Value::Null; MAX_NODES + 1])),
        ];
        for value in cases {
            let report = inspect_values(&[value], 1000);
            assert_eq!(report["truncated"], true);
            assert_eq!(report["complete"], false);
            assert_eq!(report["selectionPrivacyVerified"], false);
        }
        let report = inspect_values(&vec![run(json!({"path":ROOT})); MAX_MATCHES + 1], 1000);
        assert_eq!(report["truncated"], true);
        assert_eq!(report["complete"], false);
        assert_eq!(report["matches"].as_array().unwrap().len(), MAX_MATCHES);
    }
}
