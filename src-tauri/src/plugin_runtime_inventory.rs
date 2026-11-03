//! Read-only, bounded observations of runtime-owned resources. No liveness probe
//! or cleanup is performed here; an admission is not proof of an OS process.
use serde::Serialize;
use tauri::{AppHandle, WebviewWindow};

const MAX_SESSIONS: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeKind {
    Background,
    MainPush,
    LegacyNode,
    BrowserWindow,
    Foreground,
    Detached,
    Sidecar,
    Quickjs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimePhase {
    Starting,
    Ready,
    Stopping,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeEvidence {
    Admission,
    NodeOwner,
    NativeWindow,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSession {
    pub id: String,
    pub kind: RuntimeKind,
    pub instance_id: String,
    pub plugin_id: String,
    pub window_label: Option<String>,
    pub code_revision: Option<String>,
    pub phase: RuntimePhase,
    pub evidence: RuntimeEvidence,
}

impl RuntimeSession {
    pub(crate) fn new(
        kind: RuntimeKind,
        instance_id: String,
        plugin_id: String,
        window_label: Option<String>,
        code_revision: Option<String>,
        phase: RuntimePhase,
        evidence: RuntimeEvidence,
    ) -> Self {
        let id = serde_json::to_string(&(kind, &window_label, &instance_id))
            .expect("runtime identity consists only of strings");
        Self {
            id,
            kind,
            instance_id,
            plugin_id,
            window_label,
            code_revision,
            phase,
            evidence,
        }
    }

    fn valid(&self) -> bool {
        let bounded = |value: &str, max: usize| {
            !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
        };
        bounded(&self.plugin_id, 256)
            && match self.window_label.as_deref() {
                Some(label) => bounded(label, 128),
                None => self.kind == RuntimeKind::LegacyNode,
            }
            && bounded(&self.instance_id, 256)
            && self.code_revision.as_ref().is_none_or(|revision| {
                revision.len() == 64 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeCoverage {
    kind: RuntimeKind,
    available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSnapshot {
    schema_version: u8,
    sessions: Vec<RuntimeSession>,
    coverage: Vec<RuntimeCoverage>,
    truncated: bool,
}

type Source = Result<(Vec<RuntimeSession>, bool), String>;

fn assemble(sources: [(RuntimeKind, Source); 4]) -> RuntimeSnapshot {
    let mut snapshot = RuntimeSnapshot {
        schema_version: 1,
        sessions: Vec::new(),
        coverage: Vec::new(),
        truncated: false,
    };
    for (kind, result) in sources {
        let mut available = result.is_ok();
        if let Ok((rows, truncated)) = result {
            snapshot.truncated |= truncated;
            for row in rows.into_iter().take(MAX_SESSIONS + 1) {
                if row.kind != kind || !row.valid() {
                    available = false;
                    continue;
                }
                if snapshot
                    .sessions
                    .iter()
                    .any(|existing| existing.id == row.id)
                {
                    continue;
                }
                if snapshot.sessions.len() == MAX_SESSIONS {
                    snapshot.truncated = true;
                    continue;
                }
                snapshot.sessions.push(row);
            }
        }
        snapshot.coverage.push(RuntimeCoverage { kind, available });
    }
    // These sources need their own validated observation contract. In particular,
    // a detach handoff must not be presented as a running plugin document.
    for kind in [
        RuntimeKind::Foreground,
        RuntimeKind::Detached,
        RuntimeKind::Sidecar,
        RuntimeKind::Quickjs,
    ] {
        snapshot.coverage.push(RuntimeCoverage {
            kind,
            available: false,
        });
    }
    snapshot
        .sessions
        .sort_by(|left, right| left.id.cmp(&right.id));
    snapshot
}

#[tauri::command]
pub(crate) fn list_plugin_runtime_sessions(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<RuntimeSnapshot, String> {
    require_main(window.label())?;
    Ok(assemble([
        (
            RuntimeKind::Background,
            crate::plugin_background_runtime::inventory_snapshot(&app),
        ),
        (
            RuntimeKind::MainPush,
            crate::plugin_main_push::inventory_snapshot(&app),
        ),
        (
            RuntimeKind::LegacyNode,
            crate::legacy_runtime::inventory_snapshot(&app),
        ),
        (
            RuntimeKind::BrowserWindow,
            crate::plugin_browser_window_runtime::inventory_snapshot(&app),
        ),
    ]))
}

fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("ERR_PLUGIN_RUNTIME_MAIN_REQUIRED".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(index: usize) -> RuntimeSession {
        RuntimeSession::new(
            RuntimeKind::Background,
            index.to_string(),
            "sample".into(),
            Some("main".into()),
            Some("a".repeat(64)),
            RuntimePhase::Ready,
            RuntimeEvidence::Admission,
        )
    }
    #[test]
    fn bounds_deduplicates_and_preserves_partial_coverage() {
        let mut rows: Vec<_> = (0..140).map(row).collect();
        rows.push(row(0));
        let snapshot = assemble([
            (RuntimeKind::Background, Ok((rows, false))),
            (RuntimeKind::MainPush, Err("private diagnostic".into())),
            (RuntimeKind::LegacyNode, Ok((vec![], false))),
            (RuntimeKind::BrowserWindow, Ok((vec![], false))),
        ]);
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["sessions"].as_array().unwrap().len(), MAX_SESSIONS);
        assert_eq!(value["truncated"], true);
        assert_eq!(value["coverage"][1]["available"], false);
        assert!(!value.to_string().contains("private diagnostic"));
        assert_eq!(
            value["sessions"][0]["id"],
            "[\"background\",\"main\",\"0\"]"
        );
        assert!(require_main("plugin-detach").is_err());
        assert!(require_main("main").is_ok());
    }
}
