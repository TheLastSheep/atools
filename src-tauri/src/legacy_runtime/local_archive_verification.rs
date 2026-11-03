//! Fixed original ZPX fixture verification. It never executes code or installs a package.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_FILE: usize = 1024 * 1024;
const MAX_FILES: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Witness {
    path: String,
    bytes: usize,
    sha256: String,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn canonical_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Archive fixture directory must be absolute".into());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        match part {
            Component::RootDir | Component::Normal(_) => current.push(part),
            _ => return Err("Unsafe fixture directory".into()),
        }
        let meta = fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("Fixture directory contains a link or non-directory".into());
        }
    }
    if fs::canonicalize(path).map_err(|e| e.to_string())? != path {
        return Err("Fixture directory is not canonical".into());
    }
    Ok(())
}

fn regular(path: &Path, cap: usize, private: bool) -> Result<Vec<u8>, String> {
    canonical_directory(path.parent().ok_or("Missing file parent")?)?;
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !before.is_file() || before.file_type().is_symlink() || before.len() > cap as u64 {
        return Err("Fixture file is not bounded and regular".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if private && before.permissions().mode() & 0o777 != 0o600 {
            return Err("Private fixture file must be mode 0600".into());
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != before.dev() || opened.ino() != before.ino() {
            return Err("Fixture file changed during open".into());
        }
    }
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > cap || bytes.len() as u64 != opened.len() {
        return Err("Fixture file exceeded its bounded read".into());
    }
    Ok(bytes)
}

fn private_directory(path: &Path) -> Result<(), String> {
    canonical_directory(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o777
            != 0o700
        {
            return Err("Private fixture directory must be mode 0700".into());
        }
    }
    Ok(())
}

fn valid_relative(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 1024
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.chars().any(char::is_control)
        && name.split('/').count() <= 8
        && name
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".." && !p.contains(':'))
}

fn scan(root: &Path, private: bool) -> Result<(Vec<Witness>, BTreeSet<String>), String> {
    fn walk(
        root: &Path,
        rel: &str,
        private: bool,
        files: &mut Vec<Witness>,
        dirs: &mut BTreeSet<String>,
    ) -> Result<(), String> {
        if rel.split('/').count() > 8 {
            return Err("Fixture directory depth exceeds budget".into());
        }
        for entry in fs::read_dir(root.join(rel)).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "Non-UTF8 fixture path")?;
            let name = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if !valid_relative(&name) {
                return Err("Unsafe fixture entry path".into());
            }
            let path = root.join(&name);
            let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                return Err("Fixture links are forbidden".into());
            }
            if meta.is_dir() {
                if dirs.len() >= MAX_FILES {
                    return Err("Too many fixture directories".into());
                }
                if private {
                    private_directory(&path)?;
                }
                dirs.insert(name.clone());
                walk(root, &name, private, files, dirs)?;
            } else {
                if files.len() >= MAX_FILES {
                    return Err("Too many fixture files".into());
                }
                let b = regular(&path, MAX_FILE, private)?;
                files.push(Witness {
                    path: name,
                    bytes: b.len(),
                    sha256: digest(&b),
                });
            }
        }
        Ok(())
    }
    canonical_directory(root)?;
    let mut files = Vec::new();
    let mut dirs = BTreeSet::new();
    walk(root, "", private, &mut files, &mut dirs)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((files, dirs))
}

fn registered(profile: &Value) -> Result<Value, String> {
    let registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-original-archive-cases.json"
    ))
    .map_err(|e| e.to_string())?;
    let id = profile["caseId"].as_str().ok_or("Missing archive case")?;
    let expected = registry["cases"]
        .as_array()
        .and_then(|cases| cases.iter().find(|p| p["caseId"] == id))
        .ok_or("Unknown original archive case")?;
    if profile != expected
        || profile["sourceKind"] != "local_original_archive"
        || profile["archiveExtension"] != "zpx"
    {
        return Err("Original archive profile mismatch".into());
    }
    Ok(registry["witnesses"][id].clone())
}

fn verify_tree(root: &Path, witness: &Value, private: bool) -> Result<Vec<Witness>, String> {
    let mut expected: Vec<Witness> =
        serde_json::from_value(witness["files"].clone()).map_err(|e| e.to_string())?;
    expected.sort_by(|a, b| a.path.cmp(&b.path));
    let expected_dirs: BTreeSet<String> =
        serde_json::from_value(witness["directories"].clone()).map_err(|e| e.to_string())?;
    let (actual, dirs) = scan(root, private)?;
    if actual != expected || dirs != expected_dirs {
        return Err(
            "Archive fixture directory differs from exact pinned files and directories".into(),
        );
    }
    Ok(actual)
}

