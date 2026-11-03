//! Opt-in clipboard fixture assembly and dispatch; ordinary startup never uses this module.
use super::profile::Profile;
use atools_core::Database;
use std::sync::Arc;
use tauri::{ipc::Invoke, webview::PageLoadPayload, AppHandle, Builder, Webview, Wry};

use crate::pasteboard_runtime::PasteboardBackend;
#[cfg(target_os = "macos")]
use tauri::Manager;

pub(super) struct Prepared {
    backend: Arc<dyn PasteboardBackend>,
    #[cfg(target_os = "macos")]
    harness: Option<super::clipboard_context_journey::Harness>,
}

impl Prepared {
    pub(super) fn backend(&self) -> Arc<dyn PasteboardBackend> {
        Arc::clone(&self.backend)
    }

    pub(super) fn manage(self, builder: Builder<Wry>) -> Builder<Wry> {
        #[cfg(target_os = "macos")]
        if let Some(harness) = self.harness {
            return builder.manage(harness);
        }
        builder
    }
}

pub(super) fn prepare(
    profile: Arc<Profile>,
    db: Arc<Database>,
    fallback: Arc<dyn PasteboardBackend>,
) -> Result<Prepared, String> {
    #[cfg(target_os = "macos")]
    if profile.clipboard_context_journey {
        prepare_tools(&db)?;
        let board = crate::pasteboard_native::clipboard_fixture::NamedClipboardFixture::new(
            &profile.run_id,
            &profile.root,
        )?;
        let harness = super::clipboard_context_journey::prepare(profile, db, board.clone())?;
        return Ok(Prepared {
            backend: board,
            harness: Some(harness),
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = db;
        if profile.clipboard_context_journey {
            return Err("clipboard-context requires macOS".into());
        }
    }
    Ok(Prepared {
        backend: fallback,
        #[cfg(target_os = "macos")]
        harness: None,
    })
}

#[cfg(target_os = "macos")]
fn prepare_tools(db: &Database) -> Result<(), String> {
    crate::agent_tools::sync_builtin_tools(db)?;
    let tool = db
        .get_agent_tool(crate::launcher_clipboard_context::TOOL)
        .map_err(|error| error.to_string())?
        .ok_or("clipboard fixture tool was not registered")?;
    if !tool.enabled
        || tool.source != crate::launcher_clipboard_context::SOURCE
        || tool.scopes != vec![atools_core::agent::PermissionScope::ClipboardRead]
    {
        return Err("clipboard fixture tool registry is not available".into());
    }
    Ok(())
}

pub(super) fn active(app: &AppHandle<Wry>) -> bool {
    #[cfg(target_os = "macos")]
    return app
        .try_state::<super::clipboard_context_journey::Harness>()
        .is_some();
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

pub(super) fn on_page_load(webview: &Webview<Wry>, payload: &PageLoadPayload<'_>) -> bool {
    #[cfg(target_os = "macos")]
    if active(webview.app_handle()) {
        super::clipboard_context_journey::on_page_load(webview, payload);
        return true;
    }
    let _ = (webview, payload);
    false
}

pub(super) fn start_if_enabled(app: &AppHandle<Wry>) -> bool {
    #[cfg(target_os = "macos")]
    if active(app) {
        super::clipboard_context_journey::start(app.clone());
        return true;
    }
    let _ = app;
    false
}

pub(super) fn observe_command(invoke: &Invoke<Wry>) {
    #[cfg(target_os = "macos")]
    super::clipboard_context_journey::observe_command(invoke);
    let _ = invoke;
}

pub(super) fn handles(command: &str) -> bool {
    #[cfg(target_os = "macos")]
    return super::clipboard_context_journey::handles(command);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = command;
        false
    }
}

pub(super) fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    #[cfg(target_os = "macos")]
    return super::clipboard_context_journey::handler();
    #[cfg(not(target_os = "macos"))]
    |_| false
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use atools_core::agent::PermissionDecision;

    #[test]
    fn registered_tool_uses_confirm_and_preserves_saved_deny_or_disabled_state() {
        let db = Database::in_memory().unwrap();
        let name = crate::launcher_clipboard_context::TOOL;
        let decision =
            || crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", name).unwrap();
        assert!(matches!(decision(), PermissionDecision::Deny));
        prepare_tools(&db).unwrap();
        assert!(matches!(decision(), PermissionDecision::Confirm));
        db.set_setting("agent.scope_policy", r#"{"clipboard_read":"deny"}"#)
            .unwrap();
        prepare_tools(&db).unwrap();
        assert!(matches!(decision(), PermissionDecision::Deny));
        db.set_agent_tool_enabled(name, false).unwrap();
        assert!(prepare_tools(&db).is_err());
        assert!(matches!(decision(), PermissionDecision::Deny));
    }
}
