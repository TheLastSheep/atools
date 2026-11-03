//! Test-only, bounded full-install identity: database record, code revision and every file.
use atools_core::{Database, Plugin};
use atools_plugin::package_resolution::resolve_plugin_package;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

pub(super) fn installed_identity(db: &Database, plugin: &Plugin) -> Result<String, String> {
    let mut hash = Sha256::new();
    let metadata = serde_json::to_vec(plugin).map_err(|error| error.to_string())?;
    hash.update((metadata.len() as u64).to_le_bytes());
    hash.update(metadata);
    let revision = crate::plugin_code_revision::current(db, &plugin.id)?.unwrap_or_default();
    hash.update((revision.len() as u64).to_le_bytes());
    hash.update(revision.as_bytes());
    let mut entries = 0;
    let mut bytes = 0;
    walk(
        Path::new(&plugin.path),
        Path::new(""),
        0,
        &mut entries,
        &mut bytes,
        &mut hash,
    )?;
    Ok(format!("{:x}", hash.finalize()))
}

fn walk(
    root: &Path,
    relative: &Path,
    depth: usize,
    entries: &mut usize,
    bytes: &mut u64,
    hash: &mut Sha256,
) -> Result<(), String> {
    if depth > 16 {
        return Err("Fixture installation depth exceeded".into());
    }
    let children = fs::read_dir(root.join(relative)).map_err(|error| error.to_string())?;
    let mut names = Vec::new();
    for child in children {
        *entries += 1;
        if *entries > 4096 {
            return Err("Fixture installation entry budget exceeded".into());
        }
        names.push(child.map_err(|error| error.to_string())?.file_name());
    }
    names.sort();
    for name in names {
        let child = relative.join(name);
        let meta = fs::symlink_metadata(root.join(&child)).map_err(|error| error.to_string())?;
        let path = child.to_str().ok_or("Fixture installation path encoding")?;
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path.as_bytes());
        if meta.file_type().is_symlink() {
            return Err("Fixture installation contains a symlink".into());
        }
        if meta.is_dir() {
            hash.update(b"directory");
            walk(root, &child, depth + 1, entries, bytes, hash)?;
        } else if meta.is_file() {
            if meta.len() > 32 * 1024 * 1024 {
                return Err("Fixture installation file budget exceeded".into());
            }
            let mut contents = Vec::new();
            fs::File::open(root.join(&child))
                .map_err(|error| error.to_string())?
                .take(32 * 1024 * 1024 + 1)
                .read_to_end(&mut contents)
                .map_err(|error| error.to_string())?;
            *bytes += contents.len() as u64;
            if contents.len() > 32 * 1024 * 1024 || *bytes > 128 * 1024 * 1024 {
                return Err("Fixture installation byte budget exceeded".into());
            }
            hash.update(b"file");
            hash.update((contents.len() as u64).to_le_bytes());
            hash.update(contents);
        } else {
            return Err("Fixture installation contains a special file".into());
        }
    }
    Ok(())
}
pub(super) struct InstalledEntryObservation {
    pub readiness: String,
    pub main: Option<String>,
    pub manifest_at_package_root: bool,
}

/// Resolve the installed DB path through the production package resolver and
/// expose only the fixed readiness projection needed by the native smoke.
pub(super) fn installed_entry_observation(
    plugin: &Plugin,
) -> Result<InstalledEntryObservation, String> {
    let root = Path::new(&plugin.path);
    let canonical_root =
        fs::canonicalize(root).map_err(|_| "Installed package root unavailable")?;
    let package = resolve_plugin_package(&canonical_root)
        .map_err(|_| "Installed package resolution failed")?;
    if package.package_root != canonical_root {
        return Err("Installed package root changed during resolution".into());
    }
    Ok(InstalledEntryObservation {
        readiness: package.readiness.as_str().to_owned(),
        main: package.manifest.main,
        manifest_at_package_root: package.manifest_path == canonical_root.join("plugin.json"),
    })
}
