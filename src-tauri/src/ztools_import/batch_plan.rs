//! Inspect all selected identities before either import entry point mutates a plugin.
use super::{
    discovery,
    inspection::{self, SourceInspection},
    ZToolsImportFailure, ZToolsImportReport,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

pub(crate) struct PreparedImport {
    pub(super) source: PathBuf,
    pub(super) inspected: SourceInspection,
    pub(super) id: String,
}
impl PreparedImport {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn path(&self) -> String {
        self.source.to_string_lossy().into()
    }
    pub(crate) fn skip_existing(&mut self, root: &Path, overwrite: bool) -> bool {
        if !overwrite && fs::symlink_metadata(root.join(&self.id)).is_ok() {
            self.inspected
                .candidate
                .warnings
                .push("Plugin already installed; overwrite disabled".into());
            true
        } else {
            false
        }
    }
    pub(crate) fn into_candidate(self) -> super::ZToolsImportCandidate {
        self.inspected.candidate
    }
}

pub(crate) struct ImportBatchPlan {
    pub(crate) ready: Vec<PreparedImport>,
    pub(crate) report: ZToolsImportReport,
}

pub(crate) fn plan_import_batch(paths: &[String]) -> Result<ImportBatchPlan, String> {
    let mut plan = ImportBatchPlan {
        ready: Vec::new(),
        report: ZToolsImportReport {
            imported: Vec::new(),
            skipped: Vec::new(),
            failed: Vec::new(),
        },
    };
    if paths.len() > discovery::MAX_ENTRIES {
        return Err("一次导入最多提交 8192 条路径，请去重后分批选择（最多 256 个不同来源）".into());
    }
    let mut seen = BTreeSet::new();
    let mut requested = BTreeSet::new();
    let mut sources = Vec::new();
    let mut archive_bytes = 0u64;
    for path in paths {
        let source = PathBuf::from(path);
        if !requested.insert(source.clone()) {
            continue;
        }
        // Reject the selected path itself before canonical deduplication can resolve a link.
        let metadata = match fs::symlink_metadata(&source) {
            Ok(metadata) if !metadata.is_symlink() => metadata,
            Ok(_) => {
                plan.report.failed.push(ZToolsImportFailure {
                    path: path.clone(),
                    error: "不接受符号链接插件来源，请选择实际路径".into(),
                });
                continue;
            }
            Err(error) => {
                plan.report.failed.push(ZToolsImportFailure {
                    path: path.clone(),
                    error: error.to_string(),
                });
                continue;
            }
        };
        let canonical = match source.canonicalize() {
            Ok(path) => path,
            Err(error) => {
                plan.report.failed.push(ZToolsImportFailure {
                    path: path.clone(),
                    error: error.to_string(),
                });
                continue;
            }
        };
        if !seen.insert(canonical) {
            continue;
        }
        if seen.len() > discovery::MAX_CANDIDATES {
            return Err("一次导入最多 256 个不同来源，请分批选择".into());
        }
        if metadata.is_file()
            && super::is_supported_archive(&source)
            && metadata.len() <= super::MAX_ARCHIVE_BYTES
        {
            archive_bytes = archive_bytes
                .checked_add(metadata.len())
                .ok_or("导入归档总大小溢出，请分批选择")?;
            if archive_bytes > discovery::MAX_TOTAL_ARCHIVE_BYTES {
                return Err("一次导入归档总大小最多 256 MiB，请分批选择".into());
            }
        }
        sources.push(source);
    }
    // Count cheap source metadata first: an oversized batch must not decompress
    // earlier archives merely to discover a later file exceeds the total cap.
    let mut inspected = Vec::new();
    for source in sources {
        match inspection::inspect(&source) {
            Ok(item) => inspected.push((source, item)),
            Err(error) => plan.report.failed.push(ZToolsImportFailure {
                path: source.to_string_lossy().into(),
                error,
            }),
        }
    }
    let mut counts = BTreeMap::new();
    for (_, item) in &inspected {
        if let Some(key) = &item.candidate.installation_key {
            *counts.entry(key.clone()).or_insert(0usize) += 1;
        }
    }
    for (source, item) in inspected {
        if let (Some(id), Some(key)) = (
            &item.candidate.installation_id,
            &item.candidate.installation_key,
        ) {
            if counts[key] > 1 {
                plan.report.failed.push(ZToolsImportFailure {
                    path: source.to_string_lossy().into(),
                    error: format!(
                        "安装目录冲突（安装 ID '{id}' 对应多个来源或大小写别名）；请只选择一个插件发布目录或安装包"
                    ),
                });
                continue;
            }
            if item.candidate.errors.is_empty() {
                plan.ready.push(PreparedImport {
                    source,
                    id: id.clone(),
                    inspected: item,
                });
                continue;
            }
        }
        plan.report.skipped.push(item.candidate);
    }
    Ok(plan)
}
