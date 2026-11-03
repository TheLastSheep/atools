use super::{
    registry::{self, Access},
    resolver, source_hint,
    store::{self, Binding, Owner, Runtime},
};
use atools_core::{config::AppConfig, Database, Plugin};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn fixture() -> (Database, Plugin, Arc<Runtime>, Owner, Binding) {
    let db = Database::in_memory().unwrap();
    let plugin: Plugin = serde_json::from_value(json!({"id":"paths-fixture","name":"paths-fixture","version":"1.0.0","path":"/inert","enabled":true,"manifest":{"name":"paths-fixture","version":"1.0.0","main":"index.html"},"created_at":"now","updated_at":"now"})).unwrap();
    db.save_plugin(&plugin).unwrap();
    let owner = Owner::new("main", &plugin.id, &store::id()).unwrap();
    let binding = Binding::current(&db, &plugin).unwrap();
    (db, plugin, Arc::new(Runtime::default()), owner, binding)
}
fn publish(runtime: &Arc<Runtime>, owner: Owner, binding: Binding, access: Access) -> String {
    let intent = runtime
        .intent(runtime.begin(owner).unwrap(), binding.clone(), access)
        .unwrap();
    runtime
        .publish(
            &intent,
            &binding,
            resolver::Paths::from([("home".into(), "/private/fixture".into())]),
        )
        .unwrap()
}

#[test]
fn path_snapshot_standard_contract_has_real_host_metadata_and_no_directory_creation() {
    let temp = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(temp.path().join("host"));
    let paths = resolver::standard(&config).unwrap();
    assert_eq!(paths.len(), 12);
    assert_eq!(paths["temp"], std::env::temp_dir().to_string_lossy());
    assert_eq!(
        paths["exe"],
        std::env::current_exe().unwrap().to_string_lossy()
    );
    assert_eq!(paths["userData"], config.base_dir().to_string_lossy());
    assert_eq!(
        paths["logs"],
        config.base_dir().join("logs").to_string_lossy()
    );
    assert!(!config.base_dir().exists());
    assert!(!paths.contains_key("pluginData"));
}
#[test]
fn path_snapshot_plugin_directory_is_actual_stable_and_separate_from_host_or_source() {
    let temp = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(temp.path().to_path_buf());
    let first = resolver::plugin_data(&config, "../untrusted-id").unwrap();
    let second = resolver::plugin_data(&config, "../untrusted-id").unwrap();
    assert_eq!(first, second);
    let path = std::path::Path::new(&first["pluginData"]);
    assert!(path.is_dir());
    assert_eq!(
        path.parent().unwrap(),
        std::fs::canonicalize(temp.path())
            .unwrap()
            .join("plugin-data")
    );
    assert_eq!(path.file_name().unwrap().to_str().unwrap().len(), 64);
    assert_ne!(resolver::plugin_data(&config, "other").unwrap(), first);
}
#[cfg(unix)]
#[test]
fn path_snapshot_directory_never_follows_root_or_target_symlinks() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(temp.path().to_path_buf());
    symlink(outside.path(), temp.path().join("plugin-data")).unwrap();
    assert!(resolver::plugin_data(&config, "fixture").is_err());
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    std::fs::remove_file(temp.path().join("plugin-data")).unwrap();
    let actual = resolver::plugin_data(&config, "fixture").unwrap();
    let target = &actual["pluginData"];
    std::fs::remove_dir(target).unwrap();
    symlink(outside.path(), target).unwrap();
    assert!(resolver::plugin_data(&config, "fixture").is_err());
    let base_link = temp.path().join("linked-host");
    symlink(outside.path(), &base_link).unwrap();
    assert!(resolver::plugin_data(&AppConfig::with_base_dir(base_link), "fixture").is_err());
}
#[test]
fn path_snapshot_budget_rejects_without_values_in_errors() {
    let secret = "private-fixture".repeat(2048);
    let error = resolver::validate_paths(&resolver::Paths::from([("home".into(), secret.clone())]))
        .unwrap_err();
    assert!(!error.contains(&secret));
    assert!(resolver::validate_paths(&resolver::Paths::from([(
        "arbitrary-name".into(),
        "fixture".into()
    )]))
    .is_err());
    let paths = resolver::STANDARD_NAMES
        .into_iter()
        .map(|n| (n.to_string(), "x".repeat(resolver::MAX_PATH_BYTES)))
        .collect();
    assert!(resolver::validate_paths(&paths).is_err());
}
#[test]
fn path_snapshot_private_task_input_has_only_the_one_shot_intent() {
    let id = store::id();
    assert_eq!(
        super::prepare_intent(&json!({"operation":"prepare","intentId":id})).unwrap(),
        id
    );
    for value in [
        json!({"operation":"prepare","intentId":id,"paths":{"home":"private"}}),
        json!({"operation":"prepare","intentId":"/private/value"}),
        json!({"operation":"execute","intentId":id}),
    ] {
        let error = super::prepare_intent(&value).unwrap_err();
        assert!(!error.contains("/private/value"));
    }
}
#[test]
fn path_snapshot_tools_have_separate_metadata_and_plugin_data_permissions() {
    let (db, plugin, _, _, _) = fixture();
    for access in [Access::Standard, Access::PluginData] {
        let name = registry::ensure_tool(&db, &plugin, access).unwrap();
        let mut tool = db.get_agent_tool(&name).unwrap().unwrap();
        assert_eq!(registry::access_for(&tool).unwrap(), access);
        tool.scopes.clear();
        assert!(registry::access_for(&tool).is_err());
    }
    assert_ne!(
        registry::tool_name(&plugin.id, Access::Standard),
        registry::tool_name(&plugin.id, Access::PluginData)
    );
}
#[test]
fn path_snapshot_close_cancels_every_pending_phase_and_no_late_publish_survives() {
    for mode in 0..4 {
        let (_, plugin, runtime, owner, binding) = fixture();
        let preparation = runtime.begin(owner.clone()).unwrap();
        let intent = runtime
            .intent(
                runtime.begin(owner.clone()).unwrap(),
                binding.clone(),
                Access::Standard,
            )
            .unwrap();
        *runtime.0.lock().intents[&intent].run.lock() = Some("pending-run".into());
        publish(&runtime, owner.clone(), binding.clone(), Access::PluginData);
        let runs = match mode {
            0 => runtime.close(Some(&owner), None, None, false),
            1 => runtime.close(None, Some(&plugin.id), None, false),
            2 => runtime.close(None, None, Some("main"), false),
            _ => runtime.close(None, None, None, true),
        };
        assert_eq!(runs, vec!["pending-run"]);
        assert!(runtime
            .intent(preparation, binding.clone(), Access::Standard)
            .is_err());
        assert!(runtime
            .publish(&intent, &binding, resolver::Paths::new())
            .is_err());
        assert!(runtime.0.lock().snapshots.is_empty());
    }
}
#[test]
fn path_snapshot_expired_or_consumed_intent_cannot_publish() {
    let (_, _, runtime, owner, binding) = fixture();
    let intent = runtime
        .intent(
            runtime.begin(owner.clone()).unwrap(),
            binding.clone(),
            Access::Standard,
        )
        .unwrap();
    runtime.0.lock().intents.get_mut(&intent).unwrap().created =
        Instant::now() - Duration::from_secs(61);
    assert!(runtime
        .publish(&intent, &binding, resolver::Paths::new())
        .is_err());
    let intent = runtime
        .intent(
            runtime.begin(owner).unwrap(),
            binding.clone(),
            Access::Standard,
        )
        .unwrap();
    runtime
        .publish(&intent, &binding, resolver::Paths::new())
        .unwrap();
    assert!(runtime
        .publish(&intent, &binding, resolver::Paths::new())
        .is_err());
}
#[test]
fn path_snapshot_explicit_rotation_keeps_approval_and_old_close_revokes_successor() {
    let (_, plugin, runtime, old, binding) = fixture();
    let snapshot = publish(&runtime, old.clone(), binding, Access::Standard);
    let next = Owner::new("main", &plugin.id, &store::id()).unwrap();
    runtime.rotate(&old, next.clone()).unwrap();
    assert_eq!(runtime.0.lock().snapshots[&snapshot].owner, next);
    assert!(runtime.begin(old.clone()).is_err());
    runtime.close(Some(&old), None, None, false);
    assert!(runtime.0.lock().snapshots.is_empty());
}
#[test]
fn path_snapshot_binding_rejects_disabled_changed_and_relocated_plugins() {
    let (db, mut plugin, _, _, binding) = fixture();
    for kind in 0..3 {
        let original = plugin.clone();
        match kind {
            0 => plugin.enabled = false,
            1 => plugin.version = "other".into(),
            _ => plugin.path = "/other".into(),
        };
        db.save_plugin(&plugin).unwrap();
        assert!(binding.validate(&db, &plugin.id).is_err());
        plugin = original;
        db.save_plugin(&plugin).unwrap();
    }
    crate::plugin_code_revision::CodeRevision::begin(&db, &plugin.id)
        .unwrap()
        .finish(&db)
        .unwrap();
    assert!(binding.validate(&db, &plugin.id).is_err());
}

