//! Application configuration and path management.

use std::path::{Path, PathBuf};

use crate::error::AToolsError;

/// Central configuration holding the base directory for all ATools data.
#[derive(Debug, Clone)]
pub struct AppConfig {
    /// Base directory (default: `~/.atools/`).
    base_dir: PathBuf,
}

impl AppConfig {
    /// Creates a new `AppConfig` using the default base directory `~/.atools/`.
    ///
    /// # Errors
    ///
    /// Returns an error if the home directory cannot be determined.
    pub fn new() -> crate::error::Result<Self> {
        let home = dirs::home_dir()
            .ok_or_else(|| AToolsError::Config("Cannot determine home directory".into()))?;
        Ok(Self {
            base_dir: home.join(".atools"),
        })
    }

    /// Creates a new `AppConfig` with a custom base directory.
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Returns the base directory path.
    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    /// Returns the path to the SQLite database file.
    pub fn db_path(&self) -> PathBuf {
        self.base_dir.join("data.db")
    }

    /// Returns the path to the plugins directory.
    pub fn plugins_dir(&self) -> PathBuf {
        self.base_dir.join("plugins")
    }

    /// Returns the private data directory for the native Paste clipboard runtime.
    pub fn pasteboard_dir(&self) -> PathBuf {
        self.base_dir.join("pasteboard")
    }

    /// Returns the content-addressed attachment directory used by Paste items.
    pub fn pasteboard_blobs_dir(&self) -> PathBuf {
        self.pasteboard_dir().join("blobs")
    }

    /// Returns the path to the settings JSON file.
    pub fn settings_path(&self) -> PathBuf {
        self.base_dir.join("settings.json")
    }

    /// Returns the installation directory for a specific plugin.
    pub fn plugin_dir(&self, id: &str) -> PathBuf {
        self.plugins_dir().join(id)
    }

    /// Ensures that all required directories exist, creating them if necessary.
    ///
    /// Creates:
    /// - `~/.atools/`
    /// - `~/.atools/plugins/`
    ///
    /// # Errors
    ///
    /// Returns an error if directory creation fails.
    pub fn ensure_dirs(&self) -> crate::error::Result<()> {
        std::fs::create_dir_all(&self.base_dir)?;
        std::fs::create_dir_all(self.plugins_dir())?;
        std::fs::create_dir_all(self.pasteboard_blobs_dir())?;
        tracing::debug!("Ensured config directories at {:?}", self.base_dir);
        Ok(())
    }

    /// Loads application settings from `settings.json` if it exists.
    ///
    /// Returns an empty `serde_json::Value::Object` if the file does not exist.
    pub fn load_settings(&self) -> crate::error::Result<serde_json::Value> {
        let path = self.settings_path();
        if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            let val: serde_json::Value = serde_json::from_str(&content)?;
            Ok(val)
        } else {
            Ok(serde_json::json!({}))
        }
    }

    /// Saves application settings to `settings.json`.
    ///
    /// # Errors
    ///
    /// Returns an error if the file cannot be written or JSON serialization fails.
    pub fn save_settings(&self, settings: &serde_json::Value) -> crate::error::Result<()> {
        let content = serde_json::to_string_pretty(settings)?;
        std::fs::write(self.settings_path(), content)?;
        Ok(())
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self::new().expect("Failed to determine home directory for AppConfig")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_config() -> AppConfig {
        AppConfig::with_base_dir(PathBuf::from("/tmp/atools-test"))
    }

    #[test]
    fn test_paths() {
        let cfg = test_config();
        assert_eq!(cfg.base_dir(), Path::new("/tmp/atools-test"));
        assert_eq!(cfg.db_path(), PathBuf::from("/tmp/atools-test/data.db"));
        assert_eq!(cfg.plugins_dir(), PathBuf::from("/tmp/atools-test/plugins"));
        assert_eq!(
            cfg.pasteboard_blobs_dir(),
            PathBuf::from("/tmp/atools-test/pasteboard/blobs")
        );
        assert_eq!(
            cfg.settings_path(),
            PathBuf::from("/tmp/atools-test/settings.json")
        );
    }

    #[test]
    fn test_plugin_dir() {
        let cfg = test_config();
        assert_eq!(
            cfg.plugin_dir("my-plugin"),
            PathBuf::from("/tmp/atools-test/plugins/my-plugin")
        );
    }

    #[test]
    fn test_ensure_dirs() {
        let base = PathBuf::from("/tmp/atools-test-ensure");
        let _ = std::fs::remove_dir_all(&base);
        let cfg = AppConfig::with_base_dir(base.clone());
        cfg.ensure_dirs().unwrap();
        assert!(base.join("plugins").is_dir());
        assert!(base.join("pasteboard/blobs").is_dir());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_settings_round_trip() {
        let base = PathBuf::from("/tmp/atools-test-settings");
        let _ = std::fs::remove_dir_all(&base);
        let cfg = AppConfig::with_base_dir(base.clone());
        cfg.ensure_dirs().unwrap();

        let settings = serde_json::json!({"theme": "dark", "lang": "zh-CN"});
        cfg.save_settings(&settings).unwrap();

        let loaded = cfg.load_settings().unwrap();
        assert_eq!(loaded["theme"], "dark");
        assert_eq!(loaded["lang"], "zh-CN");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_load_settings_missing_file() {
        let base = PathBuf::from("/tmp/atools-test-no-settings");
        let _ = std::fs::remove_dir_all(&base);
        let cfg = AppConfig::with_base_dir(base.clone());
        cfg.ensure_dirs().unwrap();

        let loaded = cfg.load_settings().unwrap();
        assert!(loaded.is_object());
        assert!(loaded.as_object().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }
}
