use super::protocol::{validate_private_directory, LaunchConfig};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

const TARGET_ENV_KEYS: &[&str] = &[
    "PATH", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "HOME", "USERPROFILE", "HOMEPATH", "HOMEDRIVE",
    "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_CACHE_HOME", "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP", "ATOOLS_NODE_BINARY",
    "ATOOLS_NATIVE_EDITOR_INPUT_EXCHANGE", "ATOOLS_PANEL_FOREGROUND_MODE", "ATOOLS_PANEL_ACTIVATION_OBSERVATION",
    "ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID",
];

fn unique_value<'a>(args: &'a [String], flag: &str) -> Result<&'a str, String> {
    let matches: Vec<_> = args.iter().enumerate().filter_map(|(index, value)| (value == flag).then_some(index)).collect();
    if matches.len() != 1 { return Err(format!("target arguments require exactly one {flag}")); }
    args.get(matches[0] + 1).filter(|value| !value.starts_with("--") && !value.is_empty())
        .map(String::as_str).ok_or_else(|| format!("target argument {flag} has no value"))
}

fn validate_target_arguments(config: &LaunchConfig) -> Result<(), String> {
    let args = &config.target_args;
    for flag in ["--published-plugin-panel-ui", "--native-ui-input", "--execute-reviewed-package", "--native-launchservices-fixture"] {
        if args.iter().filter(|value| value.as_str() == flag).count() != 1 {
            return Err(format!("target arguments require exactly one {flag}"));
        }
    }
    if args.iter().any(|value| value == "--worker-contract-only") {
        return Err("worker-only mode is forbidden for LaunchServices editor input".into());
    }
    if unique_value(args, "--published-case")? != config.case_id || unique_value(args, "--run-id")? != config.run_id {
        return Err("target case and run arguments must match the private launch config".into());
    }
    let allowed_values = ["--published-case", "--run-id", "--expected-sha256", "--source-review", "--panel-ui",
        "--panel-css", "--panel-probe", "--plugin-root", "--package-import-path", "--output", "--fixture-root"];
    let allowed_switches = ["--published-plugin-panel-ui", "--native-ui-input", "--execute-reviewed-package", "--native-launchservices-fixture"];
    for flag in allowed_values.iter().chain(allowed_switches.iter()) {
        let count = args.iter().filter(|value| value.as_str() == *flag).count();
        if count > 1 { return Err(format!("target argument {flag} must not be repeated")); }
    }
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if allowed_switches.contains(&flag) { index += 1; continue; }
        if allowed_values.contains(&flag) {
            let value = args.get(index + 1).filter(|value| !value.starts_with("--") && !value.is_empty())
                .ok_or_else(|| format!("target argument {flag} has no value"))?;
            if value.len() > 8192 { return Err("target argument value exceeds the fixed size cap".into()); }
            index += 2;
            continue;
        }
        return Err(format!("unapproved LaunchServices target argument: {flag}"));
    }
    if unique_value(args, "--expected-sha256")?.len() != 64
        || !unique_value(args, "--expected-sha256")?.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("target package digest must be one SHA-256 value".into());
    }
    Ok(())
}

pub fn launchservices_route_required(args: &[String], fifo_present: bool) -> Result<bool, String> {
    let marker_count = args.iter().filter(|value| value.as_str() == "--native-launchservices-fixture").count();
    if marker_count > 1 { return Err("LaunchServices permit marker must occur exactly once".into()); }
    let marked = marker_count == 1;
    if marked != fifo_present {
        return Err("LaunchServices permit marker and private stdio permit must be present together".into());
    }
    Ok(marked)
}

fn validate_target_environment(config: &LaunchConfig) -> Result<(), String> {
    let mut bytes = 0usize;
    for (key, value) in &config.target_env {
        if !TARGET_ENV_KEYS.contains(&key.as_str()) || value.len() > 8192 {
            return Err(format!("unapproved or oversized target environment entry: {key}"));
        }
        bytes = bytes.saturating_add(key.len()).saturating_add(value.len());
    }
    if config.target_env.len() > TARGET_ENV_KEYS.len() || bytes > 64 * 1024 {
        return Err("target environment exceeds the fixed key or byte budget".into());
    }
    if config.target_env.contains_key("ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID")
        != config.target_env.contains_key("ATOOLS_PANEL_ACTIVATION_OBSERVATION") {
        return Err("activation observation environment keys must be supplied together".into());
    }
    if config.target_env.get("ATOOLS_PANEL_FOREGROUND_MODE").map(String::as_str) != Some("required") {
        return Err("LaunchServices editor fixture requires strict foreground gating".into());
    }
    if config.target_env.get("ATOOLS_PANEL_ACTIVATION_OBSERVATION").is_some_and(|mode| mode != "observe")
        || config.target_env.get("ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID").is_some_and(|id| id != &config.bundle_id) {
        return Err("activation observation environment does not match this run's exact staged bundle".into());
    }
    if let Some(path) = config.target_env.get("ATOOLS_NATIVE_EDITOR_INPUT_EXCHANGE") {
        if !path.starts_with("/private/tmp/atools-native-editor-exchange-") {
            return Err("input exchange path is outside the private editor fixture root".into());
        }
        validate_private_directory(Path::new(path))?;
    }
    Ok(())
}

