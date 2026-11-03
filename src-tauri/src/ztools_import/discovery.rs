//! Bounded discovery stops at package boundaries but includes their direct archive files.
use super::{is_supported_archive, MAX_ARCHIVE_BYTES};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

pub(super) const MAX_CANDIDATES: usize = 256;
pub(super) const MAX_DEPTH: usize = 8;
pub(super) const MAX_ENTRIES: usize = 8192;
pub(super) const MAX_TOTAL_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Default)]
struct Discovery {
    sources: BTreeSet<PathBuf>,
    entries: usize,
    archive_bytes: u64,
}

fn budget(message: &str) -> String {
    format!("插件扫描超出预算（{message}），请分批或选择更具体的插件目录/安装包")
}

fn excluded_directory(name: &std::ffi::OsStr) -> bool {
    ["node_modules", ".git", ".hg", ".svn"]
        .iter()
        .any(|excluded| name == *excluded)
}

impl Discovery {
    fn add(&mut self, path: &Path, archive_bytes: u64) -> Result<(), String> {
        if self.sources.contains(path) {
            return Ok(());
        }
        if self.sources.len() >= MAX_CANDIDATES {
            return Err(budget("最多 256 个候选"));
        }
        if archive_bytes > MAX_ARCHIVE_BYTES {
            return Err(budget("单个归档最多 64 MiB"));
        }
        self.archive_bytes = self
            .archive_bytes
            .checked_add(archive_bytes)
            .ok_or_else(|| budget("归档总大小溢出"))?;
        if self.archive_bytes > MAX_TOTAL_ARCHIVE_BYTES {
            return Err(budget("归档总大小最多 256 MiB"));
        }
        self.sources.insert(path.to_path_buf());
        Ok(())
    }

    fn visit(&mut self, root: &Path, depth: usize) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err(budget("目录深度最多 8 层"));
        }
        let metadata = fs::symlink_metadata(root)
            .map_err(|error| format!("无法读取扫描来源 {}: {error}", root.display()))?;
        if metadata.is_symlink() {
            return Err("扫描来源不能是符号链接，请选择实际插件目录或安装包".into());
        }
        if metadata.is_file() {
            return if is_supported_archive(root) {
                self.add(root, metadata.len())
            } else {
                Err(format!(
                    "Unsupported ZTools plugin source: {}",
                    root.display()
                ))
            };
        }
        if !metadata.is_dir() {
            return Err("扫描来源必须是普通目录或归档文件".into());
        }
        if root.file_name().is_some_and(excluded_directory) {
            return Ok(());
        }
        let package = atools_plugin::package_resolution::has_manifest_candidate(root);
        if package {
            self.add(root, 0)?;
        }
        for entry in fs::read_dir(root)
            .map_err(|error| format!("无法列出扫描目录 {}: {error}", root.display()))?
        {
            self.entries += 1;
            if self.entries > MAX_ENTRIES {
                return Err(budget("最多检查 8192 个目录条目"));
            }
            let entry = entry.map_err(|error| format!("无法读取扫描条目: {error}"))?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_file() && is_supported_archive(&path) {
                let current = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
                if current.is_file() && !current.is_symlink() {
                    self.add(&path, current.len())?;
                }
            } else if kind.is_dir()
                && !package
                && entry.file_name() != "dist"
                && !excluded_directory(&entry.file_name())
            {
                self.visit(&path, depth + 1)?;
            }
        }
        Ok(())
    }
}

pub(super) fn discover(roots: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let mut state = Discovery::default();
    for root in roots {
        state.visit(root, 0)?;
    }
    Ok(state.sources.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_limits_candidates_depth_and_directory_entries() {
        let temp = tempfile::tempdir().unwrap();
        let candidates = temp.path().join("candidates");
        fs::create_dir(&candidates).unwrap();
        for index in 0..=MAX_CANDIDATES {
            fs::write(candidates.join(format!("{index}.zip")), []).unwrap();
        }
        assert!(discover(&[candidates]).unwrap_err().contains("256 个候选"));

        let mut deepest = temp.path().join("depth");
        fs::create_dir(&deepest).unwrap();
        for _ in 0..=MAX_DEPTH {
            deepest = deepest.join("child");
            fs::create_dir(&deepest).unwrap();
        }
        assert!(discover(&[temp.path().join("depth")])
            .unwrap_err()
            .contains("8 层"));

        let entries = temp.path().join("entries");
        fs::create_dir(&entries).unwrap();
        fs::write(entries.join("one.txt"), []).unwrap();
        let mut discovery = Discovery {
            entries: MAX_ENTRIES,
            ..Discovery::default()
        };
        assert!(discovery.visit(&entries, 0).unwrap_err().contains("8192"));
    }

    #[test]
    fn compressed_archive_byte_limits_are_checked_before_archive_inspection() {
        let temp = tempfile::tempdir().unwrap();
        let single = temp.path().join("too-large.zip");
        fs::File::create(&single)
            .unwrap()
            .set_len(MAX_ARCHIVE_BYTES + 1)
            .unwrap();
        assert!(discover(&[single]).unwrap_err().contains("64 MiB"));

        let mut roots = Vec::new();
        for index in 0..4 {
            let path = temp.path().join(format!("{index}.zpx"));
            fs::File::create(&path)
                .unwrap()
                .set_len(MAX_ARCHIVE_BYTES)
                .unwrap();
            roots.push(path);
        }
        let last = temp.path().join("last.asar");
        fs::write(&last, [0]).unwrap();
        roots.push(last);
        assert!(discover(&roots).unwrap_err().contains("256 MiB"));
        let mut exact = Discovery::default();
        for (index, path) in roots[..4].iter().enumerate() {
            exact.add(path, MAX_ARCHIVE_BYTES).unwrap();
            assert_eq!(exact.archive_bytes, (index as u64 + 1) * MAX_ARCHIVE_BYTES);
        }
        assert_eq!(exact.archive_bytes, MAX_TOTAL_ARCHIVE_BYTES);
    }

    #[test]
    fn skips_dependency_build_and_vcs_subtrees_before_their_entries_consume_budget() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["node_modules", "dist", ".git", ".hg", ".svn"] {
            let directory = temp.path().join(name);
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("hidden.zip"), []).unwrap();
        }
        let visible = temp.path().join("visible.zip");
        fs::write(&visible, []).unwrap();
        assert_eq!(discover(&[temp.path().to_path_buf()]).unwrap(), [visible]);
        for name in ["node_modules", ".git", ".hg", ".svn"] {
            assert!(discover(&[temp.path().join(name)]).unwrap().is_empty());
        }
    }
}
