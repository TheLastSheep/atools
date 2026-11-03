use std::{
    borrow::Cow,
    collections::BTreeMap,
    fs,
    fs::OpenOptions,
    io::Read,
    path::{Component, Path},
};

use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

const MAX_RUNTIME_FILES: usize = 64;
const MAX_RUNTIME_FILE_BYTES: u64 = 1024 * 1024;
const MAX_RUNTIME_TOTAL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 256;
const MAX_SCAN_DEPTH: usize = 8;
const MAX_SCAN_DIRECTORIES: usize = 64;

#[derive(Default)]
struct ScanBudget {
    entries: usize,
    directories: usize,
}

pub(super) struct RendererAssets {
    files: BTreeMap<String, Box<[u8]>>,
    javascript_count: usize,
    runtime_bytes: u64,
}

impl RendererAssets {
    pub(super) fn load(dist: &Path) -> Result<Self, String> {
        validate_absolute_dist(dist)?;
        let root_metadata = fs::symlink_metadata(dist)
            .map_err(|error| format!("cannot inspect renderer dist: {error}"))?;
        if root_metadata.file_type().is_symlink() {
            return Err("renderer dist must not be a symlink".to_string());
        }
        if !root_metadata.is_dir() {
            return Err("renderer dist must be a directory".to_string());
        }

        let root = fs::canonicalize(dist)
            .map_err(|error| format!("cannot resolve renderer dist: {error}"))?;
        let mut files = BTreeMap::new();
        let mut javascript_count = 0;
        let mut runtime_bytes = 0_u64;
        let mut scan_budget = ScanBudget::default();
        collect_runtime_assets(
            &root,
            &root,
            0,
            &mut scan_budget,
            &mut files,
            &mut javascript_count,
            &mut runtime_bytes,
        )?;

        if !files.contains_key("/index.html") {
            return Err("renderer dist must contain root index.html".to_string());
        }
        if javascript_count == 0 {
            return Err(
                "renderer dist must contain at least one assets JavaScript file".to_string(),
            );
        }

        Ok(Self {
            files,
            javascript_count,
            runtime_bytes,
        })
    }

    #[cfg(feature = "legacy-node-smoke")]
    pub(super) fn captured_files(&self) -> &BTreeMap<String, Box<[u8]>> {
        &self.files
    }

    pub(super) fn metrics(&self) -> serde_json::Value {
        serde_json::json!({
            "runtimeAssetCount": self.files.len(),
            "runtimeAssetBytes": self.runtime_bytes,
            "javascriptAssetCount": self.javascript_count,
        })
    }

    pub(super) fn add_fallback_settings(
        &mut self,
        root: &Path,
    ) -> Result<serde_json::Value, String> {
        let fallback = fallback_assets::load(root)?;
        let next_file_count = self
            .files
            .len()
            .checked_add(fallback.files.len())
            .ok_or_else(|| "renderer runtime file count overflow".to_string())?;
        if next_file_count > MAX_RUNTIME_FILES {
            return Err("fallback settings exceed the combined 64 runtime file limit".into());
        }
        if fallback
            .files
            .keys()
            .any(|key| self.files.contains_key(key))
        {
            return Err("fallback settings asset conflicts with an existing renderer asset".into());
        }
        let next_runtime_bytes = self
            .runtime_bytes
            .checked_add(fallback.runtime_bytes)
            .ok_or_else(|| "renderer runtime asset byte count overflow".to_string())?;
        if next_runtime_bytes > MAX_RUNTIME_TOTAL_BYTES {
            return Err("fallback settings exceed the combined 2 MiB runtime byte limit".into());
        }

        self.runtime_bytes = next_runtime_bytes;
        self.javascript_count += fallback.javascript_count;
        self.files.extend(fallback.files);
        Ok(fallback.summary)
    }

    #[cfg(feature = "ztools-multiwebview")]
    pub(super) fn add_multiwebview_probes(&mut self) -> Result<(), String> {
        let probes: [(&str, &[u8]); 2] = [
            (
                "/multiwebview-child.html",
                include_bytes!("multiwebview/multiwebview-child.html"),
            ),
            (
                "/multiwebview-child.js",
                include_bytes!("multiwebview/multiwebview-child.js"),
            ),
        ];
        for (key, bytes) in probes {
            if self.files.contains_key(key) || bytes.len() as u64 > MAX_RUNTIME_FILE_BYTES {
                return Err("Multiwebview probe asset conflicts with the original renderer".into());
            }
            self.runtime_bytes = self
                .runtime_bytes
                .checked_add(bytes.len() as u64)
                .ok_or("Multiwebview probe byte budget overflow")?;
            if self.runtime_bytes > MAX_RUNTIME_TOTAL_BYTES || self.files.len() >= MAX_RUNTIME_FILES
            {
                return Err("Multiwebview probe exceeds renderer asset budget".into());
            }
            if key.ends_with(".js") {
                self.javascript_count += 1;
            }
            self.files
                .insert(key.into(), bytes.to_vec().into_boxed_slice());
        }
        Ok(())
    }
}

