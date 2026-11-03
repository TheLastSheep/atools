use atools_core::Database;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::oneshot;

const GENERAL_KEY: &str = "settings-general";
const MARKER_KEY: &str = "__atoolsR51LoginCrossEntryMarker";
const EXPECTED_PLACEHOLDER: &str = "ATools R51 login cross entry";
const DATABASE_TIMEOUT: Duration = Duration::from_secs(8);
const BARRIER_TIMEOUT: Duration = Duration::from_secs(15);
const BARRIER_RETRY: Duration = Duration::from_millis(25);

#[derive(Clone)]
pub(super) struct OriginalSettings {
    pub(super) raw: Option<String>,
    pub(super) before_sha256: String,
    pub(super) original_launch_at_login: Option<bool>,
}

pub(super) async fn snapshot_original(
    app: &AppHandle<Wry>,
    db: Arc<Database>,
) -> Result<OriginalSettings, &'static str> {
    let raw = read_raw(app, db).await?;
    let original_launch_at_login = read_flag(raw.as_deref())?;
    let before_sha256 = hash_raw(&raw)?;
    Ok(OriginalSettings {
        raw,
        before_sha256,
        original_launch_at_login,
    })
}

pub(super) async fn seed_disabled(
    app: &AppHandle<Wry>,
    db: Arc<Database>,
    original: &OriginalSettings,
    run_id: &str,
) -> Result<(Option<bool>, bool), &'static str> {
    let Some(raw) = original.raw.as_deref() else {
        return Err(super::login_cross_entry_schema::SEED_FAILED);
    };
    let mut value: Value =
        serde_json::from_str(raw).map_err(|_| super::login_cross_entry_schema::SEED_FAILED)?;
    let object = value
        .as_object_mut()
        .ok_or(super::login_cross_entry_schema::SEED_FAILED)?;
    if object.contains_key(MARKER_KEY) {
        return Err(super::login_cross_entry_schema::SEED_FAILED);
    }
    object.insert("launchAtLogin".to_owned(), Value::Bool(false));
    object.insert(MARKER_KEY.to_owned(), Value::String(run_id.to_owned()));
    let seeded =
        serde_json::to_string(&value).map_err(|_| super::login_cross_entry_schema::SEED_FAILED)?;
    write_raw(app, db.clone(), Some(seeded)).await?;
    let stored = read_raw(app, db).await?;
    let stored_value: Value = stored
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .ok_or(super::login_cross_entry_schema::SEED_FAILED)?;
    let enabled = stored_value.get("launchAtLogin").and_then(Value::as_bool);
    let marker_preserved = stored_value.get(MARKER_KEY).and_then(Value::as_str) == Some(run_id);
    if enabled != Some(false) || !marker_preserved {
        return Err(super::login_cross_entry_schema::SEED_FAILED);
    }
    Ok((enabled, marker_preserved))
}

pub(super) async fn inspect(
    app: &AppHandle<Wry>,
    db: Arc<Database>,
    run_id: &str,
) -> Result<(Option<bool>, bool), &'static str> {
    let raw = read_raw(app, db).await?;
    let enabled = read_flag(raw.as_deref())?;
    let marker = raw
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get(MARKER_KEY)
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    Ok((enabled, marker.as_deref() == Some(run_id)))
}

pub(super) async fn placeholder_saved(
    app: &AppHandle<Wry>,
    db: Arc<Database>,
) -> Result<bool, &'static str> {
    let Some(raw) = read_raw(app, db).await? else {
        return Ok(false);
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Ok(false);
    };
    Ok(value.get("placeholder").and_then(Value::as_str) == Some(EXPECTED_PLACEHOLDER))
}

pub(super) async fn restore(
    app: &AppHandle<Wry>,
    db: Arc<Database>,
    original: &OriginalSettings,
) -> Result<(String, bool), &'static str> {
    write_raw(app, db.clone(), original.raw.clone()).await?;
    let restored = read_raw(app, db).await?;
    let after_sha256 = hash_raw(&restored)?;
    Ok((after_sha256, restored == original.raw))
}

pub(super) async fn read_native(app: &AppHandle<Wry>) -> Option<bool> {
    let coordinator = coordinator(app).ok()?;
    let worker_app = app.clone();
    tokio::time::timeout(
        DATABASE_TIMEOUT,
        coordinator.run(move || async move {
            tauri::async_runtime::spawn_blocking(move || {
                crate::general_settings_runtime::login_items::read(&worker_app)
            })
            .await
            .map_err(|_| crate::general_settings_runtime::login_items::UNAVAILABLE.to_owned())?
        }),
    )
    .await
    .ok()?
    .ok()
}

