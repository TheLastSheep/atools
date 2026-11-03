use super::*;
use serde_json::{json, Value};
use std::fs;
use tempfile::tempdir;

struct RolldownFixture {
    root: tempfile::TempDir,
    target: BuildTargetV1,
}

impl RolldownFixture {
    fn new() -> Self {
        let root = tempdir().unwrap();
        let target = current_build_target().unwrap();
        let target_suffix = format!("{}-{}", target.os, target.cpu);
        let vite = root.path().join("node_modules/vite");
        fs::create_dir_all(vite.join("bin")).unwrap();
        fs::create_dir_all(vite.join("dist/node")).unwrap();
        fs::write(vite.join("bin/vite.js"), "// fixture").unwrap();
        fs::write(vite.join("package.json"), serde_json::to_vec(&json!({
            "name":"vite","version":"8.0.13","bin":{"vite":"bin/vite.js"},
            "dependencies":{"rolldown":"1.0.1"}
        })).unwrap()).unwrap();
        let rolldown = root.path().join("node_modules/rolldown");
        fs::create_dir_all(rolldown.join("dist")).unwrap();
        fs::write(rolldown.join("package.json"), serde_json::to_vec(&json!({
            "name":"rolldown","version":"1.0.1",
            "optionalDependencies":{format!("@rolldown/binding-{target_suffix}"):"1.0.1"}
        })).unwrap()).unwrap();
        let binding_name = format!("@rolldown/binding-{target_suffix}");
        let binding = root.path().join("node_modules").join(&binding_name);
        fs::create_dir_all(&binding).unwrap();
        fs::write(binding.join("package.json"), serde_json::to_vec(&json!({
            "name":binding_name,"version":"1.0.1","main":"rolldown-binding.fixture.node",
            "os":[target.os],"cpu":[target.cpu],"exports":null
        })).unwrap()).unwrap();
        fs::write(binding.join("rolldown-binding.fixture.node"), b"fixture binding").unwrap();
        let lock = json!({"lockfileVersion":3,"packages":{
            "":{"devDependencies":{"vite":"^8.0.0"}},
            "node_modules/vite":{"version":"8.0.13","dependencies":{"rolldown":"1.0.1"}},
            "node_modules/rolldown":{"version":"1.0.1","optionalDependencies":{
                format!("@rolldown/binding-{target_suffix}"):"1.0.1"}},
            (format!("node_modules/@rolldown/binding-{target_suffix}")):{
                "version":"1.0.1","optional":true,"os":[target.os],"cpu":[target.cpu]}
        }});
        fs::write(root.path().join("package-lock.json"), serde_json::to_vec(&lock).unwrap()).unwrap();
        Self { root, target }
    }

    fn paths(&self) -> (PathBuf, PathBuf, PathBuf, Value, Value) {
        let root = self.root.path().canonicalize().unwrap();
        let dependency_root = root.join("node_modules").canonicalize().unwrap();
        let vite_cli = root.join("node_modules/vite/bin/vite.js").canonicalize().unwrap();
        let project = json!({"devDependencies":{"vite":"^8.0.0"}});
        let lock = serde_json::from_slice(&fs::read(root.join("package-lock.json")).unwrap()).unwrap();
        (root, dependency_root, vite_cli, project, lock)
    }

    fn resolve(&self) -> Result<ViteBuildBackend, ResolveBackendError> {
        let (root, dependencies, cli, project, lock) = self.paths();
        resolve_vite_backend_for_target(&root, &dependencies, &cli, &project, &lock, &self.target)
    }

    fn binding_path(&self) -> PathBuf {
        self.root.path().canonicalize().unwrap().join("node_modules/@rolldown").join(format!(
            "binding-{}-{}", self.target.os, self.target.cpu
        )).join("rolldown-binding.fixture.node").canonicalize().unwrap()
    }
}

