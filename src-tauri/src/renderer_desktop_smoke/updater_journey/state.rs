use super::Control;
use crate::{
    renderer_desktop_smoke::{fixture_owner, profile::Profile},
    state::AppState,
};
use atools_core::Database;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

pub(super) const STAGES: &[&str] = &[
    "main-ready",
    "main-check",
    "popup-ready",
    "popup-busy",
    "popup-error",
    "popup-disposed",
    "main-disposed",
];

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Dom {
    pub ready: bool,
    pub title: String,
    pub text: String,
    pub confirm_disabled: Option<bool>,
    pub cancel_disabled: Option<bool>,
    pub bridge_present: bool,
    pub rejected: bool,
}
impl Dom {
    pub fn parse(raw: Value) -> Result<Self, String> {
        if serde_json::to_vec(&raw).map_or(true, |v| v.len() > 4096) {
            return Err("updater-probe-dom-too-large".into());
        }
        let dom: Self = serde_json::from_value(raw).map_err(|_| "updater-probe-dom-invalid")?;
        if dom.title.len() > 256 || dom.text.len() > 2048 {
            return Err("updater-probe-dom-too-large".into());
        }
        Ok(dom)
    }
}
#[derive(Default)]
struct Observations {
    values: BTreeMap<String, Value>,
    pub label: Option<String>,
}
#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness {
    pub profile: Arc<Profile>,
    pub(super) db: Arc<Database>,
    pub token: Arc<String>,
    pub control: Arc<Control>,
    observations: Arc<Mutex<Observations>>,
    #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
    pub(super) about: Option<Arc<super::about::State>>,
    pub changed: Arc<Notify>,
    pub main_injected: Arc<AtomicBool>,
    pub popup_injected: Arc<AtomicBool>,
    pub destroyed: Arc<AtomicU64>,
    pub rejected: Arc<AtomicU64>,
}
impl Harness {
    pub(super) fn new(profile: Arc<Profile>, db: Arc<Database>) -> Result<Self, String> {
        verify_profile(&profile)?;
        #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
        let about = profile
            .updater_about
            .then(|| Arc::new(super::about::State::default()));
        Ok(Self {
            #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
            about,
            profile,
            db,
            token: Arc::new(uuid::Uuid::new_v4().simple().to_string()),
            control: Arc::new(Control::default()),
            observations: Arc::new(Mutex::new(Observations::default())),
            changed: Arc::new(Notify::new()),
            main_injected: Arc::new(AtomicBool::new(false)),
            popup_injected: Arc::new(AtomicBool::new(false)),
            destroyed: Arc::new(AtomicU64::new(0)),
            rejected: Arc::new(AtomicU64::new(0)),
        })
    }
    pub(super) fn verify(&self, app: &AppHandle) -> Result<(), String> {
        verify_profile(&self.profile)?;
        let state = app
            .try_state::<AppState>()
            .ok_or("updater-fixture-app-state-missing")?;
        if app.config().identifier != self.profile.identifier
            || state.config.base_dir() != self.profile.root.join("app-data")
            || !Arc::ptr_eq(&state.db, &self.db)
            || !regular(&state.config.db_path(), false, None)
        {
            return Err("updater-fixture-capability-invalid".into());
        }
        Ok(())
    }
    pub fn accept(&self, stage: &str, dom: Dom, native: Value, label: &str) -> Result<(), String> {
        if !STAGES.contains(&stage) {
            return Err("updater-probe-stage-invalid".into());
        }
        let mut state = self.observations.lock();
        if state.values.contains_key(stage) {
            return Err("updater-probe-stage-duplicate".into());
        }
        if stage.starts_with("popup-") {
            if state.label.as_ref().is_some_and(|old| old != label) {
                return Err("updater-probe-popup-changed".into());
            }
            state.label = Some(label.into());
        }
        state.values.insert(
            stage.into(),
            json!({"stage":stage,"sourceLabel":label,"dom":dom,"native":native}),
        );
        drop(state);
        self.changed.notify_waiters();
        Ok(())
    }
    pub fn get(&self, stage: &str) -> Option<Value> {
        self.observations.lock().values.get(stage).cloned()
    }
    pub fn label(&self) -> Option<String> {
        self.observations.lock().label.clone()
    }
    pub fn note_destroyed(&self, label: &str) {
        if self.label().as_deref() == Some(label) {
            self.destroyed.fetch_add(1, Ordering::AcqRel);
            self.changed.notify_waiters();
        }
    }
    pub fn stages(&self) -> Vec<Value> {
        STAGES.iter().filter_map(|s| self.get(s)).collect()
    }
}
fn verify_profile(profile: &Profile) -> Result<(), String> {
    let expected =
        Path::new("/private/tmp").join(format!("atools-renderer-updater-{}", profile.run_id));
    if !profile.updater_journey
        || profile.root != expected
        || profile.identifier != format!("dev.atools.renderer-smoke.{}", profile.run_id)
        || profile.auto_clear != "never"
        || !cfg!(all(
            target_os = "macos",
            feature = "legacy-node-smoke",
            feature = "ztools-multiwebview"
        ))
        || fixture_owner::verify(profile).is_err()
        || !regular(&profile.root, true, Some(0o700))
        || !regular(&profile.root.join("app-data"), true, Some(0o700))
        || !regular(
            &profile.root.join(".atools-renderer-smoke-owner.json"),
            false,
            Some(0o600),
        )
    {
        return Err("updater-fixture-owner-invalid".into());
    }
    Ok(())
}
#[cfg(unix)]
fn regular(path: &Path, dir: bool, mode: Option<u32>) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    std::fs::symlink_metadata(path).is_ok_and(|m| {
        m.file_type().is_dir() == dir
            && (dir || m.file_type().is_file() && m.nlink() == 1)
            && m.uid() == unsafe { libc::geteuid() }
            && mode.is_none_or(|mode| m.permissions().mode() & 0o777 == mode)
            && std::fs::canonicalize(path).is_ok_and(|p| p == path)
    })
}
#[cfg(not(unix))]
fn regular(_path: &Path, _dir: bool, _mode: Option<u32>) -> bool {
    false
}

