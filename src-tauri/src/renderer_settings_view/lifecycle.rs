use std::{sync::Arc, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    AppHandle, Emitter, EventTarget, Manager, Webview, WebviewBuilder, WebviewUrl, Wry,
};
use tokio::time::{timeout_at, Instant};

use super::{
    bundle::{BundleAsset, SettingsBundle},
    cleanup,
    identity::{is_expected_origin, is_expected_settings_url},
    native_appearance,
    phase::SessionPhase,
    preferences::SettingsPreferences,
    presentation::{self, FocusPhase},
    session::{SessionView, SettingsViewRuntime},
    SETTINGS_EVENT,
};

const OPEN_TIMEOUT: Duration = Duration::from_secs(6);
const SETTINGS_HASH: &str = "#/generalSetting";
/// Matches the original renderer's `WINDOW_INITIAL_HEIGHT` header height.
const SETTINGS_HEADER_LOGICAL: u32 = 58;

pub(crate) struct OpenOutcome {
    pub(crate) result: Result<Value, String>,
    pub(crate) dispose_if_unobserved: Option<String>,
}

pub(crate) async fn open(app: AppHandle<Wry>, db: Arc<atools_core::Database>) -> OpenOutcome {
    let _main_drop_opening = crate::renderer_main_drop::settings_start(&app);
    let deadline = Instant::now() + OPEN_TIMEOUT;
    match open_inner(&app, db, deadline).await {
        Ok((result, dispose_if_unobserved)) => OpenOutcome {
            result: Ok(result),
            dispose_if_unobserved,
        },
        Err(error) => OpenOutcome {
            result: Err(error),
            dispose_if_unobserved: None,
        },
    }
}

async fn open_inner(
    app: &AppHandle<Wry>,
    db: Arc<atools_core::Database>,
    deadline: Instant,
) -> Result<(Value, Option<String>), String> {
    let runtime = super::runtime(app)?;
    let open_gate = tokio::time::timeout_at(deadline, runtime.open_gate.lock())
        .await
        .map_err(|_| "Settings view open timed out".to_owned())?;

    if let Some(session) = runtime.current()? {
        if session.signal().phase == SessionPhase::Closing {
            return Err("Settings view is closing; retry after it returns to search".into());
        }
        if session.is_revoked() {
            cleanup::close_session(app, &session.id, "failed").await?;
            return Err("Settings view document was revoked; reopen the settings view".into());
        }
        focus_session(app, &session)?;
        if session.signal().phase == SessionPhase::Opening {
            wait_until_open(&session, deadline).await?;
        }
        return Ok((super::event_payload::build_open_receipt(&session.id), None));
    }

    let bundle = load_bundle(app, &runtime, deadline).await?;
    let accounting = runtime.accounting();
    timeout_at(deadline, accounting.wait_for_writes_to_finish())
        .await
        .map_err(|_| "Settings view waited too long for a prior settings write".to_owned())?;
    let preferences = timeout_at(deadline, SettingsPreferences::load(app, Arc::clone(&db)))
        .await
        .map_err(|_| "Settings view preferences timed out".to_owned())??;
    let preferences = Arc::new(preferences);
    let native = timeout_at(deadline, native_appearance::bootstrap(app, &preferences))
        .await
        .map_err(|_| "Settings view native appearance bootstrap timed out".to_owned())??;
    let (platform, native_runtime) = split_native_runtime(native)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let session = runtime.begin_session(
        id,
        Arc::clone(&bundle),
        preferences,
        native_runtime,
        platform,
    )?;

    let result = prepare_new_session(app, &runtime, &bundle, &session, deadline, open_gate).await;
    match result {
        Ok(result) => Ok((result, Some(session.id))),
        Err(error) => {
            let _ = cleanup::close_session(app, &session.id, "failed").await;
            Err(error)
        }
    }
}

