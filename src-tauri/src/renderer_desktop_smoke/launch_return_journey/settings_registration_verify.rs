use atools_core::db::{RendererLocalShortcut, RendererLocalShortcutType};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Webview, Wry};

pub(super) fn require(condition: bool, error: &'static str) -> Result<(), &'static str> {
    if condition {
        Ok(())
    } else {
        Err(error)
    }
}

pub(super) fn exact_rows(
    rows: &[RendererLocalShortcut],
    paths: &[PathBuf],
    alias: Option<&str>,
) -> bool {
    if rows.len() != paths.len() {
        return false;
    }
    let names = [
        "AToolsOwnedProbeFirst.app",
        "AToolsOwnedProbeSecond.app",
        "owned-file.txt",
        "owned-folder",
    ];
    let kinds = [
        RendererLocalShortcutType::App,
        RendererLocalShortcutType::App,
        RendererLocalShortcutType::File,
        RendererLocalShortcutType::Folder,
    ];
    let mut ids = std::collections::HashSet::new();
    paths.iter().enumerate().all(|(index, path)| {
        let Some(row) = rows
            .iter()
            .find(|row| Some(row.path.as_str()) == path.to_str())
        else {
            return false;
        };
        let valid_id = uuid::Uuid::parse_str(&row.id).is_ok_and(|id| id.get_version_num() == 4);
        valid_id
            && ids.insert(&row.id)
            && row.name == names[index]
            && row.kind == kinds[index]
            && row.alias.as_deref() == if index == 0 { alias } else { None }
            && row.added_at <= 9_007_199_254_740_991
    })
}

pub(super) fn ui_paths(value: &Value, paths: &[PathBuf]) -> bool {
    let Some(rows) = value["rows"].as_array() else {
        return false;
    };
    rows.len() == paths.len()
        && paths
            .iter()
            .all(|path| rows.iter().any(|row| row["path"].as_str() == path.to_str()))
}

pub(super) fn child_info(
    app: &AppHandle<Wry>,
    child: &Webview<Wry>,
    session: &str,
    inspect: &Value,
) -> Result<Value, &'static str> {
    let config = &inspect["result"]["config"];
    let revision = config["bundleRevision"]
        .as_str()
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or("settings-registration-child-identity-invalid")?;
    let url = child
        .url()
        .map_err(|_| "settings-registration-child-identity-invalid")?;
    let state = crate::renderer_settings_view::snapshot(app);
    let dom = &inspect["result"];
    require(
        config["sessionId"] == session
            && config["version"] == 1
            && ["visible", "hidden", "prerender"]
                .iter()
                .any(|value| dom["documentVisibility"] == *value)
            && dom["documentHasFocus"].as_bool().is_some()
            && dom["href"].as_str() == Some(url.as_str())
            && crate::renderer_settings_view::is_expected_settings_url(&url, session)
            && url.fragment().is_some_and(|fragment| {
                fragment == "/localLaunch" || fragment.starts_with("/localLaunch?_t=")
            })
            && state["phase"] == "open"
            && state["ready"] == true
            && state["bundleRevisionPresent"] == true,
        "settings-registration-child-identity-invalid",
    )?;
    Ok(
        json!({"label":child.label(),"sessionId":session,"origin":format!("atools-settings://{session}.localhost"),
        "bundleRevision":revision,"url":url.as_str(),"phase":state["phase"],"ready":state["ready"],
        "documentVisibility":dom["documentVisibility"],"documentHasFocus":dom["documentHasFocus"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, path: &str, kind: RendererLocalShortcutType) -> RendererLocalShortcut {
        RendererLocalShortcut {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            path: path.into(),
            kind,
            added_at: 1,
            alias: None,
            icon: None,
            keywords: None,
            pinyin: None,
            pinyin_abbr: None,
        }
    }

    #[test]
    fn exact_roles_reject_swapped_kinds_and_an_unexpected_alias() {
        let paths = [
            PathBuf::from("/private/tmp/first.app"),
            PathBuf::from("/private/tmp/second.app"),
        ];
        let mut rows = vec![
            row(
                "AToolsOwnedProbeFirst.app",
                "/private/tmp/first.app",
                RendererLocalShortcutType::App,
            ),
            row(
                "AToolsOwnedProbeSecond.app",
                "/private/tmp/second.app",
                RendererLocalShortcutType::App,
            ),
        ];
        assert!(exact_rows(&rows, &paths, None));
        rows[0].alias = Some("alias".into());
        assert!(!exact_rows(&rows, &paths, None));
        assert!(exact_rows(&rows, &paths, Some("alias")));
        rows[1].kind = RendererLocalShortcutType::Folder;
        assert!(!exact_rows(&rows, &paths, Some("alias")));
    }
}
