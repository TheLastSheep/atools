//! Validates a host-selected app-owned dependency home before source planning.
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug)]
pub(super) struct TrustedDependencyRoot {
    pub home: PathBuf,
    pub node_modules: PathBuf,
}

impl TrustedDependencyRoot {
    pub fn from_host(source_root: &Path, requested_home: &Path) -> Result<Self, &'static str> {
        if !requested_home.is_absolute() || requested_home.as_os_str().is_empty() {
            return Err("dependency_root_invalid");
        }
        if requested_home
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        {
            return Err("dependency_root_invalid");
        }
        reject_symlink_ancestors(requested_home)?;
        let home = requested_home
            .canonicalize()
            .map_err(|_| "dependency_root_invalid")?;
        if home != requested_home || home.starts_with(source_root) || source_root.starts_with(&home)
        {
            return Err("dependency_root_invalid");
        }
        let node_modules = home.join("node_modules");
        let metadata =
            fs::symlink_metadata(&node_modules).map_err(|_| "dependency_root_invalid")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("dependency_root_invalid");
        }
        let canonical = node_modules
            .canonicalize()
            .map_err(|_| "dependency_root_invalid")?;
        if canonical != node_modules || !canonical.starts_with(&home) {
            return Err("dependency_root_invalid");
        }
        Ok(Self {
            home,
            node_modules: canonical,
        })
    }
}

fn reject_symlink_ancestors(path: &Path) -> Result<(), &'static str> {
    let mut cursor = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => cursor.push(prefix.as_os_str()),
            Component::RootDir => cursor.push(component.as_os_str()),
            Component::Normal(part) => {
                cursor.push(part);
                let metadata =
                    fs::symlink_metadata(&cursor).map_err(|_| "dependency_root_invalid")?;
                if metadata.file_type().is_symlink() {
                    return Err("dependency_root_invalid");
                }
            }
            Component::CurDir | Component::ParentDir => return Err("dependency_root_invalid"),
        }
    }
    Ok(())
}