#[test]
fn rolldown_backend_requires_installed_target_package_and_locked_native_main() {
    let fixture = RolldownFixture::new();
    let resolved = fixture.resolve().unwrap();
    assert_eq!(resolved, ViteBuildBackend::Rolldown { binding: fixture.binding_path() });

    let binding_root = fixture.root.path().join("node_modules/@rolldown").join(format!(
        "binding-{}-{}", fixture.target.os, fixture.target.cpu
    ));
    fs::remove_file(binding_root.join("rolldown-binding.fixture.node")).unwrap();
    assert_eq!(fixture.resolve(), Err(ResolveBackendError::Missing));
}

#[test]
fn rolldown_backend_rejects_lock_target_or_main_drift() {
    for (key, value) in [
        ("cpu", json!(["wrong-cpu"])),
        ("os", json!(["wrong-os"])),
        ("main", json!("../outside.node")),
        ("exports", json!({".":"./loader.js"})),
    ] {
        let fixture = RolldownFixture::new();
        let binding_root = fixture.root.path().join("node_modules/@rolldown").join(format!(
            "binding-{}-{}", fixture.target.os, fixture.target.cpu
        ));
        let manifest_path = binding_root.join("package.json");
        let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest[key] = value;
        fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(fixture.resolve(), Err(ResolveBackendError::LockMismatch), "{key}");
    }

    let fixture = RolldownFixture::new();
    let binding_path = fixture.root.path().join("node_modules/@rolldown").join(format!(
        "binding-{}-{}", fixture.target.os, fixture.target.cpu
    ));
    let manifest_path = binding_path.join("package.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["main"] = json!("role.node");
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    fs::write(binding_path.join("role.node"), b"fixture").unwrap();
    let mut paths = fixture.paths();
    let binding_lock_key = format!("node_modules/@rolldown/binding-{}-{}", fixture.target.os, fixture.target.cpu);
    paths.4["packages"][binding_lock_key.as_str()]["version"] = json!("2.0.0");
    assert_eq!(resolve_vite_backend_for_target(&paths.0, &paths.1, &paths.2, &paths.3, &paths.4, &fixture.target), Err(ResolveBackendError::LockMismatch));
}

#[test]
fn ambiguous_or_unlocked_vite_backend_does_not_fall_back() {
    let fixture = RolldownFixture::new();
    let (root, dependencies, cli, mut project, mut lock) = fixture.paths();
    let vite_manifest_path = root.join("node_modules/vite/package.json");
    let mut vite: Value = serde_json::from_slice(&fs::read(&vite_manifest_path).unwrap()).unwrap();
    vite["dependencies"]["esbuild"] = json!("0.28.1");
    fs::write(vite_manifest_path, serde_json::to_vec(&vite).unwrap()).unwrap();
    project["devDependencies"]["esbuild"] = json!("0.28.1");
    lock["packages"]["node_modules/vite"]["dependencies"]["esbuild"] = json!("0.28.1");
    assert_eq!(resolve_vite_backend_for_target(&root, &dependencies, &cli, &project, &lock, &fixture.target),
        Err(ResolveBackendError::Ambiguous));

    let fixture = RolldownFixture::new();
    let (root, dependencies, cli, project, mut lock) = fixture.paths();
    lock["packages"]["node_modules/vite"]["dependencies"]["rolldown"] = json!("1.0.0");
    assert_eq!(resolve_vite_backend_for_target(&root, &dependencies, &cli, &project, &lock, &fixture.target),
        Err(ResolveBackendError::LockMismatch));
}

#[test]
fn malformed_or_conflicting_vite_backend_roles_never_fall_back_to_rolldown() {
    for bad_esbuild in [json!(null), json!({"version":"0.0.0"}), json!(7), json!("")] {
        let fixture = RolldownFixture::new();
        let manifest_path = fixture.root.path().join("node_modules/vite/package.json");
        let mut vite: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        vite["dependencies"]["esbuild"] = bad_esbuild;
        fs::write(manifest_path, serde_json::to_vec(&vite).unwrap()).unwrap();
        assert_eq!(fixture.resolve(), Err(ResolveBackendError::LockMismatch));
    }

    let fixture = RolldownFixture::new();
    let manifest_path = fixture.root.path().join("node_modules/vite/package.json");
    let mut vite: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    vite["dependencies"] = json!([]);
    fs::write(manifest_path, serde_json::to_vec(&vite).unwrap()).unwrap();
    assert_eq!(fixture.resolve(), Err(ResolveBackendError::LockMismatch));

    let fixture = RolldownFixture::new();
    let manifest_path = fixture.root.path().join("node_modules/vite/package.json");
    let mut vite: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    vite["optionalDependencies"] = json!({"esbuild":"0.28.1"});
    fs::write(manifest_path, serde_json::to_vec(&vite).unwrap()).unwrap();
    assert_eq!(fixture.resolve(), Err(ResolveBackendError::LockMismatch));

    for lock_roles in [
        json!({"version":"8.0.13","dependencies":{"rolldown":"1.0.1","esbuild":"0.28.1"}}),
        json!({"version":"8.0.13","dependencies":{"rolldown":"2.0.0"}}),
        json!({"version":"8.0.13","dependencies":{"rolldown":{"version":"1.0.1"}}}),
        json!({"version":"8.0.13","dependencies":{"rolldown":""}}),
        json!({"version":"8.0.13","dependencies":null}),
        json!({"version":"8.0.13","dependencies":{"rolldown":"1.0.1"},"optionalDependencies":null}),
    ] {
        let fixture = RolldownFixture::new();
        let lock_path = fixture.root.path().join("package-lock.json");
        let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
        lock["packages"]["node_modules/vite"] = lock_roles;
        fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
        assert_eq!(fixture.resolve(), Err(ResolveBackendError::LockMismatch));
    }
}

#[test]
fn malformed_or_conflicting_optional_binding_roles_are_rejected() {
    let fixture = RolldownFixture::new();
    let manifest_path = fixture.root.path().join("node_modules/rolldown/package.json");
    let mut rolldown: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    rolldown["optionalDependencies"] = json!("invalid");
    fs::write(&manifest_path, serde_json::to_vec(&rolldown).unwrap()).unwrap();
    assert_eq!(fixture.resolve(), Err(ResolveBackendError::LockMismatch));

    let fixture = RolldownFixture::new();
    let lock_path = fixture.root.path().join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"]["node_modules/rolldown"]["optionalDependencies"] = json!([]);
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
    assert_eq!(fixture.resolve(), Err(ResolveBackendError::LockMismatch));

    let fixture = RolldownFixture::new();
    let manifest_path = fixture.root.path().join("node_modules/rolldown/package.json");
    let mut rolldown: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let name = format!("@rolldown/binding-{}-{}", fixture.target.os, fixture.target.cpu);
    rolldown["dependencies"] = json!({(name):"1.0.1"});
    fs::write(&manifest_path, serde_json::to_vec(&rolldown).unwrap()).unwrap();
    assert_eq!(fixture.resolve(), Err(ResolveBackendError::LockMismatch));
}

#[test]
fn unknown_dependency_roles_do_not_change_the_supported_backend_choice() {
    let fixture = RolldownFixture::new();
    let manifest_path = fixture.root.path().join("node_modules/vite/package.json");
    let mut vite: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    vite["dependencies"]["unrelated-builder"] = json!({"opaque":true});
    fs::write(&manifest_path, serde_json::to_vec(&vite).unwrap()).unwrap();
    let lock_path = fixture.root.path().join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"]["node_modules/vite"]["dependencies"]["unrelated-builder"] = json!(17);
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
    assert!(matches!(fixture.resolve(), Ok(ViteBuildBackend::Rolldown { .. })));
}
