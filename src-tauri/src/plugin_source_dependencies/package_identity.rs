//! Bounded validation of the identity recorded by each locked package archive.
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use super::limits::Deadline;
use super::tar_format::package_components;

const PACKAGE_JSON_BYTES: u64 = 64 * 1024;

#[derive(Debug, Eq, PartialEq)]
struct PackageIdentity {
    name: String,
    version: String,
}

impl<'de> Deserialize<'de> for PackageIdentity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct IdentityVisitor;
        impl<'de> Visitor<'de> for IdentityVisitor {
            type Value = PackageIdentity;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an npm package manifest object with unique name and version")
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut name = None;
                let mut version = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "name" => {
                            if name.is_some() {
                                return Err(serde::de::Error::duplicate_field("name"));
                            }
                            name = Some(map.next_value::<String>()?);
                        }
                        "version" => {
                            if version.is_some() {
                                return Err(serde::de::Error::duplicate_field("version"));
                            }
                            version = Some(map.next_value::<String>()?);
                        }
                        _ => {
                            let _ = map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(PackageIdentity {
                    name: name.ok_or_else(|| serde::de::Error::missing_field("name"))?,
                    version: version.ok_or_else(|| serde::de::Error::missing_field("version"))?,
                })
            }
        }
        deserializer.deserialize_map(IdentityVisitor)
    }
}

fn parse_identity(bytes: &[u8]) -> Result<PackageIdentity, &'static str> {
    if bytes.is_empty() || bytes.len() as u64 > PACKAGE_JSON_BYTES {
        return Err("dependency_package_identity_limit");
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let identity = PackageIdentity::deserialize(&mut deserializer)
        .map_err(|_| "dependency_package_identity_invalid")?;
    deserializer
        .end()
        .map_err(|_| "dependency_package_identity_invalid")?;
    Ok(identity)
}

pub(super) fn validate_package_identity(
    stage_root: &Path,
    package_path: &str,
    expected_name: &str,
    expected_version: &str,
    deadline: &Deadline,
) -> Result<(), &'static str> {
    deadline.check()?;
    let components = package_components(package_path)?;
    let mut path = stage_root.to_path_buf();
    for component in components {
        path.push(component);
    }
    path.push("package.json");
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "dependency_package_metadata_missing"
        } else {
            "dependency_package_metadata_invalid"
        }
    })?;
    let before = file
        .metadata()
        .map_err(|_| "dependency_package_metadata_invalid")?;
    if !before.is_file() || before.uid() != unsafe { libc::geteuid() } || before.mode() & 0o022 != 0
    {
        return Err("dependency_package_metadata_invalid");
    }
    if before.len() == 0 || before.len() > PACKAGE_JSON_BYTES {
        return Err("dependency_package_identity_limit");
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(PACKAGE_JSON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "dependency_package_metadata_invalid")?;
    deadline.check()?;
    let after = file
        .metadata()
        .map_err(|_| "dependency_package_metadata_invalid")?;
    if !same_file(&before, &after) || bytes.len() as u64 != before.len() {
        return Err("dependency_package_metadata_changed");
    }
    let actual = parse_identity(&bytes)?;
    if actual.name != expected_name || actual.version != expected_version {
        return Err("dependency_package_identity_mismatch");
    }
    Ok(())
}

fn same_file(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.uid() == after.uid()
        && before.mode() == after.mode()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

#[cfg(test)]
#[path = "package_identity_tests.rs"]
mod tests;
