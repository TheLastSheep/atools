//! Exact macOS sandbox boundary for an untrusted, locally installed Vite toolchain.
use atools_plugin::source_build::ViteBuildBackend;
use std::path::{Path, PathBuf};

// Receipt version covers both the rendered SBPL and bootstrap-enforced process resource limits.
pub(super) const ADAPTER_VERSION: &str = "macos-sbpl-v4-vite-backend-fd2048";

/// This profile establishes neither an aggregate resource cap nor prevention of
/// every POSIX_SPAWN_SETSID/SETPGROUP escape. Receipts must preserve that limit.
pub(super) fn render(
    stage: &Path,
    dependencies: &Path,
    node: &Path,
    esbuild: &Path,
) -> Result<String, String> {
    render_with_test_esbuild(stage, dependencies, node, esbuild, None)
}

pub(super) fn render_with_test_esbuild(
    stage: &Path,
    dependencies: &Path,
    node: &Path,
    esbuild: &Path,
    test_esbuild: Option<&Path>,
) -> Result<String, String> {
    render_with_vite_backend(
        stage,
        dependencies,
        node,
        &ViteBuildBackend::Esbuild {
            binary: esbuild.to_path_buf(),
        },
        test_esbuild,
    )
}

pub(super) fn render_with_vite_backend(
    stage: &Path,
    dependencies: &Path,
    node: &Path,
    backend: &ViteBuildBackend,
    test_esbuild: Option<&Path>,
) -> Result<String, String> {
    let backend_path = backend.path();
    let rolldown_backend = matches!(backend, ViteBuildBackend::Rolldown { .. });
    if !backend_path.starts_with(dependencies)
        || test_esbuild.is_some_and(|path| {
            !path.starts_with(dependencies) || (rolldown_backend && path == backend_path)
        })
        || rolldown_backend
            && !backend_path
                .extension()
                .is_some_and(|extension| extension == "node")
    {
        return Err("SourceBuildUnsafeToolchain".into());
    }
    let mut profile = String::from("(version 1)\n(deny default)\n");
    // Local macOS dyld-support.sb:65-71: libignition opens this directory
    // itself as its openat root. This grants no descendant file contents.
    profile.push_str("(allow file-read* file-test-existence (literal \"/\"))\n");
    profile.push_str(&format!(
        "(allow file-read* file-write* (subpath {}))\n",
        quote(stage)?
    ));
    profile.push_str(&format!(
        "(allow file-read* (subpath {}))\n",
        quote(dependencies)?
    ));
    let mut executable_mappings = vec![node];
    let mut process_executables = vec![node];
    match backend {
        ViteBuildBackend::Esbuild { binary } => {
            executable_mappings.push(binary);
            process_executables.push(binary);
        }
        ViteBuildBackend::Rolldown { binding } => executable_mappings.push(binding),
    }
    if let Some(test_esbuild) = test_esbuild.filter(|path| *path != backend_path) {
        executable_mappings.push(test_esbuild);
        process_executables.push(test_esbuild);
    }
    profile.push_str("(allow file-read* file-map-executable");
    for binary in &executable_mappings {
        profile.push_str(&format!(" (literal {})", quote(binary)?));
    }
    profile.push_str(")\n");
    profile.push_str("(allow file-read* file-map-executable (subpath \"/usr/lib\") (subpath \"/System/Library\") (subpath \"/System/Volumes/Preboot/Cryptexes/OS/usr/lib\"))\n");
    profile
        .push_str("(allow file-read-data (literal \"/dev/urandom\") (literal \"/dev/random\"))\n");
    let mut ancestors = vec![PathBuf::from("/")];
    let mut paths = vec![stage, dependencies, node, backend_path];
    if let Some(test_esbuild) = test_esbuild {
        paths.push(test_esbuild);
    }
    for path in paths {
        for parent in path.ancestors().skip(1) {
            if !ancestors.iter().any(|known| known == parent) {
                ancestors.push(parent.to_path_buf());
            }
        }
    }
    profile.push_str("(allow file-read-metadata");
    for ancestor in ancestors {
        profile.push_str(&format!(" (literal {})", quote(&ancestor)?));
    }
    profile.push_str(")\n(allow process-fork)\n");
    profile.push_str("(allow process-exec");
    for binary in &process_executables {
        profile.push_str(&format!(" (literal {})", quote(binary)?));
    }
    profile.push_str(")\n");
    profile.push_str("(allow process-info* (target self))\n(allow sysctl-read)\n");
    // These direct syscall denials are defense in depth. They do not cover
    // equivalent posix_spawn flags and are never advertised as full-tree proof.
    profile.push_str("(deny syscall-unix (syscall-number 82) (syscall-number 147))\n");
    Ok(profile)
}

