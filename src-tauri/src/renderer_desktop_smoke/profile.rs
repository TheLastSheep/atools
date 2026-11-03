use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[path = "profile_height.rs"]
mod profile_height;
#[path = "profile_paths.rs"]
mod profile_paths;
#[path = "profile_updater.rs"]
mod profile_updater;
pub(crate) use profile_height::HeightCase;
#[path = "profile_registration_source.rs"]
mod profile_registration_source;
use self::profile_paths::{
    create_private_child, create_private_root, validate_absolute_path, validate_fixture_root_path,
    write_new_private_file,
};
pub(crate) use profile_registration_source::RegistrationSource;

const REPORT_LIMIT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PaintPresentation {
    Hidden,
    VisibleUnfocused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LaunchTargetKind {
    App,
    LocalShortcut,
}

impl LaunchTargetKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::LocalShortcut => "local-shortcut",
        }
    }
}

#[derive(Debug)]
pub(crate) struct Profile {
    pub(crate) root: PathBuf,
    pub(super) dist: PathBuf,
    pub(super) output: PathBuf,
    pub(super) auto_clear: String,
    pub(super) identifier: String,
    pub(crate) run_id: String,
    pub(super) settings_journey: bool,
    pub(crate) settings_height_case: Option<HeightCase>,
    pub(super) manual_ui: bool,
    pub(super) settings_input_journey: bool,
    pub(super) builtin_state_seed: bool,
    pub(super) builtin_state_journey: bool,
    pub(super) resume_seed_pid: Option<u32>,
    pub(super) main_hotkey_recovery_first: bool,
    pub(super) main_hotkey_recovery_second: bool,
    pub(super) resume_hotkey_owner_pid: Option<u32>,
    pub(super) paint_presentation: PaintPresentation,
    pub(super) launcher_journey: bool,
    pub(crate) launch_return_journey: bool,
    pub(crate) launch_target_kind: LaunchTargetKind,
    pub(crate) registration_source: RegistrationSource,
    pub(super) catalog_journey: bool,
    pub(crate) updater_journey: bool,
    pub(crate) updater_about: bool,
    pub(super) window_drag: bool,
    pub(super) main_panel_journey: bool,
    pub(super) clipboard_context_journey: bool,
}

