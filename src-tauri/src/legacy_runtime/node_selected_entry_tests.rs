//! Selected child anchors and real Node lifecycle; no desktop/window automation.
use super::{
    node_entry,
    node_selected_entry::SelectedPreload,
    sessions::{Intent, Sessions},
};
use atools_core::Plugin;
use atools_plugin::{loader::load_plugin_from_disk, sidecar::SidecarStatus};
use serde_json::json;
use std::{
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

fn fixture() -> (tempfile::TempDir, Plugin) {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("plugin.json"), json!({
        "name":"child-only-node-fixture", "version":"1.0.0", "main":"index.html", "preload":"parent.js",
        "features":[{"code":"fixture","cmds":["fixture"]}]
    }).to_string()).unwrap();
    std::fs::write(temp.path().join("index.html"), "<!doctype html>").unwrap();
    std::fs::write(
        temp.path().join("parent.js"),
        "window.ipcRenderer=require('electron').ipcRenderer;",
    )
    .unwrap();
    std::fs::create_dir(temp.path().join("child")).unwrap();
    std::fs::write(
        temp.path().join("child/preload.js"),
        "require('fs');require('./dep');throw Error('must not execute');",
    )
    .unwrap();
    std::fs::write(temp.path().join("child/dep.js"), "module.exports=42;").unwrap();
    let plugin = load_plugin_from_disk(temp.path()).unwrap();
    (temp, plugin)
}
fn selected(plugin: &Plugin) -> SelectedPreload {
    SelectedPreload::capture(plugin, "child/preload.js", None).unwrap()
}
fn intent(runtime: &Sessions, owner: &str, plugin: &Plugin, selected: SelectedPreload) -> Intent {
    let id = runtime
        .create_selected_intent(
            owner.into(),
            "atools-ui".into(),
            plugin.id.clone(),
            None,
            Some(selected),
        )
        .unwrap();
    runtime
        .take_intent(Some(&id), "atools-ui", &plugin.id)
        .unwrap()
}
async fn process_id(session: &super::sessions::Session) -> u64 {
    let process = session
        .runtime
        .request("require", json!({"specifier":"process"}))
        .await
        .unwrap();
    session
        .runtime
        .request(
            "get",
            json!({"handleId":process["handleId"], "property":"pid"}),
        )
        .await
        .unwrap()["value"]
        .as_u64()
        .unwrap()
}

#[tokio::test]
async fn node_selected_child_opens_after_pure_electron_parent_and_concurrent_intents_reuse_one_real_process(
) {
    let (_temp, plugin) = fixture();
    assert!(node_entry::select_entry(&plugin).is_err());
    let runtime = Arc::new(Sessions::default());
    let first = intent(&runtime, "owner", &plugin, selected(&plugin));
    let second = intent(&runtime, "owner", &plugin, selected(&plugin));
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.server.lock().await.is_none());
    let (first, second) = tokio::time::timeout(Duration::from_secs(4), async {
        tokio::join!(
            runtime.open(&plugin, "tool".into(), first),
            runtime.open(&plugin, "tool".into(), second)
        )
    })
    .await
    .unwrap();
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(process_id(&first).await, process_id(&second).await);
    assert_eq!(runtime.sessions.read().len(), 1);
    // A relative Node package request resolves from the selected child's directory.
    let dependency = first
        .runtime
        .request("require", json!({"specifier":"./dep.js"}))
        .await
        .unwrap();
    assert_eq!(dependency["value"], 42);
    runtime.close_owner("owner", None).await;
    assert_eq!(first.runtime.status(), SidecarStatus::Stopped);
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
}

