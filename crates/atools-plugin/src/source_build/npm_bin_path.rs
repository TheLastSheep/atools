//! Resolves npm package bin paths under their installed package directory.
//!
//! Accept normal relative paths and npm's conventional single leading dot
//! slash, while rejecting lexical aliases before Path can normalize them.
//! Canonical file, symlink, and dependency-root checks remain mandatory.
use std::path::{Component, Path, PathBuf};

use super::super::metadata::canonical_regular_file;

pub(super) fn resolve_package_bin(
    root: &Path,
    dependency_root: &Path,
    package_name: &str,
    value: &str,
) -> Result<PathBuf, ()> {
    if package_name.is_empty()
        || package_name.contains('/')
        || package_name.contains('\\')
        || package_name == "."
        || package_name == ".."
    {
        return Err(());
    }
    let package_relative = PathBuf::from("node_modules").join(package_name);
    if package_relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(());
    }
    let relative = package_relative.join(normalize_package_bin(value)?);
    let canonical = canonical_regular_file(root, &relative)?.ok_or(())?;
    if !canonical.starts_with(dependency_root) {
        return Err(());
    }
    Ok(canonical)
}

fn normalize_package_bin(value: &str) -> Result<PathBuf, ()> {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || has_windows_drive_prefix(value)
    {
        return Err(());
    }

    let relative = value.strip_prefix("./").unwrap_or(value);
    if relative.is_empty()
        || relative.starts_with('/')
        || has_windows_drive_prefix(relative)
        || relative.contains("//")
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(());
    }

    let path = Path::new(relative);
    if path.is_absolute()
        || path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(());
    }
    Ok(path.to_path_buf())
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::fs;

    fn toolchain_fixture() -> (tempfile::TempDir, Value, Value) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for package in ["vite", "vue-tsc"] {
            let bin = if package == "vue-tsc" {
                "./bin/vue-tsc.js"
            } else {
                "bin/vite.js"
            };
            let version = if package == "vue-tsc" {
                "2.2.12"
            } else {
                "6.4.3"
            };
            let relative = PathBuf::from("node_modules").join(package);
            fs::create_dir_all(root.join(&relative).join("bin")).unwrap();
            fs::write(
                root.join(&relative).join("package.json"),
                json!({
                    "name": package,
                    "version": version,
                    "bin": {(package): bin}
                })
                .to_string(),
            )
            .unwrap();
            let filename = if package == "vue-tsc" {
                "vue-tsc.js"
            } else {
                "vite.js"
            };
            fs::write(root.join(&relative).join("bin").join(filename), "fixture").unwrap();
        }
        let project = json!({
            "devDependencies": {"vite":"^6.0.11","vue-tsc":"^2.2.0"}
        });
        let lock = json!({
            "packages": {
                "": {"devDependencies":{"vite":"^6.0.11","vue-tsc":"^2.2.0"}},
                "node_modules/vite":{"version":"6.4.3"},
                "node_modules/vue-tsc":{"version":"2.2.12"}
            }
        });
        (temp, project, lock)
    }

    #[test]
    fn validates_vue_tsc_dot_bin_and_normal_vite_through_toolchain_entry() {
        let (temp, project, lock) = toolchain_fixture();
        let root = temp.path().canonicalize().unwrap();
        let dependencies = root.join("node_modules");
        let vue_tsc = super::super::validate_tool(&root, &project, &lock, &dependencies, "vue-tsc")
            .unwrap()
            .unwrap();
        let vite = super::super::validate_tool(&root, &project, &lock, &dependencies, "vite")
            .unwrap()
            .unwrap();
        assert_eq!(vue_tsc, dependencies.join("vue-tsc/bin/vue-tsc.js"));
        assert_eq!(vite, dependencies.join("vite/bin/vite.js"));
    }

    #[test]
    fn accepts_only_normal_or_single_leading_dot_bin_spelling() {
        assert_eq!(
            normalize_package_bin("bin/tool.js").unwrap(),
            PathBuf::from("bin/tool.js")
        );
        assert_eq!(
            normalize_package_bin("./bin/tool.js").unwrap(),
            PathBuf::from("bin/tool.js")
        );
        for value in [
            "",
            "../tool.js",
            "a/../tool.js",
            "a/./tool.js",
            "././tool.js",
            "././bin/tool.js",
            "./",
            "bin//tool.js",
            "./bin//tool.js",
            "/bin/tool.js",
            "C:/bin/tool.js",
            "C:tool.js",
            "./C:/bin/tool.js",
            "./C:tool.js",
            "C:\\bin\\tool.js",
            "\\\\server\\share\\tool.js",
            "bin\\tool.js",
            "./bin/../tool.js",
            "./bin/./tool.js",
        ] {
            assert!(normalize_package_bin(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn rejects_parent_path_from_actual_validate_tool_entry() {
        let (temp, project, mut lock) = toolchain_fixture();
        let root = temp.path().canonicalize().unwrap();
        let dependencies = root.join("node_modules");
        let metadata = root.join("node_modules/vue-tsc/package.json");
        fs::write(
            &metadata,
            json!({
                "name":"vue-tsc","version":"2.2.12","bin":{"vue-tsc":"../outside.js"}
            })
            .to_string(),
        )
        .unwrap();
        fs::write(root.join("outside.js"), "fixture").unwrap();
        lock["packages"]["node_modules/vue-tsc"]["bin"] = json!({"vue-tsc":"../outside.js"});
        assert!(
            super::super::validate_tool(&root, &project, &lock, &dependencies, "vue-tsc",).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_bin_components_through_validate_tool_entry() {
        use std::os::unix::fs::symlink;
        let (temp, project, lock) = toolchain_fixture();
        let root = temp.path().canonicalize().unwrap();
        let dependencies = root.join("node_modules");
        let outside = tempfile::tempdir().unwrap();
        let outside_root = outside.path().canonicalize().unwrap();
        fs::write(outside_root.join("vue-tsc.js"), "fixture").unwrap();
        fs::remove_dir_all(dependencies.join("vue-tsc/bin")).unwrap();
        symlink(&outside_root, dependencies.join("vue-tsc/bin")).unwrap();
        assert!(
            super::super::validate_tool(&root, &project, &lock, &dependencies, "vue-tsc",).is_err()
        );
    }
}
