//! Fixed child-only native fixture gate and bounded, content-free history evidence.
use atools_core::Database;
use serde_json::{json, Value};
use tauri::Manager;

const MAX_RUNS: usize = 1000;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MARKERS: &[&str] = &[
    "ATools child-only Node fixed sentinel 31",
    "atools-child-dictionary-word-31",
    "fixed fixture translation",
    "atools-child-dictionary-31",
    "ATools child dictionary fixture 31",
    "fixture-child-main-ready",
    "atools-child-main-private-31",
    "CustomDictsListKey",
    "fixture-dictionary.json",
    "fixture-sentinel.txt",
    "child-preload.js",
    "preload-app.js",
];

pub(super) fn configure(
    db: &Database,
    dataset: &mut super::super::catalog_fixture::CatalogDataset,
    incompatible: bool,
) -> Result<bool, String> {
    if std::env::var("ATOOLS_CHILD_NODE_ACCEPTANCE").as_deref() != Ok("true") {
        return Ok(false);
    }
    if incompatible {
        return Err("Child-only Node fixture is isolated from other acceptance modes".into());
    }
    for (id, preload) in [
        ("file-tree", Some("parent-preload.js")),
        ("char-transform", None),
    ] {
        let plugin = db
            .get_plugin(id)
            .map_err(|_| "Child-only fixture package unavailable")?;
        if plugin.manifest.version != "0.0.0-synthetic"
            || plugin.manifest.preload.as_deref() != preload
        {
            return Err(
                "Child-only Node fixture requires its exact generated parent packages".into(),
            );
        }
    }
    *dataset = dataset.clone().with_generated_packages();
    dataset.scope = "1200 synthetic metadata features and two generated packages; one complete unchanged original child preload only; no complete original plugin acceptance.";
    Ok(true)
}

fn scan(bytes: &[u8], count: usize) -> Value {
    let complete = count < MAX_RUNS && bytes.len() <= MAX_BYTES;
    let text = std::str::from_utf8(bytes).ok();
    let private = complete
        && text.is_some_and(|text| {
            !MARKERS.iter().any(|marker| text.contains(marker))
                && !(text.contains("http://127.0.0.1:")
                    && ["/node/", "/data/", "/dialog/", "/path/"]
                        .iter()
                        .any(|part| text.contains(part)))
        });
    json!({"complete":complete && text.is_some(),"privateFixtureContentsAbsent":private,
        "taskRuns":count,"scannedBytes":bytes.len(),"queryLimit":MAX_RUNS,"maxBytes":MAX_BYTES,
        "scope":"Every returned TaskRun field and key; fixed child payloads, selected child filenames and local-loopback credentials; known activation installation paths are outside this content-only check"})
}

#[tauri::command]
pub(super) fn native_panel_child_node_privacy(app: tauri::AppHandle) -> Result<Value, String> {
    if std::env::var("ATOOLS_CHILD_NODE_ACCEPTANCE").as_deref() != Ok("true") {
        return Err("Dedicated child-only Node history evidence is disabled".into());
    }
    let fixture = app.state::<super::PanelFixture>();
    let runs = fixture
        .db
        .list_task_runs(MAX_RUNS)
        .map_err(|_| "Private fixture history unavailable")?;
    let bytes =
        serde_json::to_vec(&runs).map_err(|_| "Private fixture history serialization failed")?;
    let mut report = scan(&bytes, runs.len());
    report["allTaskRunsTerminal"] = json!(runs.iter().all(|run| run.status.is_terminal()));
    let node_tool = crate::legacy_runtime::registry::tool_name("file-tree");
    let selected = runs
        .iter()
        .filter(|run| run.capability_id == node_tool)
        .collect::<Vec<_>>();
    report["nodeTaskRuns"] = json!(selected.len());
    let opens = selected
        .iter()
        .filter(|run| run.input["operation"] == "open")
        .collect::<Vec<_>>();
    report["nodeOpenTaskRuns"] = json!(opens.len());
    report["nodeOpenTaskRunStatuses"] =
        json!(opens.iter().map(|run| &run.status).collect::<Vec<_>>());
    report["nodeRequestTaskRuns"] = json!(selected
        .iter()
        .filter(|run| run.input["operation"] == "request")
        .count());
    Ok(report)
}

pub(super) fn describe(report: &mut Value) {
    report["scope"] = json!("Generated pure-Electron parent and child pages in actual default opaque App/PluginPanel; child-only one-time Node permission, package sentinel fs read, and complete unchanged English child preload fs-to-attachment/config round trip");
    report["limitations"] = json!(["Generated parent, manifest and HTML are not the original English plugin; only the complete pinned child preload executes unchanged", "Hosted opaque child iframes, not independent native windows or physical input", "Private macOS incognito fixture; no OS picker, clipboard, external network, packaged release or full-process performance claim"]);
    report["generatedSourcesOnly"] = json!(false);
    report["reviewedOriginalChildPreloadOnly"] = json!(true);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn child_node_privacy_accepts_only_complete_bounded_content_free_history() {
        assert_eq!(
            scan(br#"[{"input":{"operation":"open"}}]"#, 1)["privateFixtureContentsAbsent"],
            true
        );
        for bytes in [vec![b'x'; MAX_BYTES + 1], vec![0xff]] {
            assert_eq!(scan(&bytes, 1)["privateFixtureContentsAbsent"], false);
        }
        assert_eq!(scan(b"[]", MAX_RUNS)["complete"], false);
    }
    #[test]
    fn child_node_privacy_scans_payloads_keys_child_paths_and_credentials_without_returning_them() {
        for marker in MARKERS.iter().copied().chain([
            "http://127.0.0.1:12345/node/secret",
            "http://127.0.0.1:12345/data/secret",
        ]) {
            let bytes = serde_json::to_vec(&json!({marker:{"error":marker}})).unwrap();
            let report = scan(&bytes, 1);
            assert_eq!(report["privateFixtureContentsAbsent"], false);
            assert!(!report.to_string().contains(marker));
        }
    }
}