#[test]
fn node_selected_anchor_rejects_non_normalized_paths_no_node_and_installation_mismatch() {
    let (temp, plugin) = fixture();
    for path in [
        "../child/preload.js",
        "/child/preload.js",
        "./child/preload.js",
        "child//preload.js",
        "child/../parent.js",
        "child\\preload.js",
        "child/preload.js?x",
        "",
        "parent.js",
        "index.html",
    ] {
        assert!(
            SelectedPreload::capture(&plugin, path, None).is_err(),
            "{path}"
        );
    }
    std::fs::write(temp.path().join("process-only.js"), "process.platform").unwrap();
    assert!(SelectedPreload::capture(&plugin, "process-only.js", None).is_err());
    let mut wrong = plugin.clone();
    wrong.enabled = false;
    assert!(SelectedPreload::capture(&wrong, "child/preload.js", None).is_err());
    wrong = plugin.clone();
    wrong.name = "replacement".into();
    assert!(SelectedPreload::capture(&wrong, "child/preload.js", None).is_err());
    wrong = plugin.clone();
    wrong.version = "2".into();
    assert!(SelectedPreload::capture(&wrong, "child/preload.js", None).is_err());
}

#[tokio::test]
async fn node_selected_waiting_authorization_rejects_changed_anchor_dependency_and_manifest_without_starting_node(
) {
    for changed in ["child/preload.js", "child/dep.js", "plugin.json"] {
        let (temp, plugin) = fixture();
        let runtime = Sessions::default();
        let pending = intent(&runtime, "waiting", &plugin, selected(&plugin));
        if changed == "plugin.json" {
            let mut manifest: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(temp.path().join(changed)).unwrap())
                    .unwrap();
            manifest["description"] = json!("replacement");
            std::fs::write(temp.path().join(changed), manifest.to_string()).unwrap();
        } else {
            std::fs::write(
                temp.path().join(changed),
                "require('fs');module.exports=43;",
            )
            .unwrap();
        }
        assert!(
            runtime.open(&plugin, "tool".into(), pending).await.is_err(),
            "{changed}"
        );
        assert!(runtime.sessions.read().is_empty());
        assert!(runtime.openings.lock().is_empty());
        assert!(runtime.server.lock().await.is_none());
    }
}

#[tokio::test]
async fn node_selected_bad_child_does_not_stop_an_already_running_parent_process() {
    let (temp, plugin) = fixture();
    let runtime = Sessions::default();
    let live = runtime
        .open(
            &plugin,
            "tool".into(),
            intent(&runtime, "owner", &plugin, selected(&plugin)),
        )
        .await
        .unwrap();
    let pid = process_id(&live).await;
    let pending = intent(&runtime, "owner", &plugin, selected(&plugin));
    std::fs::write(
        temp.path().join("child/dep.js"),
        "module.exports='changed';",
    )
    .unwrap();
    assert!(runtime.open(&plugin, "tool".into(), pending).await.is_err());
    assert_eq!(runtime.sessions.read().len(), 1);
    assert_eq!(live.runtime.status(), SidecarStatus::Running);
    assert_eq!(pid, process_id(&live).await);
    runtime.close_owner("owner", None).await;
    assert_eq!(live.runtime.status(), SidecarStatus::Stopped);
}

#[tokio::test]
async fn node_selected_cancelled_expired_and_revoked_document_intents_never_open() {
    let (_temp, plugin) = fixture();
    let runtime = Sessions::default();
    let id = runtime
        .create_selected_intent(
            "expired".into(),
            "atools-ui".into(),
            plugin.id.clone(),
            None,
            Some(selected(&plugin)),
        )
        .unwrap();
    runtime.intents.lock().get_mut(&id).unwrap().created =
        Instant::now() - Duration::from_secs(601);
    assert!(runtime
        .take_intent(Some(&id), "atools-ui", &plugin.id)
        .is_err());
    let captured = intent(&runtime, "cancelled", &plugin, selected(&plugin));
    runtime.close_owner("cancelled", None).await;
    assert!(runtime
        .open(&plugin, "tool".into(), captured)
        .await
        .is_err());
    let (document, active) = crate::plugin_page_runtime::test_binding();
    let id = runtime
        .create_selected_intent(
            "document".into(),
            "atools-ui".into(),
            plugin.id.clone(),
            Some(document),
            Some(selected(&plugin)),
        )
        .unwrap();
    let captured = runtime
        .take_intent(Some(&id), "atools-ui", &plugin.id)
        .unwrap();
    active.store(false, Ordering::Release);
    assert!(runtime
        .open(&plugin, "tool".into(), captured)
        .await
        .is_err());
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.server.lock().await.is_none());
}

