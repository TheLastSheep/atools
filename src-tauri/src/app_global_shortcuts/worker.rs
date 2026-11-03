use super::*;
use crate::general_settings_runtime::{GeneralSettingsCoordinator, HotkeyOperationLease};
use atools_core::db::{RendererAppIdentity, RendererDirectSubtype};

pub(super) async fn lease(app: &AppHandle) -> Result<HotkeyOperationLease, String> {
    let coordinator = app.state::<GeneralSettingsCoordinator>().inner().clone();
    loop {
        let notified = coordinator.hotkey_operation_available.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if let Ok(lease) = coordinator.hotkey_operation_lease() {
            return Ok(lease);
        }
        notified.await;
    }
}
pub(super) async fn run(app: AppHandle, rt: Arc<Runtime>) {
    let restore_app = app.clone();
    let restore_rt = rt.clone();
    let owned = match lease(&app).await {
        Ok(v) => v,
        Err(_) => return,
    };
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _lease = owned;
        restore(&restore_app, &restore_rt)
    })
    .await;
    let gate = match recording::gate(&app) {
        Ok(g) => g,
        Err(_) => return,
    };
    loop {
        let recording_wake = gate.wake.notified();
        tokio::pin!(recording_wake);
        recording_wake.as_mut().enable();
        let deadline = recording::work(&app, &gate);
        let notified = rt.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if rt.stopping.load(Ordering::Acquire) {
            break;
        }
        let next = { rt.queue.lock().events.pop_front() };
        let Some(target) = next else {
            if let Some(deadline) = deadline {
                tokio::select! { _=notified=>{}, _=&mut recording_wake=>{}, _=tokio::time::sleep_until(deadline.into())=>{} }
            } else {
                tokio::select! {_=notified=>{},_=&mut recording_wake=>{}}
            }
            continue;
        };
        let pause_epoch = rt
            .queue
            .lock()
            .epochs
            .remove(&(target.row_id.clone(), target.epoch));
        let owned = match super::recording_wait::service(&gate, lease(&app), |notice| {
            recording::deliver(&app, notice)
        })
        .await
        {
            Ok(v) => v,
            Err(_) => break,
        };
        if gate.busy() || pause_epoch.is_none_or(|epoch| epoch != gate.epoch()) {
            rt.queue
                .lock()
                .pending
                .remove(&(target.row_id, target.epoch));
            drop(owned);
            continue;
        }
        let live = !rt.stopping.load(Ordering::Acquire)
            && rt.published.lock().get(&target.row_id) == Some(&target);
        if live {
            let state = app.state::<crate::state::AppState>();
            let db = state.db.clone();
            let catalog = state.launcher_app_catalog.clone();
            let check_db = db.clone();
            let current = target.clone();
            let valid_task = tauri::async_runtime::spawn_blocking(move || {
                check_db.read_renderer_app_global_shortcuts().map(|s| {
                    s.bindings.iter().any(|r| {
                        r.row_id == current.row_id
                            && r.generation == current.config_generation
                            && r.enabled
                            && r.public_matches
                            && r.path == current.path
                            && r.shortcut == current.shortcut
                    })
                })
            });
            let valid = super::recording_wait::service(&gate, valid_task, |notice| {
                recording::deliver(&app, notice)
            })
            .await;
            if matches!(valid, Ok(Ok(true))) && !rt.stopping.load(Ordering::Acquire) {
                let Some(_action) = pause_epoch.and_then(|epoch| gate.admit(epoch)) else {
                    rt.queue
                        .lock()
                        .pending
                        .remove(&(target.row_id, target.epoch));
                    continue;
                };
                let grant = rt.fence.grant(
                    target.row_id.clone(),
                    target.epoch,
                    target.path.clone(),
                    catalog.clone(),
                    Box::new(owned),
                );
                let identity = RendererAppIdentity {
                    path: target.path.clone(),
                    name: target.name.clone(),
                    sub_type: RendererDirectSubtype::App,
                };
                if let Err(error) = crate::app_launch_service::launch_bound_app(
                    app.clone(),
                    db,
                    catalog,
                    identity,
                    grant,
                )
                .await
                {
                    tracing::warn!(%error,"Bound App launch failed; no automatic replay");
                }
            }
        }
        rt.queue
            .lock()
            .pending
            .remove(&(target.row_id, target.epoch));
    }
}
fn restore(app: &AppHandle, rt: &Arc<Runtime>) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    let snapshot = state
        .db
        .read_renderer_app_global_shortcuts()
        .map_err(|e| e.to_string())?;
    let catalog = state.launcher_app_catalog.snapshot()?;
    let epoch = rt.epoch.fetch_add(1, Ordering::AcqRel) + 1;
    let mut registry = std::mem::take(&mut *rt.registry.lock());
    for row in &snapshot.bindings {
        if rt.stopping.load(Ordering::Acquire) {
            break;
        }
        let result = if !row.enabled {
            Err(("disabled", None))
        } else if !row.public_matches {
            Err((
                "unavailable",
                Some("Public row does not match Native authority".into()),
            ))
        } else if !catalog.iter().any(|a| a.path() == row.path) {
            Err(("missing", Some("App target missing".into())))
        } else {
            match registry::desired(std::slice::from_ref(row), epoch)
                .and_then(|r| r.into_values().next().ok_or("Binding unavailable".into()))
                .and_then(|desired| {
                    let target = desired.target_code.clone();
                    registry.register_one(&mut registry::Port { app, runtime: rt }, desired)?;
                    rt.fence
                        .publish(row.row_id.clone(), epoch, row.path.clone())?;
                    rt.published.lock().insert(row.row_id.clone(), target);
                    Ok(())
                }) {
                Ok(()) => Ok(()),
                Err(e) => Err(("conflict", Some(e))),
            }
        };
        let status = match result {
            Ok(()) => ("registered".into(), None),
            Err((state, error)) => (state.into(), error),
        };
        rt.status.lock().insert(row.row_id.clone(), status);
    }
    *rt.registry.lock() = registry;
    Ok(())
}
pub(super) async fn drain(app: &AppHandle) -> Result<(), String> {
    let rt = runtime(app)?;
    let gate = recording::gate(app)?;
    gate.close();
    super::feature_dispatch::cancel_offers(app);
    rt.stop();
    gate.wait_actions().await;
    let owned = lease(app).await?;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = owned;
        shutdown_steps(
            || crate::hotkey::shutdown_recording_owners(&app),
            || {
                let mut registry = std::mem::take(&mut *rt.registry.lock());
                let result = registry
                    .replace_all(
                        &mut registry::Port {
                            app: &app,
                            runtime: &rt,
                        },
                        BTreeMap::new(),
                    )
                    .map(|_| ());
                *rt.registry.lock() = registry;
                result
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(super) fn shutdown_steps(
    owners: impl FnOnce() -> Result<(), String>,
    apps: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let owners = owners();
    let apps = apps();
    let errors = [owners, apps]
        .into_iter()
        .filter_map(Result::err)
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
