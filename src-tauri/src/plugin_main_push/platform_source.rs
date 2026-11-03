//! Recover platform restrictions lost by older persisted manifest schemas.
//! One bounded metadata read per managed identity; never a new search index.
use atools_core::Plugin;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::OpenOptions,
    io::Read,
    path::Path,
    sync::{Arc, LazyLock, Mutex},
};
const MAX_SOURCE: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 128;
const MAX_BYTES: usize = 8 * 1024 * 1024;
#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    platform: Vec<String>,
    #[serde(default)]
    features: Vec<Feature>,
}
#[derive(Deserialize)]
struct Feature {
    code: String,
    #[serde(default)]
    platform: Vec<String>,
}
pub(super) struct Platforms {
    pub plugin: Vec<String>,
    pub features: HashMap<String, Vec<String>>,
    pub digest: String,
}
struct Entry {
    plugin: String,
    key: String,
    bytes: usize,
    value: Result<Arc<Platforms>, ()>,
}
static CACHE: LazyLock<Mutex<VecDeque<Entry>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
pub(super) fn current(plugin: &Plugin, key: &str) -> Result<Arc<Platforms>, String> {
    let mut cache = CACHE
        .lock()
        .map_err(|_| "ERR_MAIN_PUSH_PLATFORM_UNAVAILABLE")?;
    if let Some(entry) = cache.iter().find(|e| e.plugin == plugin.id && e.key == key) {
        return entry
            .value
            .clone()
            .map_err(|_| "ERR_MAIN_PUSH_PLATFORM_UNAVAILABLE".into());
    }
    let value = read(Path::new(&plugin.path));
    let bytes = value.as_ref().map_or(256, |(_, bytes)| *bytes + 512) + key.len() + plugin.id.len();
    if bytes > MAX_BYTES {
        return Err("ERR_MAIN_PUSH_PLATFORM_UNAVAILABLE".into());
    }
    let value = value
        .map(|(platforms, _)| Arc::new(platforms))
        .map_err(|_| ());
    while !cache.is_empty()
        && (cache.len() >= MAX_ENTRIES
            || cache.iter().map(|e| e.bytes).sum::<usize>() + bytes > MAX_BYTES)
    {
        cache.pop_front();
    }
    cache.push_back(Entry {
        plugin: plugin.id.clone(),
        key: key.into(),
        bytes,
        value: value.clone(),
    });
    value.map_err(|_| "ERR_MAIN_PUSH_PLATFORM_UNAVAILABLE".into())
}
pub(super) fn invalidate(plugin: Option<&str>) {
    if let Ok(mut cache) = CACHE.lock() {
        cache.retain(|e| plugin.is_some_and(|id| e.plugin != id));
    }
}
fn read(root: &Path) -> Result<(Platforms, usize), ()> {
    let root = root.canonicalize().map_err(|_| ())?;
    let path = root.join("plugin.json");
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE {
        return Err(());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(&path).map_err(|_| ())?;
    let metadata = file.metadata().map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_SOURCE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_SOURCE {
        return Err(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let after = std::fs::symlink_metadata(&path).map_err(|_| ())?;
        if !after.is_file() || after.dev() != metadata.dev() || after.ino() != metadata.ino() {
            return Err(());
        }
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let platform_bytes = |values: &[String]| {
        values
            .iter()
            .map(|s| s.len() + std::mem::size_of::<String>() + 64)
            .sum::<usize>()
    };
    let mut charge = bytes.len() + platform_bytes(&manifest.platform) + 256;
    let mut features = HashMap::new();
    for feature in manifest.features {
        charge += feature.code.len() + platform_bytes(&feature.platform) + 256;
        if features.insert(feature.code, feature.platform).is_some() {
            return Err(());
        }
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    // Conservative charge includes the parsed maps/strings and transient source.

    if charge > MAX_BYTES / 2 {
        return Err(());
    }
    Ok((
        Platforms {
            plugin: manifest.platform,
            features,
            digest,
        },
        charge,
    ))
}