#[cfg(unix)]
#[test]
fn node_selected_symlink_swap_during_authorization_is_rejected() {
    use std::os::unix::fs::symlink;
    let (temp, plugin) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let selected = selected(&plugin);
    std::fs::write(outside.path().join("dep.js"), "require('fs')").unwrap();
    std::fs::remove_file(temp.path().join("child/dep.js")).unwrap();
    symlink(
        outside.path().join("dep.js"),
        temp.path().join("child/dep.js"),
    )
    .unwrap();
    assert!(selected.revalidate(&plugin).is_err());
}

#[test]
fn node_selected_code_revision_changes_are_rejected_without_recording_anchor_in_tool_schema() {
    let (_temp, plugin) = fixture();
    let db = atools_core::Database::in_memory().unwrap();
    let selected = selected(&plugin);
    selected.validate_revision(&db, &plugin).unwrap();
    crate::plugin_code_revision::CodeRevision::begin(&db, &plugin.id)
        .unwrap()
        .finish(&db)
        .unwrap();
    assert!(selected.validate_revision(&db, &plugin).is_err());
    super::registry::ensure_tool(&db, &plugin).unwrap();
    let tool = db
        .list_agent_tools()
        .unwrap()
        .into_iter()
        .find(|tool| tool.name == super::registry::tool_name(&plugin.id))
        .unwrap();
    let encoded = serde_json::to_string(&tool).unwrap();
    for private in ["selectedPreload", "child/preload.js", plugin.path.as_str()] {
        assert!(!encoded.contains(private));
    }
}

#[test]
fn node_selected_real_english_child_is_observed_without_running_original_preload() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("ZTools-plugins/plugins/english-typing-practice");
    let plugin = load_plugin_from_disk(&root).unwrap();
    assert!(node_entry::select_entry(&plugin).is_err());
    SelectedPreload::capture(&plugin, "preload-app.js", None).unwrap();
}

#[tokio::test]
async fn node_selected_unbound_module_forms_reject_before_creating_authorization_resources() {
    let (temp, plugin) = fixture();
    let runtime = Sessions::default();
    std::fs::write(
        temp.path().join("package.json"),
        r##"{"imports":{"#review":"./alias.js"}}"##,
    )
    .unwrap();
    std::fs::write(temp.path().join("alias.js"), "module.exports=41").unwrap();
    std::fs::create_dir_all(temp.path().join("child/node_modules/review-package")).unwrap();
    std::fs::write(
        temp.path()
            .join("child/node_modules/review-package/index.js"),
        "module.exports=42",
    )
    .unwrap();
    for source in [
        "require('fs');require('review-package')",
        "require('fs');require('#review')",
        "require('fs');require('fs/review')",
        "require('fs');require('node:fs/review')",
        "require('fs');const r=require;window.load=()=>r('#review')",
        "require('fs');const r=window['require'];window.load=()=>r('#review')",
        "require('fs');window?.require('#review')",
        "require('fs');window?.['require']('#review')",
        "require('fs');const r=globalThis?.require;window.load=()=>r('#review')",
        "require('fs');unknown.require('#review')",
        "require('fs');export {value} from './dep.js'",
    ] {
        std::fs::write(temp.path().join("child/preload.js"), source).unwrap();
        assert!(
            SelectedPreload::capture(&plugin, "child/preload.js", None).is_err(),
            "{source}"
        );
        assert!(runtime.intents.lock().is_empty());
        assert!(runtime.sessions.read().is_empty());
        assert!(runtime.openings.lock().is_empty());
        assert!(runtime.server.lock().await.is_none());
    }
    std::fs::write(
        temp.path().join("child/preload.js"),
        "require('fs');require('./dep.js')",
    )
    .unwrap();
    SelectedPreload::capture(&plugin, "child/preload.js", None).unwrap();
}
