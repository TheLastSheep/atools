use std::{
    env,
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Write},
    net::{IpAddr, SocketAddr},
    path::{Component, Path, PathBuf},
    str::FromStr,
};

use rand::{rngs::OsRng, RngCore};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("only DB_DRIVER=sqlite is supported by this private service")]
    UnsupportedDatabase,
    #[error("ZTOOLS_USERNAME and ZTOOLS_PASSWORD must be configured together")]
    IncompleteBootstrap,
    #[error("invalid PORT: {0}")]
    InvalidPort(String),
    #[error("invalid ALLOW_REGISTRATION value: {0}")]
    InvalidRegistrationFlag(String),
    #[error("invalid BIND_ADDRESS: {0}")]
    InvalidBindAddress(String),
    #[error("JWT_SECRET must contain at least 32 bytes")]
    WeakSecret,
    #[error("database path may not point at the desktop ATools database")]
    DesktopDatabasePath,
    #[error("sync data directory may not be inside the desktop ATools data tree")]
    DesktopDataDirectory,
    #[error("failed to prepare private sync data directory: {0}")]
    DataDirectory(#[source] io::Error),
    #[error("failed to load or create the private JWT secret: {0}")]
    Secret(#[source] io::Error),
}

#[derive(Clone)]
pub struct BootstrapUser {
    pub uid: String,
    pub password: String,
}

#[derive(Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub jwt_secret: Vec<u8>,
    pub bootstrap_user: Option<BootstrapUser>,
    pub allow_registration: bool,
    pub listen_address: SocketAddr,
}

impl Config {
    /// Loads standalone defaults while keeping the sync DB outside the desktop
    /// database tree. `DB_DRIVER=mysql` is rejected rather than silently
    /// opening or migrating some other store.
    pub fn from_env() -> Result<Self, ConfigError> {
        let driver = env::var("DB_DRIVER").unwrap_or_default();
        if !driver.is_empty() && driver.to_ascii_lowercase() != "sqlite" {
            return Err(ConfigError::UnsupportedDatabase);
        }
        let data_dir = env::var_os("DATA_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("data/standalone"));
        if is_inside_desktop_data_tree(&data_dir) {
            return Err(ConfigError::DesktopDataDirectory);
        }
        ensure_private_directory(&data_dir).map_err(ConfigError::DataDirectory)?;

        let database_path = env::var_os("SQLITE_PATH")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("ztools.db"));
        if is_known_desktop_database(&database_path) {
            return Err(ConfigError::DesktopDatabasePath);
        }
        let jwt_secret = match env::var("JWT_SECRET") {
            Ok(value) if !value.trim().is_empty() => value.trim().as_bytes().to_vec(),
            _ => load_or_create_secret(&data_dir.join("server-secret"))?,
        };
        if jwt_secret.len() < 32 {
            return Err(ConfigError::WeakSecret);
        }

        let username = env::var("ZTOOLS_USERNAME")
            .unwrap_or_default()
            .trim()
            .to_owned();
        let password = env::var("ZTOOLS_PASSWORD").unwrap_or_default();
        let bootstrap_user = match (username.is_empty(), password.is_empty()) {
            (true, true) => None,
            (false, false) => Some(BootstrapUser {
                uid: username,
                password,
            }),
            _ => return Err(ConfigError::IncompleteBootstrap),
        };
        let allow_registration = env_bool("ALLOW_REGISTRATION", false)?;
        let port = env::var("PORT")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "23517".into())
            .parse::<u16>()
            .map_err(|_| ConfigError::InvalidPort("expected 1..65535".into()))?;
        if port == 0 {
            return Err(ConfigError::InvalidPort("expected 1..65535".into()));
        }
        let ip = env::var("BIND_ADDRESS")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "0.0.0.0".into());
        let ip = IpAddr::from_str(&ip).map_err(|_| ConfigError::InvalidBindAddress(ip))?;

        Ok(Self {
            data_dir,
            database_path,
            jwt_secret,
            bootstrap_user,
            allow_registration,
            listen_address: SocketAddr::new(ip, port),
        })
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.jwt_secret.len() < 32 {
            return Err(ConfigError::WeakSecret);
        }
        if is_known_desktop_database(&self.database_path) {
            return Err(ConfigError::DesktopDatabasePath);
        }
        if is_inside_desktop_data_tree(&self.data_dir) {
            return Err(ConfigError::DesktopDataDirectory);
        }
        if self
            .bootstrap_user
            .as_ref()
            .is_some_and(|user| user.uid.is_empty() || user.password.is_empty())
        {
            return Err(ConfigError::IncompleteBootstrap);
        }
        Ok(())
    }
}

pub(crate) fn ensure_private_directory(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.recursive(true).create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
        Err(error) => Err(error),
    }
}

fn env_bool(key: &str, fallback: bool) -> Result<bool, ConfigError> {
    match env::var(key) {
        Err(_) => Ok(fallback),
        Ok(value) if value.is_empty() => Ok(fallback),
        Ok(value) => parse_bool_value(&value).ok_or(ConfigError::InvalidRegistrationFlag(value)),
    }
}

fn parse_bool_value(value: &str) -> Option<bool> {
    match value {
        "1" | "t" | "T" | "true" | "TRUE" | "True" => Some(true),
        "0" | "f" | "F" | "false" | "FALSE" | "False" => Some(false),
        _ => None,
    }
}