fn quote(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("SourceBuildUnsupportedPathEncoding")?;
    if !path.is_absolute() || value.chars().any(char::is_control) {
        return Err("SourceBuildUnsafeProfilePath".into());
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn only_stage_is_writable_and_no_network_or_import_is_allowed() {
        let text = render(
            Path::new("/private/tmp/a\"b"),
            Path::new("/deps"),
            Path::new("/tools/node"),
            Path::new("/deps/esbuild"),
        )
        .unwrap();
        assert!(text.contains("(subpath \"/private/tmp/a\\\"b\")"));
        assert_eq!(text.matches("file-write").count(), 1);
        for forbidden in ["allow network", "allow mach", "(import", "(allow default)"] {
            assert!(!text.contains(forbidden));
        }
        assert!(render(
            Path::new("/bad\npath"),
            Path::new("/deps"),
            Path::new("/node"),
            Path::new("/esbuild")
        )
        .is_err());
    }

    #[test]
    fn optional_test_esbuild_is_exact_and_deduplicated() {
        let stage = Path::new("/private/tmp/stage");
        let dependencies = Path::new("/private/tmp/plugin/node_modules");
        let node = Path::new("/tools/node");
        let vite = Path::new("/private/tmp/plugin/node_modules/vite-esbuild");
        let test = Path::new("/private/tmp/plugin/node_modules/test-esbuild");
        let extra = render_with_test_esbuild(stage, dependencies, node, vite, Some(test)).unwrap();
        assert!(extra.contains("(literal \"/private/tmp/plugin/node_modules/test-esbuild\")"));
        let executable_rule = format!(
            "(allow file-read* file-map-executable (literal \"/tools/node\") (literal \"/private/tmp/plugin/node_modules/vite-esbuild\") (literal \"/private/tmp/plugin/node_modules/test-esbuild\"))"
        );
        assert!(extra.contains(&executable_rule));
        assert_eq!(extra.matches("process-exec").count(), 1);
        assert!(extra.contains(
            "(allow process-exec (literal \"/tools/node\") (literal \"/private/tmp/plugin/node_modules/vite-esbuild\") (literal \"/private/tmp/plugin/node_modules/test-esbuild\"))"
        ));
        assert_eq!(
            extra
                .matches("/private/tmp/plugin/node_modules/test-esbuild")
                .count(),
            2
        );
        assert!(!extra.contains("third-esbuild"));
        assert!(render_with_test_esbuild(
            stage,
            dependencies,
            node,
            vite,
            Some(Path::new("/outside/third-esbuild")),
        )
        .is_err());

        let same = render_with_test_esbuild(stage, dependencies, node, vite, Some(vite)).unwrap();
        assert_eq!(
            same.matches("/private/tmp/plugin/node_modules/vite-esbuild")
                .count(),
            2
        );
        assert!(!same.contains("test-esbuild"));
    }

    #[test]
    fn rolldown_binding_is_only_mappable_and_never_process_executable() {
        let binding = Path::new(
            "/private/tmp/deps/@rolldown/binding-darwin-arm64/rolldown-binding.darwin-arm64.node",
        );
        let text = render_with_vite_backend(
            Path::new("/private/tmp/stage"),
            Path::new("/private/tmp/deps"),
            Path::new("/tools/node"),
            &ViteBuildBackend::Rolldown {
                binding: binding.into(),
            },
            None,
        )
        .unwrap();
        assert!(text.contains(&format!(
            "(allow file-read* file-map-executable (literal \"/tools/node\") (literal \"{}\"))",
            binding.display()
        )));
        assert!(text.contains("(allow file-read* (subpath \"/private/tmp/deps\"))"));
        assert!(!text.contains(&format!(
            "(allow process-exec (literal \"{}\"))",
            binding.display()
        )));
        assert!(render_with_vite_backend(
            Path::new("/stage"),
            Path::new("/deps"),
            Path::new("/node"),
            &ViteBuildBackend::Rolldown {
                binding: Path::new("/outside/binding.node").into()
            },
            None
        )
        .is_err());
        assert!(render_with_vite_backend(
            Path::new("/stage"),
            Path::new("/deps"),
            Path::new("/node"),
            &ViteBuildBackend::Rolldown {
                binding: Path::new("/deps/binding.js").into()
            },
            None
        )
        .is_err());
        assert!(render_with_vite_backend(
            Path::new("/private/tmp/stage"),
            Path::new("/private/tmp/deps"),
            Path::new("/tools/node"),
            &ViteBuildBackend::Rolldown {
                binding: binding.into()
            },
            Some(binding)
        )
        .is_err());
    }
}