pub fn read_observer_config(args: &[String]) -> Result<LaunchConfig, String> {
    if args.iter().filter(|arg| arg.as_str() == "--atools-native-launchservices-observer").count() != 1 {
        return Err("observer flag must occur exactly once".into());
    }
    let positions: Vec<_> = args.iter().enumerate().filter_map(|(index, arg)|
        (arg == "--launch-config").then_some(index)).collect();
    if positions.len() != 1 { return Err("observer requires exactly one launch config".into()); }
    let value = args.get(positions[0] + 1).filter(|value| !value.starts_with("--"))
        .ok_or("missing launch config path")?;
    let path = Path::new(value);
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("inspect launch config: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o077 != 0 || metadata.len() > 256 * 1024 {
        return Err("launch config must be an owned, private regular file below the size cap".into());
    }
    let config: LaunchConfig = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("invalid launch config: {error}"))?;
    validate_config(&config)?;
    Ok(config)
}

pub fn active_input_identity(args: &[String]) -> Result<Option<(String, String)>, String> {
    let active = args.iter().filter(|arg| arg.as_str() == "--native-ui-input").count();
    if active == 0 { return Ok(None); }
    if active != 1 { return Err("native UI input flag must occur exactly once".into()); }
    let option = |flag: &str| -> Result<String, String> {
        let found: Vec<_> = args.iter().enumerate().filter_map(|(index, value)| (value == flag).then_some(index)).collect();
        if found.len() != 1 { return Err(format!("expected exactly one {flag}")); }
        args.get(found[0] + 1).filter(|value| !value.starts_with("--") && !value.is_empty()).cloned()
            .ok_or_else(|| format!("missing {flag} value"))
    };
    let case_id = option("--published-case")?;
    if !matches!(case_id.as_str(), "local-plain-text" | "local-json-editor") { return Err("stdio route case is not registered".into()); }
    let run_id = option("--run-id")?;
    let parsed = uuid::Uuid::parse_str(&run_id).map_err(|_| "invalid stdio route run id")?;
    if parsed.hyphenated().to_string() != run_id { return Err("stdio route run id must be canonical".into()); }
    Ok(Some((case_id, run_id)))
}