fn load_or_create_secret(path: &Path) -> Result<Vec<u8>, ConfigError> {
    match fs::read(path) {
        Ok(secret) => {
            let secret = String::from_utf8_lossy(&secret).trim().as_bytes().to_vec();
            if secret.len() < 32 {
                return Err(ConfigError::WeakSecret);
            }
            return Ok(secret);
        }
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            return Err(ConfigError::Secret(error));
        }
        Err(_) => {}
    }

    let mut bytes = [0_u8; 32];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| ConfigError::Secret(io::Error::other("random generator failed")))?;
    let value = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(value.as_bytes())
                .map_err(ConfigError::Secret)?;
            file.write_all(b"\n").map_err(ConfigError::Secret)?;
            Ok(value.into_bytes())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => load_or_create_secret(path),
        Err(error) => Err(ConfigError::Secret(error)),
    }
}

fn is_known_desktop_database(path: &Path) -> bool {
    is_inside_desktop_data_tree(path)
}

pub(crate) fn is_inside_desktop_data_tree(path: &Path) -> bool {
    let Some(home) = env::var_os("HOME") else {
        return false;
    };
    let home = PathBuf::from(home);
    let Ok(cwd) = env::current_dir() else {
        return true;
    };
    path_is_within(path, &home.join(".atools"), &cwd, Some(&home)).unwrap_or(true)
}

fn path_is_within(path: &Path, root: &Path, cwd: &Path, home: Option<&Path>) -> io::Result<bool> {
    Ok(resolve_path(path, cwd, home)?.starts_with(resolve_path(root, cwd, home)?))
}

fn resolve_path(path: &Path, cwd: &Path, home: Option<&Path>) -> io::Result<PathBuf> {
    let expanded = expand_home(path, home);
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    };
    let mut resolved = PathBuf::new();
    let mut missing = Vec::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::CurDir => {
                resolved.push(component.as_os_str());
            }
            Component::ParentDir => {
                if missing.pop().is_none() && resolved.file_name().is_some() {
                    resolved.pop();
                }
            }
            Component::Normal(name) => {
                missing.push(name.to_os_string());
                let candidate = append_components(&resolved, &missing);
                match candidate.canonicalize() {
                    Ok(canonical) => {
                        resolved = canonical;
                        missing.clear();
                    }
                    Err(error) => match std::fs::symlink_metadata(&candidate) {
                        Ok(_) => return Err(error),
                        Err(metadata_error) if metadata_error.kind() == io::ErrorKind::NotFound => {
                        }
                        Err(metadata_error) => return Err(metadata_error),
                    },
                }
            }
        }
    }
    Ok(append_components(&resolved, &missing))
}

fn append_components(base: &Path, components: &[std::ffi::OsString]) -> PathBuf {
    let mut result = base.to_path_buf();
    for component in components {
        result.push(component);
    }
    result
}

fn expand_home(path: &Path, home: Option<&Path>) -> PathBuf {
    let Some(home) = home else {
        return path.to_path_buf();
    };
    let mut components = path.components();
    if matches!(components.next(), Some(Component::Normal(name)) if name == "~") {
        return home.join(components.as_path());
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_desktop_database_paths() {
        let path = PathBuf::from(env::var_os("HOME").unwrap_or_default())
            .join(".atools")
            .join("data.db");
        assert!(is_known_desktop_database(&path));
    }

    #[test]
    fn rejects_short_explicit_secret() {
        let config = Config {
            data_dir: PathBuf::from("data/standalone"),
            database_path: PathBuf::from("data/standalone/test.db"),
            jwt_secret: b"short".to_vec(),
            bootstrap_user: None,
            allow_registration: false,
            listen_address: SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 23517),
        };
        assert!(matches!(config.validate(), Err(ConfigError::WeakSecret)));
    }

    #[test]
    fn rejects_dotdot_path_to_desktop_database_before_directory_creation() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("home");
        let cwd = home.clone();
        let desktop_data = home.join(".atools");
        std::fs::create_dir_all(&desktop_data).unwrap();
        let escaped = PathBuf::from("missing/../.atools/data.db");
        assert!(path_is_within(&escaped, &desktop_data, &cwd, Some(&home)).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn resolves_existing_symlinks_before_database_path_check() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("home");
        let desktop_data = home.join(".atools");
        let alias = home.join("alias");
        std::fs::create_dir_all(&desktop_data).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        symlink(&desktop_data, &alias).unwrap();
        assert!(path_is_within(&alias.join("data.db"), &desktop_data, &home, Some(&home)).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn resolves_symlink_before_applying_parent_component() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("home");
        let desktop_data = home.join(".atools");
        let symlink_dir = temporary.path().join("links");
        let alias = symlink_dir.join("to-subdirectory");
        std::fs::create_dir_all(desktop_data.join("sub")).unwrap();
        std::fs::create_dir_all(&symlink_dir).unwrap();
        symlink(desktop_data.join("sub"), &alias).unwrap();
        let escaped = PathBuf::from("to-subdirectory/../data.db");
        assert!(path_is_within(&escaped, &desktop_data, &symlink_dir, Some(&home)).unwrap());
    }

    #[test]
    fn registration_boolean_matches_go_parse_bool_spellings_only() {
        for value in ["1", "t", "T", "true", "TRUE", "True"] {
            assert_eq!(parse_bool_value(value), Some(true));
        }
        for value in ["0", "f", "F", "false", "FALSE", "False"] {
            assert_eq!(parse_bool_value(value), Some(false));
        }
        for value in ["yes", "on", "TRUE ", " false", " "] {
            assert_eq!(parse_bool_value(value), None);
        }
    }
}
