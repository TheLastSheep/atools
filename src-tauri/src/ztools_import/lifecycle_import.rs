//! Regression adapter for identity-bound imports; production uses the shared batch plan.
use super::*;

pub(crate) fn preflight_import(source: &Path) -> Result<(ZToolsImportCandidate, String), String> {
    let candidate = candidate_from_source(source)?;
    let id = candidate
        .installation_id
        .clone()
        .ok_or("插件名称无法生成稳定安装 ID，请修正 manifest.name")?;
    Ok((candidate, id))
}

pub(crate) fn import_one_expected(
    db: &atools_core::Database,
    root: &Path,
    source: &Path,
    overwrite: bool,
    expected_id: &str,
) -> Result<ZToolsImportReport, String> {
    let inspected = inspection::inspect(source)?;
    let id = inspected
        .candidate
        .installation_id
        .clone()
        .ok_or("插件名称无法生成稳定安装 ID")?;
    if id != expected_id {
        return Err("插件身份在导入时发生变化，请重新扫描".into());
    }
    execute_prepared(
        db,
        root,
        PreparedImport {
            source: source.to_path_buf(),
            inspected,
            id,
        },
        overwrite,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_changed_source_cannot_mutate_a_different_plugin_than_its_execution_gate() {
        let scratch = tempfile::tempdir().unwrap();
        let source = scratch.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("plugin.json"),
            r#"{"name":"before","main":"index.html"}"#,
        )
        .unwrap();
        fs::write(source.join("index.html"), "<p>inert</p>").unwrap();
        let (_, expected) = preflight_import(&source).unwrap();
        fs::write(
            source.join("plugin.json"),
            r#"{"name":"after","main":"index.html"}"#,
        )
        .unwrap();
        let db = atools_core::Database::in_memory().unwrap();
        let install = scratch.path().join("installed");
        assert!(import_one_expected(&db, &install, &source, true, &expected)
            .unwrap_err()
            .contains("身份"));
        assert!(!install.exists());
        assert!(db.list_plugins().unwrap().is_empty());
    }
}
