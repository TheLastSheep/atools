//! Narrow real-package profile for the isolated source-build acceptance.
use serde_json::Value;
use std::{fs, path::Path};

pub(super) enum Profile {
    Synthetic,
    SyntheticTypeScript,
    ApplicationUninstaller { version: String },
}

impl Profile {
    pub(super) fn parse(args: &[String], success: &Path) -> Result<Self, String> {
        let positions = args
            .iter()
            .enumerate()
            .filter_map(|(index, value)| (value == "--source-build-profile").then_some(index))
            .collect::<Vec<_>>();
        if positions.len() > 1 {
            return Err("Source-build profile must be unique".into());
        }
        let value = match positions.first() {
            Some(index) => Some(
                args.get(*index + 1)
                    .ok_or("Source-build profile requires a value")?
                    .as_str(),
            ),
            None => None,
        };
        match value {
            None | Some("synthetic") => Ok(Self::Synthetic),
            Some("synthetic-typescript") => Ok(Self::SyntheticTypeScript),
            Some("application-uninstaller") => Self::application_uninstaller(success),
            Some(_) => Err("Unsupported source-build profile".into()),
        }
    }

    fn application_uninstaller(success: &Path) -> Result<Self, String> {
        let manifest = read_json(&success.join("plugin.json"))?;
        let package = read_json(&success.join("package.json"))?;
        let lock = read_json(&success.join("package-lock.json"))?;
        let name = manifest.get("name").and_then(Value::as_str);
        let version = manifest.get("version").and_then(Value::as_str);
        let dependencies = fs::symlink_metadata(success.join("node_modules"))
            .map_err(|_| "Pinned package dependencies are missing")?;
        if name != Some("application-uninstaller")
            || version != Some("0.1.0")
            || package.get("name").and_then(Value::as_str) != name
            || package.get("version").and_then(Value::as_str) != version
            || lock.get("name").and_then(Value::as_str) != name
            || lock.get("version").and_then(Value::as_str) != version
            || !dependencies.is_dir()
            || dependencies.file_type().is_symlink()
            || ["dist", "release", ".npm-cache", ".git"]
                .iter()
                .any(|name| success.join(name).exists())
        {
            return Err(
                "Real source-build profile does not match its pinned package identity".into(),
            );
        }
        Ok(Self::ApplicationUninstaller {
            version: version.unwrap().to_owned(),
        })
    }

    pub(super) fn plugin_id(&self) -> &'static str {
        match self {
            Self::Synthetic | Self::SyntheticTypeScript => "source-build-fixture",
            Self::ApplicationUninstaller { .. } => "application-uninstaller",
        }
    }

    pub(super) fn label(&self) -> &'static str {
        match self {
            Self::Synthetic | Self::SyntheticTypeScript => "synthetic",
            Self::ApplicationUninstaller { .. } => "application-uninstaller",
        }
    }

    pub(super) fn seeds_baseline(&self) -> bool {
        matches!(self, Self::Synthetic | Self::SyntheticTypeScript)
    }

    pub(super) fn typescript_build(&self) -> bool {
        matches!(self, Self::SyntheticTypeScript)
    }

    pub(super) fn expected_version(&self) -> Option<&str> {
        match self {
            Self::Synthetic | Self::SyntheticTypeScript => Some("1.0.0"),
            Self::ApplicationUninstaller { version } => Some(version),
        }
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Pinned package metadata is missing")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 256 * 1024 {
        return Err("Pinned package metadata is not a bounded regular file".into());
    }
    let bytes = fs::read(path).map_err(|_| "Pinned package metadata could not be read")?;
    if bytes.len() > 256 * 1024 {
        return Err("Pinned package metadata is not a bounded regular file".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Pinned package metadata is invalid".to_owned())
}
