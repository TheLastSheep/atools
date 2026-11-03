use super::{
    native, options, privacy,
    registry::{self, Access},
    sessions::Sessions,
    source_hint,
    types::{Binding, Invocation, Owner},
};
use atools_core::{agent::PermissionScope, Database, Plugin};
use serde_json::json;
use std::sync::{atomic::AtomicBool, Arc};
pub(super) fn fixture() -> (Database, Plugin, Arc<Sessions>, Owner, Binding) {
    let db = Database::in_memory().unwrap();
    let plugin: Plugin = serde_json::from_value(json!({"id":"dialog-fixture","name":"dialog-fixture","version":"1.0.0","path":"/inert","enabled":true,"manifest":{"name":"dialog-fixture","version":"1.0.0","main":"index.html"},"created_at":"now","updated_at":"now"})).unwrap();
    db.save_plugin(&plugin).unwrap();
    let owner = Owner::new("main", &plugin.id, &uuid::Uuid::new_v4().to_string()).unwrap();
    let binding = Binding::current(&db, &plugin).unwrap();
    (db, plugin, Arc::new(Sessions::default()), owner, binding)
}
fn open(
    runtime: &Arc<Sessions>,
    owner: &Owner,
    binding: &Binding,
    access: Access,
) -> Arc<super::types::Session> {
    let intent = runtime
        .intent(
            runtime.begin(owner.clone()).unwrap(),
            binding.clone(),
            access,
        )
        .unwrap();
    runtime.open(&intent, binding).unwrap()
}
#[test]
fn dialog_tools_have_independent_file_scopes_and_exact_source_identity() {
    let (db, plugin, _, _, _) = fixture();
    assert_ne!(
        registry::tool_name(&plugin.id, Access::Open),
        registry::tool_name(&plugin.id, Access::Save)
    );
    for (access, scope) in [
        (Access::Open, PermissionScope::FileRead),
        (Access::Save, PermissionScope::FileWrite),
    ] {
        let name = registry::ensure_tool(&db, &plugin, access).unwrap();
        let mut tool = db.get_agent_tool(&name).unwrap().unwrap();
        assert_eq!(tool.scopes, vec![scope]);
        assert_eq!(registry::access_for(&tool).unwrap(), access);
        tool.plugin_id = Some("different".into());
        assert!(registry::access_for(&tool).is_err());
        tool.plugin_id = Some(plugin.id.clone());
        tool.scopes.push(PermissionScope::Shell);
        assert!(registry::access_for(&tool).is_err());
    }
}
#[test]
fn preparation_close_and_generation_handoff_cannot_revive_a_late_intent() {
    for mode in 0..4 {
        let (_, plugin, runtime, owner, binding) = fixture();
        let preparation = runtime.begin(owner.clone()).unwrap();
        match mode {
            0 => {
                runtime.close(Some(&owner), None, None, false);
            }
            1 => {
                runtime.close(None, Some(&plugin.id), None, false);
            }
            2 => {
                runtime.close(None, None, Some("main"), false);
            }
            _ => {
                runtime.close(None, None, None, true);
            }
        }
        assert!(runtime.intent(preparation, binding, Access::Open).is_err());
        assert_eq!(runtime.counts(), (0, 0, 0, 0));
    }
}
#[test]
fn open_and_save_sessions_rotate_together_without_bearers_and_old_close_revokes_successor() {
    let (_, _, runtime, owner, binding) = fixture();
    let first = open(&runtime, &owner, &binding, Access::Open);
    let second = open(&runtime, &owner, &binding, Access::Save);
    let next = Owner::new("main", &owner.plugin, &uuid::Uuid::new_v4().to_string()).unwrap();
    let sessions = runtime.rotate(&owner, next).unwrap();
    assert_eq!(sessions.len(), 2);
    assert!(runtime.get(&first.id).is_err());
    assert!(runtime.by_token(&second.token).is_none());
    assert!(!*first.active.lock());
    assert!(runtime.begin(owner.clone()).is_err());
    runtime.close(Some(&owner), None, None, false);
    assert_eq!(runtime.counts(), (0, 0, 0, 0));
}
#[test]
fn private_dialog_options_paths_and_unclaimed_metadata_never_enter_durable_arguments() {
    let (_, plugin, runtime, owner, binding) = fixture();
    let session = open(&runtime, &owner, &binding, Access::Open);
    let invocation = Arc::new(Invocation {
        session: session.id.clone(),
        request: json!({"method":"showOpenDialog","options":{"defaultPath":"/private/fixture-name"}}),
        claimed: AtomicBool::new(false),
        cancel: native::Cancellation::default(),
        run: parking_lot::Mutex::new(Some("run".into())),
        result: parking_lot::Mutex::new(None),
    });
    runtime
        .store
        .lock()
        .invocations
        .insert("ticket".into(), invocation.clone());
    let metadata = json!({"operation":"request","sessionId":session.id,"invocationId":"ticket","method":"showOpenDialog"});
    assert!(privacy::validate(&runtime, &plugin.id, &session.tool, &metadata).is_ok());
    let mut private = metadata.clone();
    private["options"] = json!({"defaultPath":"secret"});
    assert!(privacy::validate(&runtime, &plugin.id, &session.tool, &private).is_err());
    private = metadata;
    private["method"] = json!("showSaveDialog");
    assert!(privacy::validate(&runtime, &plugin.id, &session.tool, &private).is_err());
    let next = Owner::new("main", &owner.plugin, &uuid::Uuid::new_v4().to_string()).unwrap();
    assert!(runtime.rotate(&owner, next).is_err());
    assert!(runtime
        .close(Some(&owner), None, None, false)
        .contains(&"run".into()));
    assert!(invocation.cancel.cancelled());
    assert_eq!(runtime.counts(), (0, 0, 0, 0));
}
#[test]
fn native_panel_quotas_are_one_per_window_four_global_and_release_immediately() {
    let state = Arc::new(native::State::default());
    let mut leases = Vec::new();
    let first = state.reserve("window-0").unwrap();
    assert!(state.reserve("window-0").is_err());
    drop(first);
    for index in 0..4 {
        leases.push(state.reserve(&format!("window-{index}")).unwrap());
    }
    assert_eq!(state.count(), 4);
    assert!(state.reserve("window-0").is_err());
    assert!(state.reserve("window-4").is_err());
    leases.pop();
    assert!(!state.active("window-3"));
    leases.push(state.reserve("window-4").unwrap());
    drop(leases);
    assert_eq!(state.count(), 0);
}
#[test]
fn options_preserve_file_tree_shapes_and_reject_unsupported_or_over_budget_values() {
    let opened = options::Options::parse(
        &json!({"title":"选择文件夹","properties":["openDirectory"]}),
        Access::Open,
    )
    .unwrap();
    assert!(opened.has("openDirectory"));
    assert!(!opened.has("openFile"));
    let saved = options::Options::parse(
        &json!({"defaultPath":"fixed@2x.png","filters":[{"name":"PNG","extensions":["png"]}]}),
        Access::Save,
    )
    .unwrap();
    assert_eq!(saved.extensions(), vec!["png"]);
    for value in [
        json!({"properties":["multiSelections"]}),
        json!({"securityScopedBookmarks":true}),
        json!({"privateUnknown":"s"}),
        json!({"filters":[{"name":"bad","extensions":["../txt"]}]}),
        json!({"title":"s".repeat(33000)}),
    ] {
        assert!(options::Options::parse(&value, Access::Save).is_err());
    }
    assert!(options::Options::parse(
        &json!({"filters":vec![json!({"name":"f","extensions":["txt"]});33]}),
        Access::Open
    )
    .is_err());
    assert!(options::Options::parse(
        &json!({"filters":[{"name":"f","extensions":vec!["txt";65]}]}),
        Access::Open
    )
    .is_err());
}
#[test]
fn selection_budget_bounds_count_path_bytes_and_total_and_allows_real_cancel() {
    assert!(options::validate_result(&[], Access::Open).is_ok());
    assert!(options::validate_result(&[], Access::Save).is_ok());
    assert!(options::validate_result(&["/one".into(), "/two".into()], Access::Save).is_err());
    assert!(options::validate_result(&vec!["/one".into(); 129], Access::Open).is_err());
    assert!(options::validate_result(&vec!["s".repeat(16384); 33], Access::Open).is_err());
    assert!(options::validate_result(&["s".repeat(16385)], Access::Open).is_err());
}
#[test]
fn source_hints_are_directional_bounded_and_do_not_execute_package_code() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("main.js"),
        "throw new Error('not executed'); ztools.showOpenDialog({})",
    )
    .unwrap();
    assert_eq!(
        source_hint::inspect(&std::fs::canonicalize(temp.path()).unwrap(), Access::Open),
        source_hint::Usage::Detected
    );
    assert_eq!(
        source_hint::inspect(&std::fs::canonicalize(temp.path()).unwrap(), Access::Save),
        source_hint::Usage::NotDetected
    );
    std::fs::write(
        temp.path().join("large.js"),
        vec![b'x'; 2 * 1024 * 1024 + 1],
    )
    .unwrap();
    assert_eq!(
        source_hint::inspect(&std::fs::canonicalize(temp.path()).unwrap(), Access::Save),
        source_hint::Usage::Unknown
    );
}
#[test]
fn preparation_intent_and_session_quotas_are_bounded_without_idle_expiration_worker() {
    let (_, _, runtime, owner, binding) = fixture();
    let preparations = (0..32)
        .map(|_| runtime.begin(owner.clone()).unwrap())
        .collect::<Vec<_>>();
    assert!(runtime.begin(owner.clone()).is_err());
    drop(preparations);
    assert_eq!(runtime.counts(), (0, 0, 0, 0));
    for _ in 0..32 {
        runtime
            .intent(
                runtime.begin(owner.clone()).unwrap(),
                binding.clone(),
                Access::Open,
            )
            .unwrap();
    }
    assert!(runtime
        .intent(
            runtime.begin(owner.clone()).unwrap(),
            binding.clone(),
            Access::Open
        )
        .is_err());
    for intent in runtime.store.lock().intents.values_mut() {
        intent.created = std::time::Instant::now() - std::time::Duration::from_secs(601);
    }
    runtime.expire_intents();
    assert_eq!(runtime.counts(), (0, 0, 0, 0));
    for index in 0..32 {
        let owner = Owner::new(
            &format!("window-{index}"),
            &owner.plugin,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        open(&runtime, &owner, &binding, Access::Open);
    }
    let overflow =
        Owner::new("overflow", &owner.plugin, &uuid::Uuid::new_v4().to_string()).unwrap();
    let intent = runtime
        .intent(
            runtime.begin(overflow).unwrap(),
            binding.clone(),
            Access::Open,
        )
        .unwrap();
    assert!(runtime.open(&intent, &binding).is_err());
    runtime.close(None, None, None, true);
    assert_eq!(runtime.counts(), (0, 0, 0, 0));
}
