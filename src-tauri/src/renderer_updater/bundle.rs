//! Updater-only source role. Existing Main and Settings readers remain unchanged.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Component, Path},
    sync::Arc,
};
const EXPECTED: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../dist-ztools-updater/build-provenance.json"
));
const EXPECTED_MANIFEST: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../dist-ztools-updater/source-manifest.json"
));
const METADATA: &[&str] = &[
    "build-provenance.json",
    "source-manifest.json",
    "ZTools-LICENSE",
    "upstream-package.json",
];
pub(super) struct Bundle {
    pub assets: HashMap<String, (Arc<[u8]>, String)>,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut f = options
        .open(path)
        .map_err(|_| "Updater resource unavailable")?;
    let m = f.metadata().map_err(|_| "Updater resource unavailable")?;
    if !m.is_file() || m.len() > max as u64 {
        return Err("Updater resource invalid".into());
    }
    let mut bytes = Vec::with_capacity(m.len() as usize);
    f.by_ref()
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Updater resource unavailable")?;
    if bytes.len() > max
        || f.metadata()
            .map_err(|_| "Updater resource unavailable")?
            .modified()
            .ok()
            != m.modified().ok()
    {
        return Err("Updater resource changed".into());
    }
    Ok(bytes)
}
impl Bundle {
    pub fn load(root: &Path) -> Result<Self, String> {
        if fs::symlink_metadata(root)
            .map_err(|_| "Updater bundle missing")?
            .file_type()
            .is_symlink()
        {
            return Err("Updater bundle symlink rejected".into());
        }
        let root = fs::canonicalize(root).map_err(|_| "Updater bundle missing")?;
        let bytes = read(&root.join("build-provenance.json"), 256 * 1024)?;
        if bytes != EXPECTED
            || read(&root.join("source-manifest.json"), 256 * 1024)? != EXPECTED_MANIFEST
        {
            return Err("Updater build source mismatch".into());
        }
        let p: Value = serde_json::from_slice(&bytes).map_err(|_| "Updater provenance invalid")?;
        if p["schemaVersion"] != 1
            || p["owner"] != "atools"
            || p["role"] != "original-updater"
            || p["sourceCommit"] != "9b15fb1a2a9f3ec886016632761c7bb21e39557a"
            || p["sourceFiles"] != 10
        {
            return Err("Updater source role mismatch".into());
        }
        let budget = &p["budget"];
        if budget["milestone"] != "original-vue-updater-2026-11-02" || budget["passed"] != true {
            return Err("Updater budget role mismatch".into());
        }
        for (key, baseline, max) in [
            ("javascript", 104330, 120714),
            ("resources", 284598, 300982),
        ] {
            if budget[key]["baselineBytes"] != baseline
                || budget[key]["maxIncreaseBytes"] != 16384
                || budget[key]["maxBytes"] != max
            {
                return Err("Updater frozen budget mismatch".into());
            }
        }
        let resources = p["bundle"]["resources"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 64)
            .ok_or("Updater resource list invalid")?;
        let mut assets = HashMap::new();
        let mut total = 0usize;
        let mut js = 0usize;
        let mut paths = HashSet::new();
        for r in resources {
            let o = r
                .as_object()
                .filter(|o| o.len() == 4)
                .ok_or("Updater resource shape invalid")?;
            let path = o
                .get("path")
                .and_then(Value::as_str)
                .ok_or("Updater path invalid")?;
            if path.len() > 512
                || path.contains('\\')
                || Path::new(path)
                    .components()
                    .any(|p| !matches!(p, Component::Normal(_)))
                || !paths.insert(path.to_string())
            {
                return Err("Updater path rejected".into());
            }
            let size = o
                .get("bytes")
                .and_then(Value::as_u64)
                .filter(|n| *n <= 300982)
                .ok_or("Updater size invalid")? as usize;
            let mime = o
                .get("mime")
                .and_then(Value::as_str)
                .ok_or("Updater MIME invalid")?;
            let extension = Path::new(path)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("");
            if !matches!(
                (extension, mime),
                ("html", "text/html")
                    | ("js", "text/javascript")
                    | ("css", "text/css")
                    | ("png", "image/png")
            ) {
                return Err("Updater MIME rejected".into());
            }
            let bytes = read(&root.join(path), size)?;
            if bytes.len() != size
                || Some(hash(&bytes).as_str()) != o.get("sha256").and_then(Value::as_str)
            {
                return Err("Updater asset hash mismatch".into());
            }
            total = total.checked_add(size).ok_or("Updater size overflow")?;
            if extension == "js" {
                js += size;
            }
            assets.insert(path.to_string(), (Arc::from(bytes), mime.to_string()));
        }
        if !assets.contains_key("updater.html")
            || total > 300982
            || js > 120714
            || p["bundle"]["totalJavaScriptBytes"] != js
            || p["bundle"]["totalResourceBytes"] != total
        {
            return Err("Updater exact totals invalid".into());
        }
        let mut observed = HashSet::new();
        tree(&root, &root, &mut observed, 0)?;
        for path in observed {
            if !paths.contains(&path) && !METADATA.contains(&path.as_str()) {
                return Err("Unknown updater resource".into());
            }
        }
        Ok(Self { assets })
    }
}
fn tree(root: &Path, path: &Path, files: &mut HashSet<String>, depth: usize) -> Result<(), String> {
    if depth > 8 || files.len() > 128 {
        return Err("Updater tree limit".into());
    }
    for e in fs::read_dir(path).map_err(|_| "Updater tree unavailable")? {
        let e = e.map_err(|_| "Updater tree unavailable")?;
        let t = e.file_type().map_err(|_| "Updater tree unavailable")?;
        if t.is_symlink() {
            return Err("Updater symlink rejected".into());
        }
        if t.is_dir() {
            tree(root, &e.path(), files, depth + 1)?
        } else if t.is_file() {
            files.insert(
                e.path()
                    .strip_prefix(root)
                    .map_err(|_| "Updater path escaped")?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        } else {
            return Err("Updater resource rejected".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "bundle_tests.rs"]
mod tests;
