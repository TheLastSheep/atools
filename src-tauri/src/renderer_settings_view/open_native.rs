//! Owned, staged construction of the Settings child.
use super::{
    lifecycle,
    main_authority::CapturedMain,
    native_appearance,
    open_claims::{CommitToken, SessionKey},
    preferences::SettingsPreferences,
    session::{SessionView, SettingsViewRuntime},
};
use serde_json::Value;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Wry};
use tokio::time::{timeout_at, Instant};

const OPEN_TIMEOUT: Duration = Duration::from_secs(6);
const HEADER: u32 = 58;

async fn stage<T: Send + 'static>(
    app: &AppHandle<Wry>,
    runtime: Arc<SettingsViewRuntime>,
    main: CapturedMain,
    key: SessionKey,
    work: impl FnOnce(
            &AppHandle<Wry>,
            &CapturedMain,
            &SettingsViewRuntime,
            &CommitToken,
        ) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let task_app = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let token = runtime.begin_owned_stage(main.key, &key)?;
            let owner_app = task_app.clone();
            let owner_runtime = Arc::clone(&runtime);
            let owner_key = key.clone();
            let _owner = super::open_coordination::StageGuard::new(move || {
                if let Some(ticket) = owner_runtime.end_owned_stage(&owner_key) {
                    super::open_service::cleanup_tickets(&owner_app, vec![ticket]);
                }
            });
            main.validate(&task_app)
                .map_err(|_| "Captured Main is no longer active")?;
            let value = work(&task_app, &main, &runtime, &token)?;
            runtime.finish_open_stage(&token)?;
            Ok(value)
        })();
        let _ = send.send(result);
    })
    .map_err(|_| "Settings main-thread stage could not be scheduled")?;
    receive
        .await
        .map_err(|_| "Settings main-thread stage stopped before replying".to_owned())?
}

fn check(
    runtime: &SettingsViewRuntime,
    main: &CapturedMain,
    key: &SessionKey,
) -> Result<(), String> {
    runtime.admit_open_stage(main.key, key).map(|_| ())
}