async fn prepare_new_session(
    app: &AppHandle<Wry>,
    runtime: &SettingsViewRuntime,
    bundle: &Arc<SettingsBundle>,
    session: &SessionView,
    deadline: Instant,
    open_gate: tokio::sync::MutexGuard<'_, ()>,
) -> Result<Value, String> {
    timeout_at(
        deadline,
        super::session_material::acquire_for_session(app, runtime, &session.id),
    )
    .await
    .map_err(|_| "Settings window material acquisition timed out".to_owned())??;
    let plugin = plugin_dto(bundle)?;
    emit_phase(app, session, "placeholder", None)?;

    let desired =
        runtime.stage_height(session, session.preferences.default_content_height().await?)?;
    crate::window::resize_settings_content(app, desired)?;
    super::height::confirm_viewport(app, deadline).await?;

    let parent =
        crate::window::main_window(app).map_err(|_| "Main native window is unavailable")?;
    let child = create_child(app, session, desired, &parent)?;
    let lease = match crate::window::attach_settings_child_layout(
        app,
        &child,
        SETTINGS_HEADER_LOGICAL,
        desired,
    ) {
        Ok(lease) => lease,
        Err(_) => {
            let _ = child.close();
            return Err("Settings view child layout could not be attached".into());
        }
    };
    if runtime.install_layout_lease(&session.id, lease).is_err() {
        let _ = child.close();
        return Err("Settings view session ended during child creation".into());
    }

    runtime.mark_opened_with(&session.id, |current| {
        emit_phase(app, current, "opened", Some(plugin.clone()))
    })?;
    focus_session(app, session)?;

    // Let duplicate open requests focus this session while its bounded
    // readiness handshake proceeds.
    drop(open_gate);
    wait_until_ready(session, deadline).await?;
    runtime.mark_open_with(&session.id, |current| {
        emit_phase(app, current, "loaded", None)
    })?;
    Ok(super::event_payload::build_open_receipt(&session.id))
}

pub(super) fn create_child(
    app: &AppHandle<Wry>,
    session: &SessionView,
    desired: f64,
    parent: &tauri::Window<Wry>,
) -> Result<Webview<Wry>, String> {
    if app.get_webview(&session.label).is_some() {
        return Err("Settings view child label is already in use".into());
    }
    let size = parent
        .inner_size()
        .map_err(|_| "Main window viewport is unavailable".to_owned())?;
    let scale = parent
        .scale_factor()
        .map_err(|_| "Main window scale factor is unavailable".to_owned())?;
    let url = tauri::Url::parse(&format!("{}/index.html{SETTINGS_HASH}", session.origin))
        .map_err(|_| "Settings view document URL is invalid".to_owned())?;
    let init = initialization_script(session)?;
    let weak_runtime = Arc::downgrade(
        &app.try_state::<Arc<SettingsViewRuntime>>()
            .map(|state| Arc::clone(state.inner()))
            .ok_or_else(|| "Settings view runtime is unavailable".to_owned())?,
    );
    let label = session.label.clone();
    let id = session.id.clone();
    let recording_app = app.clone();
    let webview_builder = WebviewBuilder::new(session.label.clone(), WebviewUrl::External(url))
        .transparent(cfg!(target_os = "macos"))
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .incognito(true)
        .focused(presentation::allow_focus(
            app,
            FocusPhase::ChildInitialFocus,
        ))
        .initialization_script(init)
        .on_navigation(move |url| {
            if !super::intent_protocol::is_shortcuts_route(url, &id) {
                crate::app_global_shortcuts::recording::cancel(&recording_app, Some(&id));
            }
            if !is_expected_settings_url(url, &id) {
                return false;
            }
            weak_runtime
                .upgrade()
                .and_then(|runtime| runtime.current_for_label(&label).ok())
                .is_some_and(|current| {
                    current.id == id
                        && is_expected_origin(&current.origin, &id)
                        && !current.is_revoked()
                        && current.bundle.revision() == current.bundle_revision
                })
        })
        .on_page_load(on_page_load);
    let child = crate::window::create_settings_child(
        size,
        scale,
        SETTINGS_HEADER_LOGICAL,
        desired,
        |position, size| {
            parent
                .add_child(webview_builder, position, size)
                .map_err(|_| "Settings view child WebView could not be created".to_owned())
        },
    )?;
    super::native_drop::bind_child(app, session, &child)?;
    Ok(child)
}