fn validate_config(config: &LaunchConfig) -> Result<(), String> {
    if !matches!(config.case_id.as_str(), "local-plain-text" | "local-json-editor") {
        return Err("LaunchServices mode is restricted to the registered plain/json cases".into());
    }
    let parsed = uuid::Uuid::parse_str(&config.run_id).map_err(|_| "invalid run id")?;
    if parsed.hyphenated().to_string() != config.run_id {
        return Err("run id must be one canonical lowercase UUID".into());
    }
    let expected_id = format!("dev.atools.fixture.dialog.{}", config.run_id.replace('-', ""));
    if config.bundle_id != expected_id { return Err("bundle identifier is not derived from this run id".into()); }
    validate_private_directory(&config.control_dir)?;
    if config.control_dir.file_name().and_then(|name| name.to_str()) != Some(format!("launchservices-{}", config.run_id).as_str()) {
        return Err("control directory is not bound to this run id".into());
    }
    for path in [&config.observer_report_path, &config.native_report_path] {
        if path.parent() != Some(config.control_dir.as_path()) {
            return Err("reports must remain inside the private run control directory".into());
        }
    }
    for path in [&config.bundle_path, &config.executable_path] {
        let metadata = fs::symlink_metadata(path).map_err(|error| format!("inspect fixture path: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() && !metadata.is_dir() {
            return Err("fixture path must not be a symlink".into());
        }
    }
    if config.bundle_path.file_name().and_then(|name| name.to_str()).is_none_or(|name| !name.ends_with(".app"))
        || !config.executable_path.starts_with(&config.bundle_path) {
        return Err("target executable must be inside the private .app bundle".into());
    }
    if config.launch_timeout_ms == 0 || config.launch_timeout_ms > 360_000 {
        return Err("launch timeout is outside the bounded fixture range".into());
    }
    if config.process_tag.len() > 80 || !config.process_tag.starts_with("atools-native-smoke-")
        || !config.process_tag.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
        return Err("invalid process identity tag".into());
    }
    if config.target_args.len() > 32 || config.target_args.iter().any(|arg| arg.len() > 8192)
        || config.target_args.iter().map(String::len).sum::<usize>() > 64 * 1024 {
        return Err("launch arguments exceed fixture bounds".into());
    }
    validate_target_arguments(config)?;
    validate_target_environment(config)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_config;
    use super::super::protocol::LaunchConfig;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn config() -> LaunchConfig {
        let run_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let root = std::env::temp_dir().join(format!("launchservices-{run_id}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir(&root).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let bundle = root.join("fixture.app");
        std::fs::create_dir(&bundle).unwrap();
        let executable = bundle.join("Contents/MacOS/fixture");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"fixture").unwrap();
        LaunchConfig {
            run_id: run_id.clone(),
            case_id: "local-json-editor".into(),
            bundle_path: bundle,
            bundle_id: format!("dev.atools.fixture.dialog.{}", run_id.replace('-', "")),
            executable_path: executable,
            target_args: vec!["--published-plugin-panel-ui".into(), "--published-case".into(), "local-json-editor".into(),
                "--run-id".into(), run_id.clone(), "--native-ui-input".into(), "--execute-reviewed-package".into(),
                "--native-launchservices-fixture".into(),
                "--expected-sha256".into(), "a".repeat(64), "--source-review".into(), "/private/tmp/review.json".into(),
                "--panel-ui".into(), "/private/tmp/panel.js".into(), "--panel-css".into(), "/private/tmp/panel.css".into(),
                "--panel-probe".into(), "/private/tmp/probe.js".into(), "--plugin-root".into(), "/private/tmp/plugin".into(),
                "--output".into(), root.join("native.json").to_string_lossy().into_owned(),
                "--fixture-root".into(), "/private/tmp/fixture".into()],
            target_env: BTreeMap::from([("ATOOLS_PANEL_FOREGROUND_MODE".into(), "required".into())]),
            control_dir: root.clone(), observer_report_path: root.join("observer.json"),
            native_report_path: root.join("native.json"), process_tag: "atools-native-smoke-abc123".into(),
            launch_timeout_ms: 30_000,
        }
    }

    #[test]
    fn accepts_only_run_bound_private_editor_bundle() {
        let value = config();
        assert!(validate_config(&value).is_ok());
        let _ = std::fs::remove_dir_all(value.control_dir);
    }

    #[test]
    fn rejects_foreign_bundle_and_unregistered_case() {
        let mut value = config();
        value.bundle_id.push_str("-foreign");
        assert!(validate_config(&value).is_err());
        value.bundle_id = format!("dev.atools.fixture.dialog.{}", value.run_id.replace('-', ""));
        value.case_id = "worker-only".into();
        assert!(validate_config(&value).is_err());
        let _ = std::fs::remove_dir_all(value.control_dir);
    }

    #[test]
    fn report_paths_must_stay_in_control_directory() {
        let mut value = config();
        value.observer_report_path = PathBuf::from("/tmp/outside.json");
        assert!(validate_config(&value).is_err());
        let _ = std::fs::remove_dir_all(value.control_dir);
    }

    #[test]
    fn target_arguments_and_environment_are_exactly_run_bound_and_allowlisted() {
        let mut value = config();
        value.target_args.extend(["--native-ui-input".into()]);
        assert!(validate_config(&value).is_err());
        value.target_args.pop();
        value.target_args[4] = uuid::Uuid::new_v4().hyphenated().to_string();
        assert!(validate_config(&value).is_err());
        value.target_args[4] = value.run_id.clone();
        value.target_args.extend(["--unapproved".into()]);
        assert!(validate_config(&value).is_err());
        value.target_args.pop();
        value.target_env.insert("DYLD_INSERT_LIBRARIES".into(), "/tmp/inject.dylib".into());
        assert!(validate_config(&value).is_err());
        value.target_env.remove("DYLD_INSERT_LIBRARIES");
        value.target_env.insert("ATOOLS_NATIVE_STDIO_FIFO".into(), "/tmp/fifo".into());
        assert!(validate_config(&value).is_err());
        let _ = std::fs::remove_dir_all(value.control_dir);
    }

    #[test]
    fn late_launch_without_the_observer_fifo_permit_is_refused_before_tauri() {
        use super::launchservices_route_required;
        assert!(launchservices_route_required(&["--native-launchservices-fixture".into()], false).is_err());
        assert!(launchservices_route_required(&[], true).is_err());
        assert!(launchservices_route_required(&["--native-launchservices-fixture".into()], true).unwrap());
        assert!(!launchservices_route_required(&[], false).unwrap());
    }
}
