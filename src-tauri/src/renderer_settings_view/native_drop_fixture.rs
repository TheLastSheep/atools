//! Smoke-only, owned-path injection into the actual Child's DropBinding.
use std::{fs, sync::Mutex};

use crate::renderer_desktop_smoke::profile::Profile;

use super::{binding::DropBinding, *};

const OWNED_ROLES: [(&str, bool); 4] = [
    ("launcher-apps/AToolsOwnedProbeFirst.app", true),
    ("launcher-apps/AToolsOwnedProbeSecond.app", true),
    ("settings-registration/owned-file.txt", false),
    ("settings-registration/owned-folder", true),
];

struct LatestBinding<T>(Mutex<Weak<T>>);

impl<T> Default for LatestBinding<T> {
    fn default() -> Self {
        Self(Mutex::new(Weak::new()))
    }
}

impl<T> LatestBinding<T> {
    fn replace(&self, binding: &Arc<T>) -> Result<(), String> {
        *self
            .0
            .lock()
            .map_err(|_| "Settings drop binding lock failed")? = Arc::downgrade(binding);
        Ok(())
    }

    fn current(&self) -> Result<Arc<T>, String> {
        self.0
            .lock()
            .map_err(|_| "Settings drop binding lock failed")?
            .upgrade()
            .ok_or_else(|| "Settings drop binding has expired".into())
    }
}

pub(in crate::renderer_settings_view) fn install_fixture_registry(
    app: &AppHandle<Wry>,
) -> Result<(), String> {
    if !app.manage(LatestBinding::<DropBinding>::default()) {
        return Err("Settings drop fixture registry is already installed".into());
    }
    Ok(())
}

pub(super) fn register_binding(
    app: &AppHandle<Wry>,
    binding: &Arc<DropBinding>,
) -> Result<(), String> {
    if let Some(registry) = app.try_state::<LatestBinding<DropBinding>>() {
        registry.replace(binding)?;
    }
    Ok(())
}

/// Availability of the live registered binding, not a claim about object deallocation.
pub(crate) fn fixture_binding_active(app: &AppHandle<Wry>) -> bool {
    app.try_state::<LatestBinding<DropBinding>>()
        .and_then(|registry| registry.current().ok())
        .is_some_and(|binding| binding.is_current())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FixtureDropCompletion {
    pub(crate) added: u64,
    pub(crate) failed: u64,
    /// Queue acceptance is not evidence of delivery, DOM refresh or paint.
    pub(crate) result_notice_enqueued: bool,
}

pub(crate) struct FixtureDropReceipt {
    pub(crate) session_id: String,
    pub(crate) child_label: String,
    pub(crate) bundle_revision: String,
    pub(crate) binding_nonce: String,
    pub(crate) batch_nonce: String,
    completed: oneshot::Receiver<DropCompletion>,
}

impl FixtureDropReceipt {
    /// Resolves after the shared Rust batch and its single-flight guard finish.
    pub(crate) async fn completion(self) -> Result<FixtureDropCompletion, String> {
        let completion = self
            .completed
            .await
            .map_err(|_| "Settings fixture drop batch was cancelled".to_owned())?;
        Ok(FixtureDropCompletion {
            added: completion.counts.added,
            failed: completion.counts.failed,
            result_notice_enqueued: completion.result_notice_enqueued,
        })
    }
}

/// Rust-injected DragDropEvent only; callers must report physicalOsDrop=false.
pub(crate) fn inject_owned_fixture_drop(
    app: &AppHandle<Wry>,
    profile: &Profile,
    child_label: &str,
    paths: &[PathBuf],
) -> Result<FixtureDropReceipt, String> {
    super::super::presentation::authorize_launch_return_fixture(app, profile)?;
    validate_owned_paths(&profile.root, paths)?;
    let registry = app
        .try_state::<LatestBinding<DropBinding>>()
        .ok_or_else(|| "Settings drop fixture registry is missing".to_owned())?;
    let binding = registry.current()?;
    let identity = binding.identity();
    if identity.label != child_label || !binding.is_current() {
        return Err("Settings fixture drop target is stale or unauthorized".into());
    }
    let position = tauri::PhysicalPosition::new(0.0, 0.0);
    let _ = binding.handle_event(&DragDropEvent::Enter {
        paths: paths.to_vec(),
        position,
    });
    let dispatch = binding.handle_event(&DragDropEvent::Drop {
        paths: paths.to_vec(),
        position,
    });
    let Some(DropDispatch::Started {
        batch_nonce,
        completion,
    }) = dispatch
    else {
        return Err("Settings fixture drop batch was not started".into());
    };
    Ok(FixtureDropReceipt {
        session_id: identity.session_id.clone(),
        child_label: identity.label.clone(),
        bundle_revision: identity.bundle_revision.clone(),
        binding_nonce: binding.binding_nonce.clone(),
        batch_nonce,
        completed: completion,
    })
}

fn validate_owned_paths(root: &Path, paths: &[PathBuf]) -> Result<(), String> {
    let invalid = || "Settings fixture drop path is not an exact owned role".to_owned();
    validate_paths(paths).map_err(|_| invalid())?;
    let root_metadata = fs::symlink_metadata(root).map_err(|_| invalid())?;
    if !root_metadata.file_type().is_dir()
        || !owned_by_current_user(&root_metadata)
        || !is_private_root(&root_metadata)
        || fs::canonicalize(root).map_err(|_| invalid())?.as_os_str() != root.as_os_str()
    {
        return Err(invalid());
    }
    for path in paths {
        let directory = OWNED_ROLES
            .iter()
            .find_map(|(role, directory)| {
                (root.join(role).as_os_str() == path.as_os_str()).then_some(*directory)
            })
            .ok_or_else(invalid)?;
        let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
        if !owned_by_current_user(&metadata)
            || (if directory {
                !metadata.file_type().is_dir()
            } else {
                !metadata.file_type().is_file() || !is_single_link(&metadata)
            })
            || fs::canonicalize(path).map_err(|_| invalid())?.as_os_str() != path.as_os_str()
            || !path.starts_with(root)
        {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn owned_by_current_user(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.uid() == unsafe { libc::geteuid() }
}

#[cfg(unix)]
fn is_private_root(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o777 == 0o700
}

#[cfg(unix)]
fn is_single_link(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() == 1
}

#[cfg(not(unix))]
fn owned_by_current_user(_: &fs::Metadata) -> bool {
    false
}

#[cfg(not(unix))]
fn is_private_root(_: &fs::Metadata) -> bool {
    false
}

#[cfg(not(unix))]
fn is_single_link(_: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
#[path = "native_drop_fixture_tests.rs"]
mod tests;
