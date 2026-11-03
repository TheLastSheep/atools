//! Resolve an existing Node executable without a shell, downloads, or idle work.
//! GUI launch environments often omit Homebrew and nvm from PATH.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::SidecarError;

struct Search {
    explicit: Option<OsString>,
    path: Option<OsString>,
    executable: Option<PathBuf>,
    home: Option<PathBuf>,
    system: Vec<PathBuf>,
}

pub(crate) fn resolve_node_binary() -> Result<PathBuf, SidecarError> {
    let mut system = Vec::new();
    #[cfg(target_os = "macos")]
    system.extend(["/opt/homebrew/bin/node", "/usr/local/bin/node"].map(PathBuf::from));
    #[cfg(all(unix, not(target_os = "macos")))]
    system.extend(["/usr/local/bin/node", "/usr/bin/node"].map(PathBuf::from));
    #[cfg(windows)]
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(key) {
            system.push(PathBuf::from(root).join("nodejs/node.exe"));
        }
    }
    resolve(&Search {
        explicit: std::env::var_os("ATOOLS_NODE_BINARY"),
        path: std::env::var_os("PATH"),
        executable: std::env::current_exe().ok(),
        home: dirs::home_dir(),
        system,
    })
}

/// Resolve only the explicit override once; compressed-runtime selection uses
/// this before choosing its strict app-bundled provider.
pub(crate) fn resolve_explicit_node_binary() -> Result<Option<PathBuf>, SidecarError> {
    let explicit = std::env::var_os("ATOOLS_NODE_BINARY");
    let Some(value) = explicit.as_ref() else {
        return Ok(None);
    };
    let candidate = resolve_explicit_value(value, std::env::var_os("PATH").as_deref())?;
    candidate.map(Some).ok_or_else(|| SidecarError::Spawn(
        "ATOOLS_NODE_BINARY must name an existing executable (use an absolute path); no fallback was used".into()))
}

fn resolve(search: &Search) -> Result<PathBuf, SidecarError> {
    if let Some(value) = &search.explicit {
        return resolve_explicit_value(value, search.path.as_deref())?
            .ok_or_else(|| SidecarError::Spawn("ATOOLS_NODE_BINARY must name an existing executable (use an absolute path); no fallback was used".into()));
    }
    // Only executable-relative packaged locations, never the plugin working directory.
    if let Some(parent) = search.executable.as_deref().and_then(Path::parent) {
        let name = node_name();
        if let Some(found) = usable(&parent.join(name)) {
            return Ok(found);
        }
        for root in [
            parent.join("runtime"),
            parent.join("../Resources/runtime"),
            parent.join("../Resources/node/bin"),
        ] {
            for candidate in [root.join(name), root.join("node/bin").join(name)] {
                if let Some(found) = usable(&candidate) {
                    return Ok(found);
                }
            }
        }
    }
    if let Some(found) = from_path(search.path.as_deref(), std::ffi::OsStr::new(node_name())) {
        return Ok(found);
    }
    if let Some(home) = &search.home {
        // Honour nvm's configured default, rather than guessing the newest ABI.
        if let Some(found) = nvm_default(&home.join(".nvm")) {
            return Ok(found);
        }
        for relative in [".volta/bin", ".local/bin"] {
            if let Some(found) = usable(&home.join(relative).join(node_name())) {
                return Ok(found);
            }
        }
    }
    for candidate in &search.system {
        if let Some(found) = usable(candidate) {
            return Ok(found);
        }
    }
    Err(SidecarError::Spawn("Node.js runtime not found. Install Node.js or configure ATOOLS_NODE_BINARY with its absolute executable path; core tools remain available without Node.js".into()))
}

fn resolve_explicit_value(
    value: &std::ffi::OsStr,
    path: Option<&std::ffi::OsStr>,
) -> Result<Option<PathBuf>, SidecarError> {
    let requested = Path::new(value);
    let candidate = if requested.is_absolute() {
        usable(requested)
    } else if requested.components().count() == 1 {
        from_path(path, value)
    } else {
        None
    };
    Ok(candidate)
}

fn node_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn usable(path: &Path) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    let metadata = canonical.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(canonical)
}

fn from_path(path: Option<&std::ffi::OsStr>, name: &std::ffi::OsStr) -> Option<PathBuf> {
    let path = path?;
    // A relative PATH entry could resolve to an untrusted plugin-local executable.
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .find_map(|dir| usable(&dir.join(name)))
}

fn nvm_default(root: &Path) -> Option<PathBuf> {
    let mut alias = "default".to_string();
    let mut version = None;
    for _ in 0..4 {
        // nvm aliases are small text files; reject traversal and bound reads.
        if alias
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return None;
        }
        let file = root.join("alias").join(&alias);
        let value = read_alias(&file)?;
        let numeric = value.trim_start_matches('v');
        let pieces: Vec<_> = numeric.split('.').collect();
        if (1..=3).contains(&pieces.len())
            && pieces
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        {
            version = Some(
                pieces
                    .iter()
                    .map(|part| part.parse::<u64>())
                    .collect::<Result<Vec<_>, _>>()
                    .ok()?,
            );
            break;
        }
        if !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_/.*".contains(c))
        {
            return None;
        }
        alias = value;
    }
    let prefix = version?;
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(root.join("versions/node"))
        .ok()?
        .take(128)
        .flatten()
    {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(value) = name.strip_prefix('v') else {
            continue;
        };
        let Ok(numbers) = value
            .split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
        else {
            continue;
        };
        if numbers.len() == 3 && numbers.starts_with(&prefix) {
            candidates.push((numbers, entry.path().join("bin").join(node_name())));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.into_iter().find_map(|(_, path)| usable(&path))
}

fn read_alias(path: &Path) -> Option<String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > 128 {
        return None;
    }
    let mut data = String::new();
    file.take(129).read_to_string(&mut data).ok()?;
    (data.len() <= 128).then(|| data.trim().to_string())
}

#[cfg(test)]
#[path = "node_runtime_tests.rs"]
mod tests;
