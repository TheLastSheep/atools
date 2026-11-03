//! Startup registration is deliberately unable to evaluate plugin code.
use super::*;
use serde_json::json;

#[tokio::test]
async fn registering_builtins_does_not_run_cjs_side_effects_or_invalid_scripts() {
    let scratch = tempfile::tempdir().unwrap();
    let marker = scratch.path().join("must-not-exist");
    let db = Arc::new(Database::in_memory().unwrap());
    for (name, preload) in [
        (
            "registration-cjs",
            format!(
                "require('node:fs').writeFileSync({}, 'executed');",
                serde_json::to_string(&marker).unwrap()
            ),
        ),
        (
            "registration-invalid",
            "this is deliberately invalid JavaScript!!!".to_string(),
        ),
    ] {
        let directory = scratch.path().join(name);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("plugin.json"), serde_json::to_vec(&json!({
            "name":name,"main":"index.html","preload":"preload.cjs",
            "features":[{"code":name,"cmds":[name]}],
            "tools":{"run":{"description":"Invoke only after authorization","inputSchema":{"type":"object"}}}
        })).unwrap()).unwrap();
        std::fs::write(
            directory.join("index.html"),
            "<!doctype html><p>fixture</p>",
        )
        .unwrap();
        std::fs::write(directory.join("preload.cjs"), preload).unwrap();
        load_single_builtin_plugin(&db, &directory).await.unwrap();
    }
    assert_eq!(db.list_plugins().unwrap().len(), 2);
    assert_eq!(db.all_features().unwrap().len(), 2);
    assert!(
        !marker.exists(),
        "Metadata registration executed a Node preload"
    );
    crate::agent_tools::sync_plugin_tools(&db).unwrap();
    assert_eq!(
        db.list_agent_tools()
            .unwrap()
            .iter()
            .filter(|tool| tool.source == "plugin")
            .count(),
        2
    );
    assert!(
        !marker.exists(),
        "Capability discovery executed plugin code"
    );
}

#[tokio::test]
async fn missing_selected_builtin_root_is_a_registration_failure() {
    let scratch = tempfile::tempdir().unwrap();
    let missing = scratch.path().join("selected/resources/plugins/builtin");
    let db = Arc::new(Database::in_memory().unwrap());

    let error = load_builtin_plugins_from_dir(db, &missing)
        .await
        .unwrap_err();

    assert!(error
        .to_string()
        .contains(&missing.to_string_lossy().to_string()));
}

#[tokio::test]
async fn failed_manifest_keeps_previous_builtin_record_and_skips_stale_cleanup() {
    let scratch = tempfile::tempdir().unwrap();
    let stale = scratch
        .path()
        .join("resources/plugins/builtin/stale-builtin");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::write(
        stale.join("plugin.json"),
        serde_json::to_vec(&json!({
            "name":"stale-builtin",
            "version":"1.0.0",
            "main":"index.html",
            "features":[{"code":"stale-builtin","cmds":["stale"]}]
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(stale.join("index.html"), "<p>fixture</p>").unwrap();

    let failed_root = scratch.path().join("failed-bundle/plugins/builtin");
    let broken = failed_root.join("broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join("plugin.json"), "{").unwrap();

    let db = Arc::new(Database::in_memory().unwrap());
    let stale_id = load_single_builtin_plugin(&db, &stale).await.unwrap();

    let error = load_builtin_plugins_from_dir(Arc::clone(&db), &failed_root)
        .await
        .unwrap_err();

    assert!(error
        .to_string()
        .contains("Failed to register 1 builtin plugin"));
    assert!(db.get_plugin(&stale_id).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn dangling_directory_symlink_fails_scan_without_cascading_existing_data() {
    fn write_plugin(directory: &std::path::Path, name: &str) {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(
            directory.join("plugin.json"),
            serde_json::to_vec(&json!({
                "name": name,
                "version": "1.0.0",
                "main": "index.html",
                "features": [{"code": name, "cmds": [name]}]
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(directory.join("index.html"), "<p>fixture</p>").unwrap();
    }

    let scratch = tempfile::tempdir().unwrap();
    let stale = scratch
        .path()
        .join("resources/plugins/builtin/stale-builtin");
    write_plugin(&stale, "stale-builtin");

    let db = Arc::new(Database::in_memory().unwrap());
    let stale_id = load_single_builtin_plugin(&db, &stale).await.unwrap();
    db.plugin_data_put(
        &stale_id,
        &atools_core::models::Document {
            id: "preserve-me".into(),
            rev: None,
            data: json!({"value": "still present"}),
        },
    )
    .unwrap();

    let failed_root = scratch.path().join("failed-bundle/plugins/builtin");
    std::fs::create_dir_all(&failed_root).unwrap();
    std::fs::write(failed_root.join("ordinary-file.txt"), "ignored").unwrap();

    let linked_target = scratch.path().join("valid-linked-plugin");
    write_plugin(&linked_target, "valid-linked-plugin");
    std::os::unix::fs::symlink(&linked_target, failed_root.join("valid-plugin-link")).unwrap();

    let dangling_link = failed_root.join("dangling-plugin-link");
    std::os::unix::fs::symlink(scratch.path().join("missing-plugin-target"), &dangling_link)
        .unwrap();
    assert_eq!(
        tokio::fs::metadata(&dangling_link)
            .await
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::NotFound,
        "fixture must exercise the actual metadata read error path"
    );

    let error = load_builtin_plugins_from_dir(Arc::clone(&db), &failed_root)
        .await
        .unwrap_err();

    assert!(error
        .to_string()
        .contains("Failed to register 1 builtin plugin"));
    assert!(db.get_plugin(&stale_id).is_ok());
    assert_eq!(
        db.plugin_data_get(&stale_id, "preserve-me")
            .unwrap()
            .unwrap()
            .data["value"],
        "still present"
    );
    let linked_id = load_plugin_from_disk(&linked_target).unwrap().id;
    assert!(db.get_plugin(&linked_id).is_ok());
}