pub(crate) fn verify_reviewed_archive(
    review: &Value,
    profile: &Value,
    root: &Path,
    expected_sha: &str,
) -> Result<Value, String> {
    let witness = registered(profile)?;
    let f = &review["fixture"];
    let owned = root.parent().ok_or("Fixture has no owner")?;
    if root.file_name().and_then(|s| s.to_str()) != Some("plugin")
        || !owned
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with("atools-published-plugin-fixture-"))
    {
        return Err("Original archive fixture ownership mismatch".into());
    }
    let temp = fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
    let private_tmp = fs::canonicalize("/private/tmp").ok();
    if !owned.starts_with(&temp)
        && !private_tmp
            .as_ref()
            .is_some_and(|tmp| owned.starts_with(tmp))
    {
        return Err("Original archive fixture is outside temporary roots".into());
    }
    private_directory(owned)?;
    private_directory(root)?;
    let archive = owned.join("source.zpx");
    let source_path = profile["sourcePath"]
        .as_str()
        .ok_or("Missing original source path")?;
    if !valid_relative(source_path) {
        return Err("Unsafe registered original archive path".into());
    }
    let repository = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .map_err(|e| e.to_string())?;
    // Preserve the lexical registered path: canonicalizing the source first would hide links.
    let original = repository.join(source_path);
    let field_path = |key: &str| {
        f[key]
            .as_str()
            .map(PathBuf::from)
            .ok_or_else(|| format!("Missing fixture {key}"))
    };
    if review["status"] != profile["sourceReviewStatus"]
        || f["sourceKind"] != profile["sourceKind"]
        || f["id"] != profile["id"]
        || f["version"] != profile["version"]
        || field_path("ownedRoot")? != owned
        || field_path("pluginRoot")? != root
        || field_path("archivePath")? != archive
        || field_path("packageImportPath")? != archive
        || field_path("originalSourcePath")? != original
        || profile["archiveSha256"] != expected_sha
        || f["archiveSha256"] != expected_sha
        || f["archiveBytes"] != profile["archiveBytes"]
    {
        return Err("Original archive review identity or import path mismatch".into());
    }
    for (path, private) in [(&archive, true), (&original, false)] {
        let bytes = regular(path, MAX_FILE, private)?;
        if bytes.len() as u64
            != profile["archiveBytes"]
                .as_u64()
                .ok_or("Missing archive size")?
            || digest(&bytes) != expected_sha
        {
            return Err("Original archive or retained copy changed".into());
        }
    }
    let files = verify_tree(root, &witness, true)?;
    let reviewed: Vec<Witness> =
        serde_json::from_value(f["files"].clone()).map_err(|e| e.to_string())?;
    if reviewed
        .into_iter()
        .map(|w| (w.path.clone(), w))
        .collect::<BTreeMap<_, _>>()
        != files.iter().cloned().map(|w| (w.path.clone(), w)).collect()
        || f["files"].as_array().map(Vec::len) != Some(files.len())
        || files.len() as u64
            != profile["fileCount"]
                .as_u64()
                .ok_or("Missing archive file count")?
    {
        return Err("Archive review file witness mismatch".into());
    }
    Ok(
        json!({"sourceBytesUnchanged":true,"unchangedFileCount":files.len(),"archiveSha256":expected_sha,"packageImportPath":archive,"sourceKind":"local_original_archive","noPluginCodeExecuted":true}),
    )
}

pub(crate) fn verify_installed(root: &Path, profile: &Value) -> Result<Value, String> {
    let files = verify_tree(root, &registered(profile)?, false)?;
    Ok(
        json!({"pluginId":profile["id"],"version":profile["version"],"fileCount":files.len(),"files":files,"exactPinnedFiles":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_file_rejects_links_and_oversize_without_plugin_code() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("ok"), b"fixed").unwrap();
        assert_eq!(regular(&root.join("ok"), 5, false).unwrap(), b"fixed");
        assert!(regular(&root.join("ok"), 4, false).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("ok"), root.join("link")).unwrap();
            assert!(regular(&root.join("link"), 5, false).is_err());
            fs::create_dir(root.join("real")).unwrap();
            fs::write(root.join("real/nested"), b"fixed").unwrap();
            std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
            assert!(regular(&root.join("alias/nested"), 5, false).is_err());
        }
    }
    #[test]
    fn exact_tree_rejects_missing_extra_and_changed_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("one"), b"1").unwrap();
        let w = json!({"files":[{"path":"one","bytes":1,"sha256":digest(b"1")}],"directories":[]});
        assert!(verify_tree(&root, &w, false).is_ok());
        fs::write(root.join("extra"), b"0").unwrap();
        assert!(verify_tree(&root, &w, false).is_err());
        fs::remove_file(root.join("extra")).unwrap();
        fs::write(root.join("one"), b"2").unwrap();
        assert!(verify_tree(&root, &w, false).is_err());
        fs::remove_file(root.join("one")).unwrap();
        assert!(verify_tree(&root, &w, false).is_err());
    }
    #[test]
    fn unregistered_or_modified_profile_cannot_select_an_archive() {
        assert!(registered(&json!({"caseId":"other"})).is_err());
        assert!(registered(
            &json!({"caseId":"local-my-calculator-zpx","sourceKind":"local_original_archive"})
        )
        .is_err());
    }
}
