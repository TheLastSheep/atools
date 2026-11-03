#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

pub(super) const PRODUCTION_IDENTIFIERS: [&str; 2] = ["dev.atools.desktop", "com.atools.desktop"];
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
const SETTINGS_INPUT_IDENTIFIER_PREFIX: &str = "dev.atools.renderer-settings-input.";
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
const RENDERER_SMOKE_IDENTIFIER_PREFIX: &str = "dev.atools.renderer-smoke.";
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
const SETTINGS_INPUT_ROOT_PREFIX: &str = "atools-renderer-settings-input-";
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
const RENDERER_SMOKE_ROOT_PREFIX: &str = "atools-renderer-native-";

pub(super) fn is_production_identifier(identifier: &str) -> bool {
    PRODUCTION_IDENTIFIERS.contains(&identifier)
}

pub(super) fn production_bundle_matches(configured_identifier: &str, bundle_matches: bool) -> bool {
    is_production_identifier(configured_identifier) && bundle_matches
}

#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct IsolatedProof {
    pub(super) identifier: String,
    pub(super) root: PathBuf,
    pub(super) root_device: u64,
    pub(super) root_inode: u64,
    pub(super) run_id: String,
    pub(super) executable: PathBuf,
}

#[cfg(target_os = "macos")]
pub(super) fn legacy_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join("com.atools.desktop.plist"))
}

#[cfg(target_os = "macos")]
pub(super) fn legacy_configuration_present() -> Result<bool, &'static str> {
    match std::fs::symlink_metadata(legacy_path().map_err(|_| super::UNAVAILABLE)?) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(super::UNAVAILABLE),
    }
}

pub(super) fn legacy_plist(executable_path: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.atools.desktop</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
        xml_escape(executable_path)
    )
}

#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub(super) fn validate_isolated_scope(
    identifier: &str,
    root: &Path,
    run_id: &str,
    executable: &Path,
) -> Result<IsolatedProof, &'static str> {
    use std::os::unix::fs::MetadataExt;

    let settings_input_scope = identifier == format!("{SETTINGS_INPUT_IDENTIFIER_PREFIX}{run_id}")
        && root == Path::new("/private/tmp").join(format!("{SETTINGS_INPUT_ROOT_PREFIX}{run_id}"));
    let renderer_smoke_scope = identifier == format!("{RENDERER_SMOKE_IDENTIFIER_PREFIX}{run_id}")
        && root == Path::new("/private/tmp").join(format!("{RENDERER_SMOKE_ROOT_PREFIX}{run_id}"));
    if !valid_run_id(run_id) || !(settings_input_scope || renderer_smoke_scope) {
        return Err(super::UNAVAILABLE);
    }
    let metadata = std::fs::symlink_metadata(root).map_err(|_| super::UNAVAILABLE)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(super::UNAVAILABLE);
    }
    let canonical_root = root.canonicalize().map_err(|_| super::UNAVAILABLE)?;
    if canonical_root != root {
        return Err(super::UNAVAILABLE);
    }
    let supplied_executable_metadata =
        std::fs::symlink_metadata(executable).map_err(|_| super::UNAVAILABLE)?;
    if !executable.is_absolute()
        || !supplied_executable_metadata.is_file()
        || supplied_executable_metadata.file_type().is_symlink()
    {
        return Err(super::UNAVAILABLE);
    }
    let requested_executable = executable.canonicalize().map_err(|_| super::UNAVAILABLE)?;
    let running_executable = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|_| super::UNAVAILABLE)?;
    let executable_metadata =
        std::fs::symlink_metadata(&requested_executable).map_err(|_| super::UNAVAILABLE)?;
    if requested_executable != running_executable
        || !executable_metadata.is_file()
        || executable_metadata.file_type().is_symlink()
    {
        return Err(super::UNAVAILABLE);
    }
    Ok(IsolatedProof {
        identifier: identifier.to_owned(),
        root: canonical_root,
        root_device: metadata.dev(),
        root_inode: metadata.ino(),
        run_id: run_id.to_owned(),
        executable: requested_executable,
    })
}

#[cfg(any(test, all(feature = "legacy-node-smoke", target_os = "macos")))]
pub(super) fn valid_run_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::{
        is_production_identifier, legacy_plist, production_bundle_matches, valid_run_id,
        PRODUCTION_IDENTIFIERS,
    };

    #[test]
    fn production_policy_accepts_only_exact_product_ids_and_real_tauri_config() {
        let config: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tauri.conf.json"
        )))
        .expect("the checked-in Tauri config is valid JSON");
        let configured = config["identifier"]
            .as_str()
            .expect("the checked-in Tauri config has an identifier");
        assert!(is_production_identifier(configured));
        assert_eq!(
            PRODUCTION_IDENTIFIERS,
            ["dev.atools.desktop", "com.atools.desktop"]
        );
        assert!(is_production_identifier("com.atools.desktop"));
        for identifier in [
            "com.atools.desktop.child",
            "com.atools.desktops",
            "dev.atools.desktop.child",
            "dev.atools.renderer-settings-input.0123456789abcdef0123456789abcdef",
            "dev.atools.renderer-smoke.0123456789abcdef0123456789abcdef",
            "org.example.atools",
        ] {
            assert!(!is_production_identifier(identifier), "{identifier}");
        }
    }

    #[test]
    fn app_policy_requires_an_exact_production_config_and_bundle_match() {
        assert!(production_bundle_matches("dev.atools.desktop", true));
        assert!(production_bundle_matches("com.atools.desktop", true));
        assert!(!production_bundle_matches("dev.atools.desktop", false));
        assert!(!production_bundle_matches(
            "dev.atools.renderer-smoke.0123456789abcdef0123456789abcdef",
            true
        ));
        assert!(!production_bundle_matches("com.atools.desktop.child", true));
    }

    #[test]
    fn legacy_plist_wrapper_keeps_fixed_label_and_escapes_executable() {
        let plist = legacy_plist("/tmp/A&B<ATools>.app/ATools");
        assert!(plist.contains("<string>com.atools.desktop</string>"));
        assert!(plist.contains("/tmp/A&amp;B&lt;ATools&gt;.app/ATools"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_path_keeps_the_historical_launch_agent_filename() {
        assert!(super::legacy_path()
            .expect("home path is available")
            .ends_with("Library/LaunchAgents/com.atools.desktop.plist"));
    }

    #[test]
    fn isolated_run_id_requires_32_lowercase_hex_characters() {
        assert!(valid_run_id("0123456789abcdef0123456789abcdef"));
        assert!(!valid_run_id("0123456789ABCDEF0123456789ABCDEF"));
        assert!(!valid_run_id("0123456789abcdef"));
    }
}
