//! Safe, bounded projection of registered Legacy Node sessions.

use crate::plugin_runtime_inventory::{RuntimeEvidence, RuntimeKind, RuntimePhase, RuntimeSession};
use atools_plugin::sidecar::SidecarStatus;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use super::{Session, Sessions};

const MAX_INVENTORY_ENTRIES: usize = 128;

pub(crate) fn inventory_snapshot(app: &AppHandle) -> Result<(Vec<RuntimeSession>, bool), String> {
    let registry = app
        .try_state::<Arc<Sessions>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "Legacy Node session registry is unavailable".to_string())?;

    let sessions = registry.sessions.read();
    let mut ordered = sessions.values().collect::<Vec<_>>();
    ordered.sort_unstable_by(|left, right| left.id.cmp(&right.id));
    let entries = ordered
        .into_iter()
        .map(|session| project_session(session))
        .collect();
    let (snapshot, truncated) = bound_entries(entries);

    Ok((snapshot, truncated))
}

fn bound_entries(mut entries: Vec<RuntimeSession>) -> (Vec<RuntimeSession>, bool) {
    let truncated = entries.len() > MAX_INVENTORY_ENTRIES;
    entries.truncate(MAX_INVENTORY_ENTRIES);
    (entries, truncated)
}

fn project_session(session: &Session) -> RuntimeSession {
    RuntimeSession::new(
        RuntimeKind::LegacyNode,
        session.id.clone(),
        session.plugin_id.clone(),
        owner_window_label(&session.owner),
        None,
        phase_for_session(session.runtime.status(), session.is_closing()),
        RuntimeEvidence::NodeOwner,
    )
}

fn owner_window_label(owner: &str) -> Option<String> {
    let Some(window_owner) = owner.strip_prefix("window:") else {
        return None;
    };
    let Some((window_label, instance_id)) = window_owner.rsplit_once(':') else {
        return None;
    };
    if window_label.is_empty() || uuid::Uuid::parse_str(instance_id).is_err() {
        return None;
    }
    Some(window_label.to_string())
}

fn phase_for_session(status: SidecarStatus, closing: bool) -> RuntimePhase {
    match (closing, status) {
        (true, SidecarStatus::Starting | SidecarStatus::Running) => RuntimePhase::Stopping,
        (false, SidecarStatus::Starting) => RuntimePhase::Starting,
        (false, SidecarStatus::Running) => RuntimePhase::Ready,
        // A retained terminal record does not tell this synchronous projection
        // whether process cleanup was confirmed or failed.
        (_, SidecarStatus::Stopped | SidecarStatus::Crashed) => RuntimePhase::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::{bound_entries, owner_window_label, phase_for_session, MAX_INVENTORY_ENTRIES};
    use crate::plugin_runtime_inventory::{
        RuntimeEvidence, RuntimeKind, RuntimePhase, RuntimeSession,
    };
    use atools_plugin::sidecar::SidecarStatus;

    #[test]
    fn parses_only_window_owned_sessions() {
        let instance = uuid::Uuid::new_v4();
        assert_eq!(
            owner_window_label(&format!("window:main:{instance}")),
            Some("main".into())
        );
        assert_eq!(
            owner_window_label(&format!("window:plugin:child:{instance}")),
            Some("plugin:child".into())
        );
        assert_eq!(owner_window_label("agent:local:pasteboard-pro"), None);
        assert_eq!(owner_window_label("window:main:not-a-uuid"), None);
    }

    #[test]
    fn maps_terminal_retained_sessions_to_unknown() {
        assert_eq!(
            phase_for_session(SidecarStatus::Starting, false),
            RuntimePhase::Starting
        );
        assert_eq!(
            phase_for_session(SidecarStatus::Running, false),
            RuntimePhase::Ready
        );
        assert_eq!(
            phase_for_session(SidecarStatus::Running, true),
            RuntimePhase::Stopping
        );
        assert_eq!(
            phase_for_session(SidecarStatus::Stopped, true),
            RuntimePhase::Unknown
        );
        assert_eq!(
            phase_for_session(SidecarStatus::Crashed, false),
            RuntimePhase::Unknown
        );
    }

    #[test]
    fn bounds_projection_and_keeps_unknown_revision_explicit() {
        let rows = (0..129)
            .map(|index| {
                RuntimeSession::new(
                    RuntimeKind::LegacyNode,
                    format!("session-{index}"),
                    "sample-plugin".into(),
                    None,
                    None,
                    RuntimePhase::Unknown,
                    RuntimeEvidence::NodeOwner,
                )
            })
            .collect();
        let (rows, truncated) = bound_entries(rows);

        assert_eq!(rows.len(), MAX_INVENTORY_ENTRIES);
        assert!(truncated);
        let value = serde_json::to_value(&rows[0]).unwrap();
        assert!(value["codeRevision"].is_null());
        assert!(value["windowLabel"].is_null());
        let mut keys = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "codeRevision",
                "evidence",
                "id",
                "instanceId",
                "kind",
                "phase",
                "pluginId",
                "windowLabel",
            ]
        );
    }
}