#[test]
fn path_snapshot_capacity_and_expiry_bound_private_memory_without_idle_timers() {
    let (_, _, runtime, owner, binding) = fixture();
    let preparations = (0..store::CAPACITY)
        .map(|_| runtime.begin(owner.clone()).unwrap())
        .collect::<Vec<_>>();
    assert!(runtime.begin(owner.clone()).is_err());
    drop(preparations);
    for _ in 0..store::CAPACITY {
        runtime
            .intent(
                runtime.begin(owner.clone()).unwrap(),
                binding.clone(),
                Access::Standard,
            )
            .unwrap();
    }
    assert!(runtime
        .intent(runtime.begin(owner).unwrap(), binding, Access::Standard)
        .is_err());
    for intent in runtime.0.lock().intents.values_mut() {
        intent.created = Instant::now() - Duration::from_secs(61);
        *intent.run.lock() = Some("expired-run".into());
    }
    assert_eq!(runtime.expire().len(), store::CAPACITY);
    assert!(runtime.0.lock().intents.is_empty());
}
#[test]
fn path_snapshot_source_hints_are_bounded_non_executing_and_revision_invalidated() {
    let temp = tempfile::tempdir().unwrap();
    let (db, mut plugin, _, _, _) = fixture();
    plugin.path = temp.path().to_string_lossy().into_owned();
    db.save_plugin(&plugin).unwrap();
    std::fs::write(
        temp.path().join("preload.js"),
        "window.ztools.getPath('pluginData'); throw new Error('must not run')",
    )
    .unwrap();
    let hints = source_hint::Hints::default();
    let usage = hints.scan(&plugin, Some("revision-a"));
    assert!(usage.standard && usage.plugin_data);
    std::fs::write(temp.path().join("preload.js"), "window.title='pure web'").unwrap();
    assert!(hints.scan(&plugin, Some("revision-a")).standard);
    assert!(!hints.scan(&plugin, Some("revision-b")).standard);
    hints.invalidate(Some(&plugin.id));
    assert!(!hints.scan(&plugin, Some("revision-a")).standard);
    std::fs::write(
        temp.path().join("large.js"),
        vec![b'x'; 2 * 1024 * 1024 + 1],
    )
    .unwrap();
    assert!(hints.scan(&plugin, None).unknown);
}