pub(crate) async fn construct(
    app: AppHandle<Wry>,
    db: Arc<atools_core::Database>,
    main: CapturedMain,
    key: SessionKey,
    revoked: Arc<AtomicBool>,
) -> Result<Value, String> {
    let _main_drop_opening = crate::renderer_main_drop::settings_start(&app);
    let runtime = super::runtime(&app)?;
    let deadline = Instant::now() + OPEN_TIMEOUT;
    check(&runtime, &main, &key)?;
    let bundle = lifecycle::load_bundle(&app, &runtime, deadline).await?;
    check(&runtime, &main, &key)?;
    let accounting = runtime.accounting();
    timeout_at(deadline, accounting.wait_for_writes_to_finish())
        .await
        .map_err(|_| "Settings view waited too long for a prior settings write")?;
    check(&runtime, &main, &key)?;
    let preferences = Arc::new(
        timeout_at(deadline, SettingsPreferences::load(&app, db))
            .await
            .map_err(|_| "Settings view preferences timed out")??,
    );
    check(&runtime, &main, &key)?;
    let appearance = timeout_at(deadline, native_appearance::prepare(&app, &preferences))
        .await
        .map_err(|_| "Settings appearance preparation timed out")??;
    check(&runtime, &main, &key)?;
    let desired = timeout_at(deadline, preferences.default_content_height())
        .await
        .map_err(|_| "Settings default height timed out")??;
    check(&runtime, &main, &key)?;
    let native = timeout_at(
        deadline,
        stage(
            &app,
            Arc::clone(&runtime),
            main.clone(),
            key.clone(),
            move |_, main, runtime, token| {
                native_appearance::apply_on_main(&main.window, appearance, || {
                    runtime.finish_open_stage(token)
                })
            },
        ),
    )
    .await
    .map_err(|_| "Settings appearance stage timed out")??;
    let (platform, native_runtime) = lifecycle::split_native_runtime(native)?;
    let session = runtime.begin_session_reserved(
        key.id.clone(),
        Arc::clone(&bundle),
        preferences,
        native_runtime,
        platform,
        revoked,
        Some((main.key, key.clone())),
    )?;
    let desired = runtime.stage_height(&session, desired)?;
    let stage_session = session.clone();
    let stage_bundle = Arc::clone(&bundle);
    timeout_at(
        deadline,
        stage(
            &app,
            Arc::clone(&runtime),
            main.clone(),
            key.clone(),
            move |app, main, runtime, token| {
                let lease = crate::renderer_window_material::acquire_settings_on_window_main(
                    app,
                    &main.window,
                )?;
                runtime
                    .install_material_lease(&stage_session.id, lease)
                    .map_err(|lease| {
                        let _ =
                            runtime.remember_rejected_material_release(&stage_session.id, &lease);
                        drop(lease);
                        "Settings session ended during material acquisition".to_owned()
                    })?;
                runtime.finish_open_stage(token)?;
                emit(main, &stage_session, "placeholder", None)?;
                runtime.finish_open_stage(token)?;
                crate::window::resize_settings_content_on_window(app, &main.window, desired)?;
                Ok(())
            },
        ),
    )
    .await
    .map_err(|_| "Settings material/resize stage timed out")??;
    check(&runtime, &main, &key)?;
    super::height::confirm_viewport(&app, deadline).await?;
    check(&runtime, &main, &key)?;
    let stage_session = session.clone();
    timeout_at(
        deadline,
        stage(
            &app,
            Arc::clone(&runtime),
            main.clone(),
            key.clone(),
            move |app, main, runtime, token| {
                let child = lifecycle::create_child(app, &stage_session, desired, &main.window)?;
                let result = (|| {
                    runtime.finish_open_stage(token)?;
                    let lease = crate::window::attach_settings_child_layout_on_window(
                        app,
                        &main.window,
                        &child,
                        HEADER,
                        desired,
                    )?;
                    runtime
                        .install_layout_lease(&stage_session.id, lease)
                        .map_err(|_| "Settings session ended during child layout")?;
                    runtime.finish_open_stage(token)?;
                    let plugin = lifecycle::plugin_dto(&stage_bundle)?;
                    runtime.mark_opened_with(&stage_session.id, |current| {
                        emit(main, current, "opened", Some(plugin))
                    })?;
                    runtime.finish_open_stage(token)?;
                    if super::presentation::allow_focus(
                        app,
                        super::presentation::FocusPhase::SessionFocus,
                    ) {
                        main.window
                            .set_focus()
                            .map_err(|_| "Main window could not be focused")?;
                        runtime.finish_open_stage(token)?;
                        main.webview
                            .set_focus()
                            .map_err(|_| "Main renderer could not be focused")?;
                        runtime.finish_open_stage(token)?;
                        child
                            .set_focus()
                            .map_err(|_| "Settings view could not be focused")?;
                    }
                    Ok(())
                })();
                if result.is_err() {
                    let _ = child.close();
                }
                result
            },
        ),
    )
    .await
    .map_err(|_| "Settings child stage timed out")??;
    lifecycle::wait_until_ready(&session, deadline).await?;
    check(&runtime, &main, &key)?;
    let stage_session = session.clone();
    timeout_at(
        deadline,
        stage(
            &app,
            Arc::clone(&runtime),
            main,
            key,
            move |_, main, runtime, token| {
                runtime.mark_open_with(&stage_session.id, |current| {
                    emit(main, current, "loaded", None)
                })?;
                runtime.finish_open_stage(token)
            },
        ),
    )
    .await
    .map_err(|_| "Settings loaded stage timed out")??;
    Ok(super::event_payload::build_open_receipt(&session.id))
}

fn emit(
    main: &CapturedMain,
    session: &SessionView,
    phase: &str,
    plugin: Option<Value>,
) -> Result<(), String> {
    let payload = super::event_payload::build_event_payload(&session.id, phase, plugin)?;
    main.webview
        .emit(super::SETTINGS_EVENT, payload)
        .map_err(|_| "Main renderer did not accept settings lifecycle".to_owned())
}

/// Reusing an already-open child still passes through the captured-Main stage.
pub(crate) async fn focus_ready(
    app: &AppHandle<Wry>,
    runtime: Arc<SettingsViewRuntime>,
    main: CapturedMain,
    key: SessionKey,
) -> Result<(), String> {
    stage(
        app,
        runtime,
        main,
        key.clone(),
        move |app, main, runtime, token| {
            let session = runtime.current_for_id(&key.id)?;
            if Arc::as_ptr(&session.revoked) as usize != key.revoked_identity
                || session.is_revoked()
            {
                return Err("Settings session is no longer active".into());
            }
            if super::presentation::allow_focus(app, super::presentation::FocusPhase::SessionFocus)
            {
                main.window
                    .set_focus()
                    .map_err(|_| "Main window could not be focused")?;
                runtime.finish_open_stage(token)?;
                main.webview
                    .set_focus()
                    .map_err(|_| "Main renderer could not be focused")?;
                runtime.finish_open_stage(token)?;
                use tauri::Manager;
                let child = app
                    .get_webview(&session.label)
                    .ok_or("Settings child is unavailable")?;
                child
                    .set_focus()
                    .map_err(|_| "Settings child could not be focused")?;
            }
            Ok(())
        },
    )
    .await
}