impl Profile {
    pub(super) fn from_args(args: &[String]) -> Result<Self, String> {
        let mut values = BTreeMap::<&str, String>::new();
        let mut index = 0;

        while index < args.len() {
            let flag = args[index].as_str();
            if !matches!(
                flag,
                "--fixture-root"
                    | "--renderer-dist"
                    | "--output"
                    | "--auto-clear"
                    | "--run-id"
                    | "--journey"
                    | "--updater-mode"
                    | "--window-drag"
                    | "--paint-presentation"
                    | "--resume-seed-pid"
                    | "--resume-hotkey-owner-pid"
                    | "--target-kind"
                    | "--registration-source"
                    | "--height-case"
            ) {
                return Err(format!("unknown renderer smoke flag: {flag}"));
            }
            if values.contains_key(flag) {
                return Err(format!("duplicate renderer smoke flag: {flag}"));
            }
            let value = args
                .get(index + 1)
                .filter(|value| !value.starts_with("--"))
                .ok_or_else(|| format!("missing value for renderer smoke flag: {flag}"))?;
            values.insert(flag, value.clone());
            index += 2;
        }

        let root = PathBuf::from(required_value(&values, "--fixture-root")?);
        let dist = PathBuf::from(required_value(&values, "--renderer-dist")?);
        let output = PathBuf::from(required_value(&values, "--output")?);
        let auto_clear = required_value(&values, "--auto-clear")?.to_owned();
        let journey = values.get("--journey").map(String::as_str);
        let settings_journey = journey == Some("settings");
        let settings_height_case =
            HeightCase::parse(values.get("--height-case").map(String::as_str), journey)?;
        let manual_ui = journey == Some("manual-ui");
        let builtin_state_seed = journey == Some("builtin-state-seed");
        let builtin_state_journey = journey == Some("builtin-state");
        let main_hotkey_recovery_first = journey == Some("main-hotkey-recovery-first");
        let main_hotkey_recovery_second = journey == Some("main-hotkey-recovery-second");
        let settings_input_journey = journey == Some("settings-input")
            || builtin_state_journey
            || main_hotkey_recovery_first
            || main_hotkey_recovery_second;
        let launcher_journey = journey == Some("launcher");
        let launch_return_journey = journey == Some("launch-return");
        let launch_target_kind = match values.get("--target-kind").map(String::as_str) {
            None | Some("app") => LaunchTargetKind::App,
            Some("local-shortcut") => LaunchTargetKind::LocalShortcut,
            Some(_) => return Err("target-kind must be app or local-shortcut".to_string()),
        };
        if values.contains_key("--target-kind") && !launch_return_journey {
            return Err("target-kind requires --journey launch-return".to_string());
        }
        let registration_source = RegistrationSource::parse(
            values.get("--registration-source").map(String::as_str),
            launch_return_journey,
            launch_target_kind,
        )?;
        let catalog_journey = journey == Some("catalog");
        let updater_journey = journey == Some("updater");
        let updater_about = profile_updater::about_mode(
            values.get("--updater-mode").map(String::as_str),
            updater_journey,
        )?;
        let main_panel_journey = journey == Some("main-panel");
        let clipboard_context_journey = journey == Some("clipboard-context");
        let paint_presentation = match values.get("--paint-presentation").map(String::as_str) {
            None | Some("hidden") => PaintPresentation::Hidden,
            Some("visible-unfocused") => PaintPresentation::VisibleUnfocused,
            Some(_) => {
                return Err("paint-presentation must be hidden or visible-unfocused".to_string())
            }
        };
        if values.contains_key("--paint-presentation") && journey != Some("settings-input") {
            return Err("paint-presentation requires --journey settings-input".to_string());
        }
        if journey.is_some()
            && !settings_journey
            && settings_height_case.is_none()
            && !manual_ui
            && !settings_input_journey
            && !builtin_state_seed
            && !main_hotkey_recovery_first
            && !main_hotkey_recovery_second
            && !launcher_journey
            && !launch_return_journey
            && !catalog_journey
            && !updater_journey
            && !main_panel_journey
            && !clipboard_context_journey
        {
            return Err(
                "journey must be manual-ui, launcher, launch-return, settings, settings-input, builtin-state-seed, builtin-state, main-hotkey-recovery-first, main-hotkey-recovery-second, catalog, updater, main-panel, or clipboard-context"
                    .to_string(),
            );
        }
        if clipboard_context_journey
            && !cfg!(all(target_os = "macos", feature = "legacy-node-smoke"))
        {
            return Err(
                "clipboard-context journey requires macOS and --features legacy-node-smoke"
                    .to_string(),
            );
        }
        let resume_seed_pid = values
            .get("--resume-seed-pid")
            .map(|value| {
                let pid = value.parse::<u32>().map_err(|_| {
                    "resume-seed-pid must be a canonical positive PID distinct from this process"
                        .to_string()
                })?;
                if pid == 0 || pid == std::process::id() || pid.to_string() != *value {
                    return Err(
                        "resume-seed-pid must be a canonical positive PID distinct from this process"
                            .to_string(),
                    );
                }
                Ok(pid)
            })
            .transpose()?;
        if builtin_state_journey != resume_seed_pid.is_some() {
            return Err("resume-seed-pid is required only for --journey builtin-state".to_string());
        }
        let resume_hotkey_owner_pid = values
            .get("--resume-hotkey-owner-pid")
            .map(|value| parse_resume_pid(value, "resume-hotkey-owner-pid"))
            .transpose()?;
        if main_hotkey_recovery_second != resume_hotkey_owner_pid.is_some()
            || resume_seed_pid.is_some() && resume_hotkey_owner_pid.is_some()
        {
            return Err(
                "resume-hotkey-owner-pid is required only for --journey main-hotkey-recovery-second"
                    .to_string(),
            );
        }
        let window_drag = match values.get("--window-drag").map(String::as_str) {
            None => false,
            Some("true") => true,
            Some("false") => false,
            Some(_) => return Err("window-drag must be true or false".to_string()),
        };
        if values.contains_key("--window-drag") && !catalog_journey {
            return Err("window-drag requires --journey catalog".to_string());
        }
        if window_drag && !cfg!(feature = "legacy-node-smoke") {
            return Err("window-drag requires --features legacy-node-smoke".to_string());
        }

        validate_fixture_root_path(&root)?;
        validate_absolute_path(&dist, "renderer-dist")?;
        validate_absolute_path(&output, "output")?;
        if !matches!(auto_clear.as_str(), "immediately" | "never") {
            return Err("auto-clear must be immediately or never".to_string());
        }
        if launch_return_journey && auto_clear != "never" {
            return Err("launch-return requires --auto-clear never".to_string());
        }
        if main_panel_journey && auto_clear != "never" {
            return Err("main-panel requires --auto-clear never".to_string());
        }
        if clipboard_context_journey && auto_clear != "never" {
            return Err("clipboard-context requires --auto-clear never".to_string());
        }
        if (settings_input_journey || builtin_state_seed || manual_ui) && auto_clear != "never" {
            return Err("settings-input requires --auto-clear never".to_string());
        }
        if (settings_input_journey || manual_ui)
            && !cfg!(all(
                feature = "legacy-node-smoke",
                feature = "ztools-multiwebview"
            ))
        {
            return Err(
                "settings-input requires --features legacy-node-smoke,ztools-multiwebview"
                    .to_string(),
            );
        }
        if builtin_state_seed
            && !cfg!(all(
                feature = "legacy-node-smoke",
                feature = "ztools-multiwebview"
            ))
        {
            return Err(
                "builtin-state-seed requires --features legacy-node-smoke,ztools-multiwebview"
                    .to_string(),
            );
        }
        if settings_journey && !cfg!(feature = "ztools-multiwebview") {
            return Err("settings journey requires --features ztools-multiwebview".to_string());
        }
        if launcher_journey && !cfg!(feature = "legacy-node-smoke") {
            return Err("launcher journey requires --features legacy-node-smoke".to_string());
        }
        if launch_return_journey
            && !cfg!(all(
                feature = "legacy-node-smoke",
                feature = "ztools-multiwebview"
            ))
        {
            return Err(
                "launch-return journey requires --features legacy-node-smoke,ztools-multiwebview"
                    .to_string(),
            );
        }
        if catalog_journey && !cfg!(feature = "ztools-multiwebview") {
            return Err("catalog journey requires --features ztools-multiwebview".to_string());
        }
        if main_panel_journey
            && !cfg!(all(
                target_os = "macos",
                feature = "macos-main-panel-prototype"
            ))
        {
            return Err(
                "main-panel journey requires macOS and --features macos-main-panel-prototype"
                    .to_string(),
            );
        }
        let run_id = values
            .get("--run-id")
            .map(|value| {
                uuid::Uuid::parse_str(value)
                    .map(|uuid| uuid.simple().to_string())
                    .map_err(|_| "run-id must be a valid UUID".to_string())
            })
            .transpose()?
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        if builtin_state_seed
            || builtin_state_journey
            || main_hotkey_recovery_first
            || main_hotkey_recovery_second
        {
            let expected_root =
                Path::new("/private/tmp").join(format!("atools-renderer-settings-input-{run_id}"));
            if root != expected_root {
                return Err(
                    "builtin-state fixture-root must match the fixed private run path".into(),
                );
            }
        }
        if settings_height_case.is_some() {
            profile_height::validate_paths(&root, &output, &run_id, &auto_clear)?;
        }
        if manual_ui {
            super::manual_ui::validate_paths(&root, &output, &run_id)?;
        }
        if main_panel_journey {
            let expected_root =
                Path::new("/private/tmp").join(format!("atools-renderer-smoke-{run_id}"));
            if root != expected_root {
                return Err("main-panel fixture-root must match the fixed private run path".into());
            }
        }
        if clipboard_context_journey {
            let expected_root =
                Path::new("/private/tmp").join(format!("atools-renderer-clipboard-{run_id}"));
            if root != expected_root {
                return Err(
                    "clipboard-context fixture-root must match the fixed private run path".into(),
                );
            }
        }
        profile_updater::validate(updater_journey, &root, &run_id, &auto_clear)?;
        match fs::symlink_metadata(&output) {
            Ok(_) => return Err("output path must not already exist".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot inspect output path: {error}")),
        }

        Ok(Self {
            root,
            dist,
            output,
            auto_clear,
            identifier: if manual_ui {
                format!("dev.atools.renderer-manual.{run_id}")
            } else if clipboard_context_journey {
                format!("dev.atools.renderer-clipboard.{run_id}")
            } else if settings_input_journey || builtin_state_seed {
                format!("dev.atools.renderer-settings-input.{run_id}")
            } else {
                format!("dev.atools.renderer-smoke.{run_id}")
            },
            run_id,
            settings_journey,
            settings_height_case,
            manual_ui,
            settings_input_journey,
            builtin_state_seed,
            builtin_state_journey,
            resume_seed_pid,
            main_hotkey_recovery_first,
            main_hotkey_recovery_second,
            resume_hotkey_owner_pid,
            paint_presentation,
            launcher_journey,
            launch_return_journey,
            launch_target_kind,
            registration_source,
            catalog_journey,
            updater_journey,
            updater_about,
            window_drag,
            main_panel_journey,
            clipboard_context_journey,
        })
    }

    pub(super) fn prepare(&self) -> Result<(), String> {
        if self.builtin_state_journey {
            return super::fixture_owner::resume_seed_profile(
                self,
                self.resume_seed_pid.ok_or_else(|| {
                    "resume-seed-pid is required only for --journey builtin-state".to_string()
                })?,
            )
            .map_err(|_| "builtin-state-resume-owner-invalid".to_string());
        }
        if self.main_hotkey_recovery_second {
            return super::fixture_owner::resume_main_hotkey_profile(
                self,
                self.resume_hotkey_owner_pid.ok_or_else(|| {
                    "resume-hotkey-owner-pid is required only for --journey main-hotkey-recovery-second".to_string()
                })?,
            )
            .map_err(|_| "main-hotkey-recovery-resume-owner-invalid".to_string());
        }
        self.prepare_fresh()
    }

    fn prepare_fresh(&self) -> Result<(), String> {
        validate_fixture_root_path(&self.root)?;
        match fs::symlink_metadata(&self.root) {
            Ok(_) => return Err("fixture-root must not already exist".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot inspect fixture-root: {error}")),
        }

        create_private_root(&self.root)?;
        let marker = serde_json::json!({
            "schemaVersion": 1,
            "pid": std::process::id(),
            "identifier": self.identifier.clone(),
            "root": self.root.to_string_lossy().into_owned(),
        });
        let marker_bytes = serde_json::to_vec(&marker)
            .map_err(|error| format!("serialize fixture ownership marker: {error}"))?;
        write_new_private_file(
            &self.root.join(".atools-renderer-smoke-owner.json"),
            &marker_bytes,
            "create fixture ownership marker",
        )?;
        create_private_child(&self.root, "app-data")?;
        create_private_child(&self.root, "webview")?;
        Ok(())
    }

    pub(super) fn write_report(&self, value: &serde_json::Value) -> Result<(), String> {
        validate_absolute_path(&self.output, "output")?;
        let bytes =
            serde_json::to_vec(value).map_err(|error| format!("serialize report: {error}"))?;
        if bytes.len() > REPORT_LIMIT_BYTES {
            return Err("report exceeds the 1 MiB limit".to_string());
        }

        write_new_private_file(
            &self.output,
            &bytes,
            "create new report without following links",
        )
    }
}

fn parse_resume_pid(value: &str, flag: &str) -> Result<u32, String> {
    let pid = value.parse::<u32>().map_err(|_| {
        format!("{flag} must be a canonical positive PID distinct from this process")
    })?;
    if pid == 0 || pid == std::process::id() || pid.to_string() != value {
        return Err(format!(
            "{flag} must be a canonical positive PID distinct from this process"
        ));
    }
    Ok(pid)
}

fn required_value<'a>(values: &'a BTreeMap<&str, String>, flag: &str) -> Result<&'a str, String> {
    values
        .get(flag)
        .map(String::as_str)
        .ok_or_else(|| format!("missing required renderer smoke flag: {flag}"))
}

#[cfg(test)]
#[path = "profile_clipboard_context_tests.rs"]
mod clipboard_context_tests;
#[path = "profile_hotkey_recovery_tests.rs"]
mod hotkey_recovery_tests;
#[cfg(test)]
#[path = "profile_target_kind_tests.rs"]
mod target_kind_tests;
#[path = "profile_tests.rs"]
mod tests;