pub(super) async fn set_native(
    app: &AppHandle<Wry>,
    expected: bool,
    enabled: bool,
) -> Result<bool, &'static str> {
    let coordinator =
        coordinator(app).map_err(|_| super::login_cross_entry_schema::COORDINATOR_TIMEOUT)?;
    let worker_app = app.clone();
    tokio::time::timeout(
        DATABASE_TIMEOUT,
        coordinator.run(move || async move {
            tauri::async_runtime::spawn_blocking(move || {
                crate::general_settings_runtime::login_items::read_apply(
                    &worker_app,
                    Some(expected),
                    Some(enabled),
                )
            })
            .await
            .map_err(|_| crate::general_settings_runtime::login_items::RECOVERY_FAILED.to_owned())?
        }),
    )
    .await
    .map_err(|_| super::login_cross_entry_schema::COORDINATOR_TIMEOUT)?
    .map_err(|_| super::login_cross_entry_schema::CLEANUP_FAILED)
}

pub(super) fn database_report(
    original: Option<&OriginalSettings>,
    after: Option<&Option<String>>,
) -> Value {
    database_report_from_hash(original, after.and_then(|value| hash_raw(value).ok()))
}

pub(super) fn database_report_from_hash(
    original: Option<&OriginalSettings>,
    after_sha256: Option<String>,
) -> Value {
    serde_json::json!({
        "beforeSha256": original.map(|value| value.before_sha256.clone()),
        "afterSha256": after_sha256,
        "originalLaunchAtLogin": original.and_then(|value| value.original_launch_at_login),
    })
}

pub(super) async fn coordinator_barrier(app: &AppHandle<Wry>) -> bool {
    let Some(coordinator) = app
        .try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .map(|state| state.inner().clone())
    else {
        return false;
    };
    let (sender, receiver) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::Instant::now() + BARRIER_TIMEOUT;
        loop {
            match coordinator.run(|| async { Ok(()) }).await {
                Ok(()) => {
                    let _ = sender.send(true);
                    return;
                }
                Err(error)
                    if error == "Too many General settings writes are already queued"
                        && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(BARRIER_RETRY).await;
                }
                Err(_) => {
                    let _ = sender.send(false);
                    return;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = sender.send(false);
                return;
            }
        }
    });
    tokio::time::timeout(BARRIER_TIMEOUT, receiver)
        .await
        .is_ok_and(|result| result.is_ok_and(|terminal| terminal))
}

fn coordinator(
    app: &AppHandle<Wry>,
) -> Result<crate::general_settings_runtime::GeneralSettingsCoordinator, &'static str> {
    app.try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .map(|state| state.inner().clone())
        .ok_or("General settings coordinator is unavailable")
}

pub(super) async fn read_raw(
    app: &AppHandle<Wry>,
    db: Arc<Database>,
) -> Result<Option<String>, &'static str> {
    let coordinator = coordinator(app)?;
    let operation = coordinator.run(move || async move {
        tauri::async_runtime::spawn_blocking(move || {
            db.get_setting(GENERAL_KEY)
                .map_err(|_| super::login_cross_entry_schema::SEED_FAILED.to_owned())
        })
        .await
        .map_err(|_| super::login_cross_entry_schema::SEED_FAILED.to_owned())?
    });
    tokio::time::timeout(DATABASE_TIMEOUT, operation)
        .await
        .map_err(|_| super::login_cross_entry_schema::COORDINATOR_TIMEOUT)?
        .map_err(|_| super::login_cross_entry_schema::SEED_FAILED)
}

async fn write_raw(
    app: &AppHandle<Wry>,
    db: Arc<Database>,
    raw: Option<String>,
) -> Result<(), &'static str> {
    let coordinator = coordinator(app)?;
    let operation = coordinator.run(move || async move {
        tauri::async_runtime::spawn_blocking(move || match raw {
            Some(raw) => db.set_setting(GENERAL_KEY, &raw).map(|_| ()),
            None => db.delete_setting(GENERAL_KEY).map(|_| ()),
        })
        .await
        .map_err(|_| super::login_cross_entry_schema::RESTORE_FAILED.to_owned())?
        .map_err(|_| super::login_cross_entry_schema::RESTORE_FAILED.to_owned())
    });
    tokio::time::timeout(DATABASE_TIMEOUT, operation)
        .await
        .map_err(|_| super::login_cross_entry_schema::COORDINATOR_TIMEOUT)?
        .map_err(|_| super::login_cross_entry_schema::RESTORE_FAILED)
}

fn read_flag(raw: Option<&str>) -> Result<Option<bool>, &'static str> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value: Value =
        serde_json::from_str(raw).map_err(|_| super::login_cross_entry_schema::SEED_FAILED)?;
    let Some(flag) = value.get("launchAtLogin") else {
        return Ok(None);
    };
    flag.as_bool()
        .map(Some)
        .ok_or(super::login_cross_entry_schema::SEED_FAILED)
}

fn hash_raw(raw: &Option<String>) -> Result<String, &'static str> {
    let serialized =
        serde_json::to_string(raw).map_err(|_| super::login_cross_entry_schema::RESTORE_FAILED)?;
    let digest = Sha256::digest(serialized.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}
