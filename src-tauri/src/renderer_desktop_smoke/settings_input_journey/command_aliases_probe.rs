use serde_json::Value;
use tauri::{AppHandle, Webview, Wry};

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_alias_open_add(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
    child: &Webview<Wry>,
    target: &(String, String),
    alias: &str,
) -> Result<Value, &'static str> {
    let name = super::js_string(&target.0);
    let path = super::js_string(&target.1);
    let alias = super::js_string(alias);
    super::child_call(
        app,
        harness,
        child,
        "childAliasOpenAdd",
        "commandAliasesOpenAdd",
        &[name.as_str(), path.as_str(), alias.as_str()],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_alias_open_add_diagnostic(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::child_call(
        app,
        harness,
        child,
        "childAliasOpenAddDiagnostic",
        "commandAliasesOpenAddDiagnostic",
        &[],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_alias_add_save(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
    child: &Webview<Wry>,
    alias: &str,
) -> Result<Value, &'static str> {
    let alias = super::js_string(alias);
    super::child_call(
        app,
        harness,
        child,
        "childAliasAddSave",
        "commandAliasesAddSave",
        &[alias.as_str()],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_alias_edit_save(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
    child: &Webview<Wry>,
    from_alias: &str,
    to_alias: &str,
) -> Result<Value, &'static str> {
    let from_alias = super::js_string(from_alias);
    let to_alias = super::js_string(to_alias);
    super::child_call(
        app,
        harness,
        child,
        "childAliasEditSave",
        "commandAliasesEditSave",
        &[from_alias.as_str(), to_alias.as_str()],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_alias_read_back(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
    child: &Webview<Wry>,
    target: &(String, String),
    alias: &str,
) -> Result<Value, &'static str> {
    let name = super::js_string(&target.0);
    let path = super::js_string(&target.1);
    let alias = super::js_string(alias);
    super::child_call(
        app,
        harness,
        child,
        "childAliasReadBack",
        "commandAliasesReadBack",
        &[name.as_str(), path.as_str(), alias.as_str()],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_alias_delete(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
    child: &Webview<Wry>,
    alias: &str,
) -> Result<Value, &'static str> {
    let alias = super::js_string(alias);
    super::child_call(
        app,
        harness,
        child,
        "childAliasDelete",
        "commandAliasesDelete",
        &[alias.as_str()],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn main_alias_search(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
    target: &(String, String),
    query: &str,
    expected_count: u64,
) -> Result<Value, &'static str> {
    if expected_count > 1 {
        return Err(super::super::command_aliases_schema::COUNTER_INVALID);
    }
    let query = super::js_string(query);
    let name = super::js_string(&target.0);
    let path = super::js_string(&target.1);
    let expected_count = expected_count.to_string();
    super::main_call(
        app,
        harness,
        "mainAliasSearch",
        "commandAliasesSearch",
        &[
            query.as_str(),
            name.as_str(),
            path.as_str(),
            expected_count.as_str(),
        ],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn main_alias_inspect(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
) -> Result<Value, &'static str> {
    super::main_call(
        app,
        harness,
        "mainAliasInspect",
        "commandAliasesInspect",
        &[],
    )
    .await
}
