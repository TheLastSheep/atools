//! ZIP readiness/import adapter over the shared, bounded archive index.
use super::archive_readiness::{self, normalized_path, PackageReader};
#[cfg(test)]
use super::MAX_ENTRY_BYTES;
#[cfg(test)]
use crate::plugin_zip_archive::FileEntry;
use crate::plugin_zip_archive::{ZipArchiveIndex, ZipLimits};
use std::path::Path;

#[cfg(test)]
#[path = "zip_cli_alias.rs"]
mod cli_alias;

struct Package {
    index: ZipArchiveIndex<'static>,
    prefix: String,
}

impl Package {
    fn open(source: &Path) -> Result<Self, String> {
        let bytes = super::read_archive_bytes(source)?;
        let index = ZipArchiveIndex::open(bytes, ZipLimits::LOCAL)?;
        let prefix = index.select_local_prefix()?;
        // Local imports historically reject aliases from every non-selected prefix.
        index.validate_scope(&prefix, true)?;
        Ok(Self { index, prefix })
    }

    fn archive_path(&self, relative: &str) -> Result<String, String> {
        let safe = normalized_path("", relative, false)?;
        if self.prefix.is_empty() {
            Ok(safe)
        } else {
            Ok(format!("{}/{safe}", self.prefix))
        }
    }

    fn exists(&self, relative: &str) -> bool {
        self.archive_path(relative)
            .is_ok_and(|path| self.index.exists(&path))
    }

    #[cfg(test)]
    fn regular_file(&self, relative: &str) -> Option<FileEntry> {
        let path = self.archive_path(relative).ok()?;
        let entry = self.index.file_entry(&path)?;
        Some(entry)
    }

    fn read(&mut self, relative: &str, limit: usize) -> Result<Vec<u8>, String> {
        let path = self.archive_path(relative)?;
        self.index.read_asset(&path, limit)
    }
}

impl PackageReader for Package {
    fn exists(&self, path: &str) -> Result<bool, String> {
        Ok(Package::exists(self, path))
    }

    fn read(&mut self, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
        if !Package::exists(self, path) {
            return Ok(None);
        }
        Package::read(self, path, limit).map(Some)
    }
}

pub(super) fn inspect(source: &Path) -> Result<super::inspection::SourceInspection, String> {
    archive_readiness::inspect(source, "zip", &mut Package::open(source)?)
}

#[cfg(test)]
pub fn candidate(source: &Path) -> Result<super::ZToolsImportCandidate, String> {
    inspect(source).map(|item| item.candidate)
}

pub fn extract(source: &Path, destination: &Path) -> Result<(), String> {
    let mut package = Package::open(source)?;
    package
        .index
        .materialize_scope(destination, &package.prefix)?;
    Ok(())
}

#[cfg(test)]
#[path = "zip_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "zip_cli_alias_tests.rs"]
mod cli_alias_tests;
