//! The production execute caller with real SQLite CAS and the shared typed OS port.
use super::tests::Port;
use super::*;
use crate::general_settings_runtime::app_shortcut_registry::ShortcutPort;
use atools_core::db::{
    AppGlobalShortcutMutation, AppGlobalShortcutSnapshot, Database, RendererAppIdentity,
    RendererDirectSubtype, APP_GLOBAL_SHORTCUTS_KEY,
};
use serde_json::{json, Value};
use tauri_plugin_global_shortcut::Shortcut;
fn create(path: &str, key: &str) -> AppGlobalShortcutMutation {
    AppGlobalShortcutMutation::Create {
        target: RendererAppIdentity {
            path: path.into(),
            name: "Same".into(),
            sub_type: RendererDirectSubtype::App,
        },
        shortcut: key.into(),
        enabled: true,
    }
}
fn token(db: &Database, rt: &Runtime) -> String {
    wire::projection(rt, &db.read_renderer_app_global_shortcuts().unwrap()).unwrap()["revision"]
        .as_str()
        .unwrap()
        .into()
}
fn live(
    snapshot: &AppGlobalShortcutSnapshot,
) -> Result<Vec<atools_core::db::AppGlobalShortcutBinding>, String> {
    Ok(snapshot.bindings.clone())
}
fn execute(
    db: &Database,
    rt: &Arc<Runtime>,
    port: &mut Port,
    change: AppGlobalShortcutMutation,
) -> Value {
    transaction::execute(
        rt,
        db,
        token(db, rt),
        change,
        port,
        &live,
        &|| true,
        &|| true,
    )
    .unwrap()
}
#[test]
fn committed_create_notification_loss_is_durable_and_cannot_be_replayed_with_old_token() {
    let db = Database::in_memory().unwrap();
    let rt = Arc::new(Runtime::default());
    let mut port = Port::default();
    let revision = token(&db, &rt);
    let reply = transaction::execute(
        &rt,
        &db,
        revision.clone(),
        create("/A.app", "Alt+1"),
        &mut port,
        &live,
        &|| true,
        &|| false,
    )
    .unwrap();
    assert_eq!(reply["persisted"], true);
    assert_eq!(reply["runtimeApplied"], true);
    assert_eq!(reply["notificationDelivered"], false);
    assert_eq!(port.bindings.len(), 1);
    assert!(transaction::execute(
        &rt,
        &db,
        revision,
        create("/A.app", "Alt+1"),
        &mut port,
        &live,
        &|| true,
        &|| true
    )
    .is_err());
    assert_eq!(
        db.read_renderer_app_global_shortcuts()
            .unwrap()
            .bindings
            .len(),
        1
    );
    let id = db.read_renderer_app_global_shortcuts().unwrap().bindings[0]
        .row_id
        .clone();
    assert_eq!(
        execute(
            &db,
            &rt,
            &mut port,
            AppGlobalShortcutMutation::SetEnabled {
                row_id: id.clone(),
                enabled: false
            }
        )["persisted"],
        true
    );
    assert!(port.bindings.is_empty());
    assert!(rt.published.lock().is_empty());
    assert_eq!(
        execute(
            &db,
            &rt,
            &mut port,
            AppGlobalShortcutMutation::Remove { row_id: id }
        )["persisted"],
        true
    );
    assert!(db
        .read_renderer_app_global_shortcuts()
        .unwrap()
        .bindings
        .is_empty());
}
struct BarrierPort<'a> {
    port: Port,
    on_register: Box<dyn FnMut() + 'a>,
}
impl ShortcutPort<BindingTarget> for BarrierPort<'_> {
    fn is_registered(&self, key: Shortcut) -> Result<bool, String> {
        self.port.is_registered(key)
    }
    fn register(&mut self, key: Shortcut, target: &BindingTarget) -> Result<(), String> {
        self.port.register(key, target)?;
        (self.on_register)();
        Ok(())
    }
    fn unregister(&mut self, key: Shortcut) -> Result<(), String> {
        self.port.unregister(key)
    }
}
#[test]
fn provisional_callback_is_unpublished_and_late_child_close_rolls_os_and_db_back() {
    let db = Database::in_memory().unwrap();
    let rt = Arc::new(Runtime::default());
    let caller = AtomicBool::new(true);
    let key = token(&db, &rt);
    let mut port = BarrierPort {
        port: Port::default(),
        on_register: Box::new(|| {
            assert!(rt.published.lock().is_empty());
            caller.store(false, Ordering::Release);
        }),
    };
    let reply = transaction::execute(
        &rt,
        &db,
        key,
        create("/A.app", "Alt+1"),
        &mut port,
        &live,
        &|| caller.load(Ordering::Acquire),
        &|| true,
    )
    .unwrap();
    assert_eq!(reply["persisted"], false);
    assert_eq!(reply["changed"], false);
    assert!(reply["error"].is_object());
    assert!(db
        .read_renderer_app_global_shortcuts()
        .unwrap()
        .bindings
        .is_empty());
    assert!(port.port.bindings.is_empty());
    assert!(rt.published.lock().is_empty());
}
#[test]
fn concurrent_raw_write_at_os_barrier_cannot_commit_stale_plan_or_publish_dispatch() {
    let db = Database::in_memory().unwrap();
    let rt = Arc::new(Runtime::default());
    let key = token(&db, &rt);
    let mut port = BarrierPort {
        port: Port::default(),
        on_register: Box::new(|| {
            db.set_setting(
                APP_GLOBAL_SHORTCUTS_KEY,
                "[ {\"id\":\"legacy\",\"target\":\"unknown\"} ]",
            )
            .unwrap();
        }),
    };
    let reply = transaction::execute(
        &rt,
        &db,
        key,
        create("/A.app", "Alt+1"),
        &mut port,
        &live,
        &|| true,
        &|| true,
    )
    .unwrap();
    assert_eq!(reply["persisted"], false);
    assert_eq!(reply["changed"], false);
    assert!(port.port.bindings.is_empty());
    assert!(rt.published.lock().is_empty());
    assert_eq!(reply["snapshot"]["rows"][0]["id"], "legacy");
}
#[test]
fn failed_os_apply_restores_actual_old_binding_with_new_runtime_generation() {
    let db = Database::in_memory().unwrap();
    let rt = Arc::new(Runtime::default());
    let mut port = Port::default();
    execute(&db, &rt, &mut port, create("/A.app", "Alt+1"));
    let old = port.bindings.values().next().unwrap().clone();
    let revision = token(&db, &rt);
    port.fail = Some(registry::validated_key("Alt+2").unwrap().id());
    let reply = transaction::execute(
        &rt,
        &db,
        revision,
        create("/B.app", "Alt+2"),
        &mut port,
        &live,
        &|| true,
        &|| true,
    )
    .unwrap();
    assert_eq!(reply["persisted"], false);
    let current = port.bindings.values().next().unwrap();
    assert_eq!(current.row_id, old.row_id);
    assert_ne!(current.epoch, old.epoch);
    assert_eq!(rt.published.lock().get(&current.row_id), Some(current));
    assert_eq!(
        db.read_renderer_app_global_shortcuts()
            .unwrap()
            .bindings
            .len(),
        1
    );
}
#[test]
fn wire_true_autocopy_is_explicitly_rejected_before_catalog_or_os() {
    let change:MutationRequest=serde_json::from_value(json!({"kind":"create","shortcut":"Alt+1","enabled":true,"autoCopy":true,"target":{"kind":"app","path":"/fake.app","name":"Fake"}})).unwrap();
    assert!(change
        .resolve(&crate::launcher_app_catalog_source::LauncherAppCatalogSource::default())
        .unwrap_err()
        .contains("AUTOCOPY_UNSUPPORTED"));
}