#[path = "fallback_assets.rs"]
mod fallback_assets;

impl tauri::Assets<tauri::Wry> for RendererAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.files
            .get(key.as_ref())
            .map(|bytes| Cow::Borrowed(bytes.as_ref()))
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(
            self.files
                .iter()
                .map(|(path, bytes)| (Cow::Owned(path.clone()), Cow::Borrowed(bytes.as_ref()))),
        )
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

fn validate_absolute_dist(dist: &Path) -> Result<(), String> {
    if !dist.is_absolute() {
        return Err("renderer dist path must be absolute".to_string());
    }
    if dist
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("renderer dist path must not contain '..'".to_string());
    }
    Ok(())
}

fn collect_runtime_assets(
    root: &Path,
    directory: &Path,
    depth: usize,
    scan_budget: &mut ScanBudget,
    files: &mut BTreeMap<String, Box<[u8]>>,
    javascript_count: &mut usize,
    runtime_bytes: &mut u64,
) -> Result<(), String> {
    if depth > MAX_SCAN_DEPTH {
        return Err("renderer dist exceeds the 8 directory depth limit".to_string());
    }
    if scan_budget.directories >= MAX_SCAN_DIRECTORIES {
        return Err("renderer dist exceeds the 64 scanned directory limit".to_string());
    }
    scan_budget.directories += 1;

    let remaining_entries = MAX_SCAN_ENTRIES.saturating_sub(scan_budget.entries);
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("cannot read renderer dist directory: {error}"))?
        .take(remaining_entries.saturating_add(1))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot list renderer dist directory: {error}"))?;
    if entries.len() > remaining_entries {
        return Err("renderer dist exceeds the 256 total entry scan limit".to_string());
    }
    scan_budget.entries += entries.len();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot inspect renderer dist entry: {error}"))?;
        if file_type.is_symlink() {
            return Err("renderer dist must not contain symlinks".to_string());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "renderer asset escaped its dist root".to_string())?;
        let normalized = normalize_relative_asset_path(relative)?;

        if file_type.is_dir() {
            collect_runtime_assets(
                root,
                &path,
                depth + 1,
                scan_budget,
                files,
                javascript_count,
                runtime_bytes,
            )?;
            continue;
        }
        if !file_type.is_file() {
            return Err("renderer dist may contain only regular files and directories".to_string());
        }
        if !is_runtime_asset(&normalized) {
            continue;
        }

        let mut file = open_runtime_asset(&path)
            .map_err(|error| format!("cannot open renderer runtime asset: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("cannot inspect renderer runtime asset: {error}"))?;
        if !metadata.is_file() {
            return Err("renderer runtime asset must be a regular file".to_string());
        }
        if metadata.len() > MAX_RUNTIME_FILE_BYTES {
            return Err("renderer runtime asset exceeds the 1 MiB per-file limit".to_string());
        }
        if files.len() >= MAX_RUNTIME_FILES {
            return Err("renderer dist exceeds the 64 runtime file limit".to_string());
        }
        let next_total = runtime_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "renderer runtime asset byte count overflow".to_string())?;
        if next_total > MAX_RUNTIME_TOTAL_BYTES {
            return Err("renderer dist exceeds the 2 MiB runtime total limit".to_string());
        }

        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.by_ref()
            .take(MAX_RUNTIME_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read renderer runtime asset: {error}"))?;
        if bytes.len() as u64 > MAX_RUNTIME_FILE_BYTES || bytes.len() as u64 != metadata.len() {
            return Err("renderer runtime asset changed while loading".to_string());
        }

        if normalized.ends_with(".js") || normalized.ends_with(".mjs") {
            *javascript_count += 1;
        }
        *runtime_bytes = next_total;
        files.insert(format!("/{normalized}"), bytes.into_boxed_slice());
    }
    Ok(())
}

fn open_runtime_asset(path: &Path) -> std::io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn normalize_relative_asset_path(path: &Path) -> Result<String, String> {
    let mut normalized = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err("renderer asset path contains a traversal component".to_string());
        };
        let component = component
            .to_str()
            .ok_or_else(|| "renderer asset path must be valid UTF-8".to_string())?;
        if component.is_empty()
            || component == "."
            || component == ".."
            || !component
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err("renderer asset path contains an unsafe component".to_string());
        }
        normalized.push(component);
    }
    if normalized.is_empty() {
        return Err("renderer asset path is empty".to_string());
    }
    Ok(normalized.join("/"))
}

fn is_runtime_asset(path: &str) -> bool {
    if path == "index.html" {
        return true;
    }
    let Some(asset_path) = path.strip_prefix("assets/") else {
        return false;
    };
    if asset_path.is_empty() {
        return false;
    }
    let extension = Path::new(asset_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    matches!(
        extension,
        "js" | "mjs"
            | "css"
            | "png"
            | "svg"
            | "webp"
            | "jpg"
            | "jpeg"
            | "gif"
            | "ico"
            | "avif"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "eot"
            | "wasm"
    )
}

#[path = "assets_tests.rs"]
mod tests;