fn initialization_script(session: &SessionView) -> Result<String, String> {
    let config = json!({
        "version":1,
        "sessionId":session.id,
        "bundleRevision":session.bundle_revision,
        "platform":session.platform,
    });
    let config = escaped_json(&config)?;
    let session_id = escaped_json(&json!(session.id))?;
    Ok(format!(
        "(function(){{\n\
           const config = {config};\n\
           Object.defineProperty(window, '__ATOOLS_SETTINGS_VIEW_CONFIG__', {{value: config, writable: false, configurable: false}});\n\
           let delivered = false;\n\
           Object.defineProperty(window, '__ATOOLS_SETTINGS_DELIVER_OUT__', {{\n\
             value: function() {{\n\
               if (delivered) return false;\n\
               delivered = true;\n\
               try {{ window.dispatchEvent(new Event('atools:settings-out')); }}\n\
               finally {{\n\
                 const internals = window.__TAURI_INTERNALS__;\n\
                 if (internals && typeof internals.invoke === 'function') {{\n\
                   Promise.resolve(internals.invoke('call_renderer_settings', {{sessionId: {session_id}, operation: 'outAcknowledged', payload: {{}}}})).catch(function() {{}});\n\
                 }}\n\
               }}\n\
               return true;\n\
             }}, writable: true, configurable: true\n\
           }});\n\
         }})();"
    ))
}

fn escaped_json(value: &Value) -> Result<String, String> {
    serde_json::to_string(value)
        .map(|value| {
            value
                .replace('<', "\\u003c")
                .replace('>', "\\u003e")
                .replace('&', "\\u0026")
                .replace('\u{2028}', "\\u2028")
                .replace('\u{2029}', "\\u2029")
        })
        .map_err(|_| "Settings view initialization data could not be serialized".into())
}

pub(super) fn split_native_runtime(native: Value) -> Result<(Value, Value), String> {
    let mut object = native
        .as_object()
        .cloned()
        .ok_or_else(|| "Native appearance bootstrap returned an invalid snapshot".to_owned())?;
    let platform = object
        .remove("platform")
        .filter(|value| value.is_string())
        .ok_or_else(|| "Native appearance platform is unavailable".to_owned())?;
    Ok((platform, Value::Object(object)))
}

pub(super) fn plugin_dto(bundle: &SettingsBundle) -> Result<Value, String> {
    let logo = bundle
        .asset("logo.png")
        .filter(|asset| asset.mime == "image/png")
        .ok_or_else(|| "Settings bundle logo is unavailable".to_owned())?;
    let logo = format!("data:image/png;base64,{}", STANDARD.encode(&logo.bytes));
    Ok(json!({
        "name":"setting",
        "title":"设置",
        "logo":logo,
        "path":"atools:internal/setting",
        "cmdName":"设置",
        "subInputPlaceholder":"搜索",
        "subInputVisible":false,
    }))
}

pub(crate) fn emit_phase(
    app: &AppHandle<Wry>,
    session: &SessionView,
    phase: &str,
    plugin: Option<Value>,
) -> Result<(), String> {
    let payload = super::event_payload::build_event_payload(&session.id, phase, plugin)?;
    crate::window::main_webview(app)
        .map_err(|_| "Main renderer is unavailable for settings lifecycle".to_owned())?;
    app.emit_to(EventTarget::webview("main"), super::SETTINGS_EVENT, payload)
        .map_err(|_| "Main renderer did not accept settings lifecycle".to_owned())
}

fn focus_session(app: &AppHandle<Wry>, session: &SessionView) -> Result<(), String> {
    if !presentation::allow_focus(app, FocusPhase::SessionFocus) {
        return Ok(());
    }
    let main =
        crate::window::main_webview(app).map_err(|_| "Main renderer is unavailable".to_owned())?;
    crate::window::focus_main_native_window(app)
        .map_err(|_| "Main native window could not be focused".to_owned())?;
    main.set_focus()
        .map_err(|_| "Main renderer could not be focused".to_owned())?;
    if let Some(child) = app.get_webview(&session.label) {
        child
            .set_focus()
            .map_err(|_| "Settings view could not be focused".to_owned())?;
    }
    Ok(())
}

async fn wait_until_open(session: &SessionView, deadline: Instant) -> Result<(), String> {
    let mut signal = session.subscribe();
    loop {
        let current = signal.borrow().clone();
        if current.phase == SessionPhase::Open {
            return Ok(());
        }
        if current.phase == SessionPhase::Closing || session.is_revoked() {
            return Err("Settings view session closed while opening".into());
        }
        tokio::time::timeout_at(deadline, signal.changed())
            .await
            .map_err(|_| "Settings view did not become ready before its deadline".to_owned())?
            .map_err(|_| "Settings view readiness channel closed".to_owned())?;
    }
}