pub(crate) fn capability(app: &AppHandle) -> Result<Option<Arc<Control>>, String> {
    let Some(h) = app.try_state::<Harness>() else {
        return Ok(None);
    };
    h.verify(app)?;
    Ok(Some(h.control.clone()))
}
pub(crate) fn authorized(app: &AppHandle) -> bool {
    capability(app).is_ok_and(|c| c.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dom_receipts_are_closed_and_bounded() {
        let good = json!({"ready":true,"title":"","text":"","confirmDisabled":null,"cancelDisabled":null,"bridgePresent":true,"rejected":true});
        assert!(Dom::parse(good.clone()).is_ok());
        let mut extra = good.clone();
        extra["arbitrary"] = json!(1);
        assert!(Dom::parse(extra).is_err());
        let mut large = good;
        large["text"] = json!("a".repeat(2049));
        assert!(Dom::parse(large).is_err());
    }

    #[cfg(all(target_os = "macos", feature = "ztools-multiwebview"))]
    #[test]
    fn actual_owner_marker_mutation_revokes_fixture_profile() {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let root = format!("/private/tmp/atools-renderer-updater-{id}");
        let output = format!("/private/tmp/atools-updater-report-{id}.json");
        let args = [
            "--fixture-root",
            &root,
            "--renderer-dist",
            "/private/tmp/dist",
            "--output",
            &output,
            "--run-id",
            &id,
            "--journey",
            "updater",
            "--auto-clear",
            "never",
        ]
        .map(str::to_owned);
        let profile = Profile::from_args(&args).unwrap();
        profile.prepare().unwrap();
        verify_profile(&profile).unwrap();
        let marker = profile.root.join(".atools-renderer-smoke-owner.json");
        let before = std::fs::read(&marker).unwrap();
        let mut value: Value = serde_json::from_slice(&before).unwrap();
        value["pid"] = json!(0);
        std::fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(verify_profile(&profile).is_err());
        std::fs::write(&marker, before).unwrap();
        verify_profile(&profile).unwrap();
        std::fs::remove_dir_all(&profile.root).unwrap();
    }
}
