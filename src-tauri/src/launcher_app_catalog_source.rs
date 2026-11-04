//! Source selection for launcher application catalog snapshots.

#[cfg(feature = "legacy-node-smoke")]
use crate::launcher_app_catalog::CatalogCache;
use crate::launcher_app_catalog::{self, LauncherApp};
#[cfg(feature = "legacy-node-smoke")]
use std::{env, fs, sync::Mutex};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};

#[allow(dead_code)]
pub(crate) fn linux_default_roots_from_env(home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
        PathBuf::from("/var/lib/snapd/desktop/applications"),
    ];
    if let Some(home_dir) = home {
        roots.push(home_dir.join(".local/share/applications"));
    }
    roots
}

#[allow(dead_code)]
pub(crate) fn windows_default_roots_from_env(
    program_data: Option<&Path>,
    app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for base in [program_data, app_data].into_iter().flatten() {
        roots.push(
            base.join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    roots
}

enum CatalogSource {
    System,
    #[cfg(feature = "legacy-node-smoke")]
    OwnedFixture {
        root: PathBuf,
        cache: Mutex<CatalogCache>,
    },
}

pub(crate) struct LauncherAppCatalogSource {
    source: CatalogSource,
}

impl Default for LauncherAppCatalogSource {
    fn default() -> Self {
        Self {
            source: CatalogSource::System,
        }
    }
}

impl LauncherAppCatalogSource {
    pub(crate) fn snapshot(&self) -> Result<Vec<LauncherApp>, String> {
        self.snapshot_at(Instant::now())
    }

    pub(crate) fn invalidate(&self) -> Result<(), String> {
        match &self.source {
            CatalogSource::System => launcher_app_catalog::invalidate_system_catalog(),
            #[cfg(feature = "legacy-node-smoke")]
            CatalogSource::OwnedFixture { cache, .. } => {
                cache
                    .lock()
                    .map_err(|_| "Launcher app fixture catalog cache lock poisoned".to_string())?
                    .invalidate();
                Ok(())
            }
        }
    }

    pub(crate) fn watch_roots(&self) -> Result<Vec<PathBuf>, String> {
        match &self.source {
            CatalogSource::System => launcher_app_catalog::default_roots(),
            #[cfg(feature = "legacy-node-smoke")]
            CatalogSource::OwnedFixture { root, .. } => Ok(vec![root.clone()]),
        }
    }

    fn snapshot_at(&self, _now: Instant) -> Result<Vec<LauncherApp>, String> {
        match &self.source {
            CatalogSource::System => launcher_app_catalog::snapshot_launcher_app_catalog(),
            #[cfg(feature = "legacy-node-smoke")]
            CatalogSource::OwnedFixture { root, cache } => cache
                .lock()
                .map_err(|_| "Launcher app fixture catalog cache lock poisoned".to_string())?
                .snapshot(std::slice::from_ref(root), _now),
        }
    }

    /// Confines a smoke fixture catalog to a real directory under a fixed canonical temp root.
    /// Callers must validate profile ownership separately; this constructor is not authorization.
    #[cfg(feature = "legacy-node-smoke")]
    pub(crate) fn from_owned_fixture_directory(root: &Path) -> Result<Self, String> {
        let root = validate_owned_fixture_directory(root)?;
        Ok(Self {
            source: CatalogSource::OwnedFixture {
                root,
                cache: Mutex::new(CatalogCache::default()),
            },
        })
    }
}

#[cfg(feature = "legacy-node-smoke")]
fn validate_owned_fixture_directory(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("Launcher app fixture root must be absolute".into());
    }
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Cannot inspect launcher app fixture root: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err("Launcher app fixture root must be a real directory".into());
    }

    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Cannot resolve launcher app fixture root: {error}"))?;
    if canonical_root.file_name().and_then(|name| name.to_str()) != Some("launcher-apps") {
        return Err("Launcher app fixture directory must be named launcher-apps".into());
    }
    let canonical_temp_dir = fs::canonicalize(env::temp_dir())
        .map_err(|error| format!("Cannot resolve temp_dir: {error}"))?;
    let under_temp_dir = is_nested_under(&canonical_root, &canonical_temp_dir);
    #[cfg(target_os = "macos")]
    let under_private_tmp = {
        let canonical_private_tmp = fs::canonicalize("/private/tmp")
            .map_err(|error| format!("Cannot resolve /private/tmp: {error}"))?;
        is_nested_under(&canonical_root, &canonical_private_tmp)
    };
    #[cfg(not(target_os = "macos"))]
    let under_private_tmp = false;
    if !under_temp_dir && !under_private_tmp {
        return Err(
            "Launcher app fixture root must be inside an allowed canonical temp root".into(),
        );
    }
    Ok(canonical_root)
}

#[cfg(feature = "legacy-node-smoke")]
fn is_nested_under(root: &Path, base: &Path) -> bool {
    root != base && root.starts_with(base)
}

#[cfg(all(test, feature = "legacy-node-smoke"))]
mod tests {
    use super::*;