pub(super) async fn wait_until_ready(
    session: &SessionView,
    deadline: Instant,
) -> Result<(), String> {
    let mut signal = session.subscribe();
    loop {
        let current = signal.borrow().clone();
        if current.ready && current.opened && current.phase == SessionPhase::Opening {
            return Ok(());
        }
        if current.phase == SessionPhase::Closing || session.is_revoked() {
            return Err("Settings view session closed while opening".into());
        }
        tokio::time::timeout_at(deadline, signal.changed())
            .await
            .map_err(|_| "Settings view did not become ready before its deadline".to_owned())?
            .map_err(|_| "Settings view readiness channel closed".to_owned())?;
    }
}

pub(super) async fn load_bundle(
    app: &AppHandle<Wry>,
    runtime: &Arc<SettingsViewRuntime>,
    deadline: Instant,
) -> Result<Arc<SettingsBundle>, String> {
    if let Some(bundle) = runtime.cached_bundle()? {
        return Ok(bundle);
    }
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "Settings bundle resource directory is unavailable".to_owned())?
        .join("ztools-settings");
    if !runtime.begin_bundle_load() {
        return Err("Settings bundle verification is already in progress".into());
    }
    let load_guard = BundleLoadGuard(Arc::clone(runtime));
    let bundle = tokio::time::timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || {
            let _load_guard = load_guard;
            SettingsBundle::load(&root)
        }),
    )
    .await
    .map_err(|_| "Settings bundle verification timed out".to_owned())?
    .map_err(|_| "Settings bundle verifier stopped unexpectedly".to_owned())??;
    runtime.cache_loaded_bundle(Arc::new(bundle))
}

struct BundleLoadGuard(Arc<SettingsViewRuntime>);

impl Drop for BundleLoadGuard {
    fn drop(&mut self) {
        self.0.end_bundle_load();
    }
}

fn runtime_for_webview(webview: &Webview<Wry>) -> Option<Arc<SettingsViewRuntime>> {
    webview
        .app_handle()
        .try_state::<Arc<SettingsViewRuntime>>()
        .map(|state| Arc::clone(state.inner()))
}

pub(crate) fn on_page_load(webview: Webview<Wry>, payload: PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Started || webview.window().label() != "main" {
        return;
    }
    let Some(runtime) = runtime_for_webview(&webview) else {
        return;
    };
    let Ok(session) = runtime.current_for_label(webview.label()) else {
        return;
    };
    if !is_expected_settings_url(payload.url(), &session.id) {
        return;
    }
    let Ok(second_start) = runtime.record_page_started(&session.id) else {
        return;
    };
    if second_start {
        let app = webview.app_handle().clone();
        let id = session.id;
        tauri::async_runtime::spawn(async move {
            let _ = cleanup::close_session(&app, &id, "failed").await;
        });
    }
}

pub(crate) fn ready_snapshot(session: &SessionView, general: Value) -> Result<Value, String> {
    let general_object = general
        .as_object()
        .ok_or_else(|| "General settings snapshot has an invalid shape".to_owned())?;
    if !general_object.get("revision").is_some_and(Value::is_string)
        || !general_object.get("value").is_some_and(Value::is_object)
    {
        return Err("General settings snapshot has an invalid shape".into());
    }
    Ok(json!({
        "version":1,
        "sessionId":session.id,
        "bundleRevision":session.bundle_revision,
        "platform":session.platform,
        "general":general,
        "runtime":session.native_runtime,
        "capabilities":ready_capabilities(),
        "action":{"code":"main","type":"text","payload":""},
    }))
}

pub(super) fn ready_capabilities() -> Value {
    json!({"editableGeneralFields":atools_core::db::RENDERER_GENERAL_SETTINGS_FIELDS})
}

pub(crate) fn session_can_serve(session: &SessionView) -> bool {
    let signal = session.signal();
    !session.is_revoked()
        && signal.phase != SessionPhase::Closing
        && session.bundle.revision() == session.bundle_revision
        && is_expected_origin(&session.origin, &session.id)
}