    fn create_app(root: &Path, name: &str) -> PathBuf {
        let path = root.join(name);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn fixture_root(parent: &Path) -> PathBuf {
        let root = parent.join("launcher-apps");
        fs::create_dir(&root).unwrap();
        // Expected app paths must match the canonical root stored by the source.
        fs::canonicalize(root).unwrap()
    }

    fn paths(snapshot: &[LauncherApp]) -> Vec<String> {
        snapshot.iter().map(|app| app.path().to_owned()).collect()
    }

    #[test]
    fn default_source_keeps_the_fixed_system_catalog_source() {
        let source = LauncherAppCatalogSource::default();
        assert!(matches!(source.source, CatalogSource::System));
    }

    #[test]
    fn owned_sources_keep_independent_roots_and_cached_snapshots() {
        let temporary = tempfile::tempdir().unwrap();
        let first_root = fixture_root(temporary.path());
        let second_parent = temporary.path().join("second-profile");
        fs::create_dir(&second_parent).unwrap();
        let second_root = fixture_root(&second_parent);
        let first_app = create_app(&first_root, "First.app")
            .to_string_lossy()
            .into_owned();
        let second_app = create_app(&second_root, "Second.app")
            .to_string_lossy()
            .into_owned();
        let first = LauncherAppCatalogSource::from_owned_fixture_directory(&first_root).unwrap();
        let second = LauncherAppCatalogSource::from_owned_fixture_directory(&second_root).unwrap();

        assert_eq!(paths(&first.snapshot().unwrap()), [first_app.clone()]);
        assert_eq!(paths(&second.snapshot().unwrap()), [second_app.clone()]);
        create_app(&first_root, "Added.app");
        assert_eq!(paths(&first.snapshot().unwrap()), [first_app]);
        assert_eq!(paths(&second.snapshot().unwrap()), [second_app]);
    }

    #[test]
    fn invalidation_refreshes_only_the_selected_owned_source() {
        let temporary = tempfile::tempdir().unwrap();
        let first_root = fixture_root(temporary.path());
        let second_parent = temporary.path().join("other-profile");
        fs::create_dir(&second_parent).unwrap();
        let second_root = fixture_root(&second_parent);
        let first = LauncherAppCatalogSource::from_owned_fixture_directory(&first_root).unwrap();
        let second = LauncherAppCatalogSource::from_owned_fixture_directory(&second_root).unwrap();
        create_app(&first_root, "First.app");
        create_app(&second_root, "Second.app");

        assert_eq!(paths(&first.snapshot().unwrap()).len(), 1);
        assert_eq!(paths(&second.snapshot().unwrap()).len(), 1);
        assert_eq!(first.watch_roots().unwrap(), [first_root.clone()]);
        create_app(&first_root, "Added.app");
        assert_eq!(paths(&first.snapshot().unwrap()).len(), 1);

        first.invalidate().unwrap();
        let first_paths = paths(&first.snapshot().unwrap());
        assert_eq!(first_paths.len(), 2);
        assert!(first_paths.iter().any(|path| path.ends_with("Added.app")));
        assert_eq!(paths(&second.snapshot().unwrap()).len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_watch_roots_are_the_fixed_application_roots() {
        let roots = LauncherAppCatalogSource::default().watch_roots().unwrap();
        assert_eq!(roots.len(), 3);
        assert_eq!(roots[0], Path::new("/Applications"));
        assert_eq!(roots[1], Path::new("/System/Applications"));
        assert!(roots[2].ends_with("Applications"));
    }

    #[test]
    fn owned_source_cache_refreshes_after_the_shared_ttl_boundary() {
        let temporary = tempfile::tempdir().unwrap();
        let root = fixture_root(temporary.path());
        let first_app = create_app(&root, "First.app")
            .to_string_lossy()
            .into_owned();
        let source = LauncherAppCatalogSource::from_owned_fixture_directory(&root).unwrap();
        let started_at = Instant::now();

        assert_eq!(
            paths(&source.snapshot_at(started_at).unwrap()),
            [first_app.clone()]
        );
        create_app(&root, "Second.app");
        assert_eq!(
            paths(
                &source
                    .snapshot_at(started_at + launcher_app_catalog::CACHE_TTL)
                    .unwrap()
            ),
            [first_app]
        );
        assert_eq!(
            paths(
                &source
                    .snapshot_at(
                        started_at
                            + launcher_app_catalog::CACHE_TTL
                            + std::time::Duration::from_secs(1)
                    )
                    .unwrap()
            )
            .len(),
            2
        );
    }

    #[test]
    fn factory_rejects_relative_wrong_leaf_and_out_of_temp_roots() {
        assert!(
            LauncherAppCatalogSource::from_owned_fixture_directory(Path::new("launcher-apps"))
                .is_err()
        );

        let temporary = tempfile::tempdir().unwrap();
        let wrong_leaf = temporary.path().join("applications");
        fs::create_dir(&wrong_leaf).unwrap();
        assert!(LauncherAppCatalogSource::from_owned_fixture_directory(&wrong_leaf).is_err());

        let outside = tempfile::tempdir_in(env::current_dir().unwrap()).unwrap();
        let outside_root = fixture_root(outside.path());
        assert!(LauncherAppCatalogSource::from_owned_fixture_directory(&outside_root).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn factory_accepts_fixture_root_under_private_tmp() {
        let temporary = tempfile::tempdir_in("/private/tmp").unwrap();
        let root = fixture_root(temporary.path());
        assert!(LauncherAppCatalogSource::from_owned_fixture_directory(&root).is_ok());
    }

    #[test]
    fn factory_rejects_files_and_symlink_roots() {
        let temporary = tempfile::tempdir().unwrap();
        let file_root = temporary.path().join("launcher-apps");
        fs::write(&file_root, "not a directory").unwrap();
        assert!(LauncherAppCatalogSource::from_owned_fixture_directory(&file_root).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let target_parent = temporary.path().join("target");
            fs::create_dir(&target_parent).unwrap();
            let target = fixture_root(&target_parent);
            let link_parent = temporary.path().join("link");
            fs::create_dir(&link_parent).unwrap();
            let link = link_parent.join("launcher-apps");
            symlink(&target, &link).unwrap();
            assert!(LauncherAppCatalogSource::from_owned_fixture_directory(&link).is_err());
        }
    }
}
