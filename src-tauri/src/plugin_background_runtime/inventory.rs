//! Read-only projection of the background admission registry.
use super::{
    dto::Operation,
    manager,
    store::{Admission, Intent},
};
use crate::plugin_runtime_inventory::{RuntimeEvidence, RuntimeKind, RuntimePhase, RuntimeSession};
use std::collections::BTreeMap;
use std::sync::Arc;
use tauri::AppHandle;

const MAX_ROWS: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
struct Candidate {
    window: String,
    instance_id: String,
    plugin_id: String,
    code_revision: String,
    phase: RuntimePhase,
    priority: u8,
}

pub(super) fn inventory_snapshot(app: &AppHandle) -> Result<(Vec<RuntimeSession>, bool), String> {
    let runtime = manager(app)?;
    let (admissions, intents, closing) = {
        let store = runtime.0.lock();
        let admissions = store
            .admissions
            .values()
            .map(|admission| from_admission(admission, RuntimePhase::Ready, 2))
            .collect::<Vec<_>>();
        (
            admissions,
            store.intents.values().cloned().collect::<Vec<_>>(),
            store
                .closing
                .iter()
                .map(|((window, session), request)| {
                    (
                        from_request(window, request, RuntimePhase::Stopping, 4),
                        session == &request.session_id,
                    )
                })
                .collect::<Vec<_>>(),
        )
    };
    Ok(project(&admissions, &intents, &closing))
}

fn project(
    admissions: &[Candidate],
    intents: &[Arc<Intent>],
    closing: &[(Candidate, bool)],
) -> (Vec<RuntimeSession>, bool) {
    let mut candidates = admissions.to_vec();

    for intent in intents {
        if !intent.is_live() {
            continue;
        }
        let (phase, priority) = match intent.request.operation {
            Operation::Start => (RuntimePhase::Starting, 1),
            Operation::Stop => (RuntimePhase::Stopping, 3),
        };
        candidates.push(from_request(
            &intent.window,
            &intent.request,
            phase,
            priority,
        ));
    }

    let mut incomplete = false;
    for (candidate, exact_owner) in closing {
        // A retained closing record means cleanup is still pending or failed. The
        // registry does not distinguish those states, so report Stopping only.
        if !*exact_owner {
            incomplete = true;
            continue;
        }
        candidates.push(candidate.clone());
    }

    let (rows, truncated) = project_candidates(candidates);
    (rows, truncated || incomplete)
}

fn from_admission(admission: &Admission, phase: RuntimePhase, priority: u8) -> Candidate {
    from_request(&admission.window, &admission.request, phase, priority)
}

fn from_request(
    window: &str,
    request: &super::dto::Request,
    phase: RuntimePhase,
    priority: u8,
) -> Candidate {
    Candidate {
        window: window.to_owned(),
        instance_id: request.session_id.clone(),
        plugin_id: request.plugin_id.clone(),
        code_revision: request.code_revision.clone(),
        phase,
        priority,
    }
}

fn project_candidates(candidates: Vec<Candidate>) -> (Vec<RuntimeSession>, bool) {
    let mut by_owner = BTreeMap::<(String, String), Candidate>::new();
    let mut truncated = false;
    for candidate in candidates {
        if !valid(&candidate) {
            truncated = true;
            continue;
        }
        let key = (candidate.window.clone(), candidate.instance_id.clone());
        match by_owner.get_mut(&key) {
            Some(existing) if candidate.priority > existing.priority => *existing = candidate,
            Some(existing)
                if candidate.priority == existing.priority
                    && stable_key(&candidate) < stable_key(existing) =>
            {
                *existing = candidate;
            }
            Some(_) => {}
            None => {
                by_owner.insert(key, candidate);
            }
        }
    }
    let mut rows = Vec::with_capacity(by_owner.len().min(MAX_ROWS));
    for (_, (_, candidate)) in by_owner.into_iter().take(MAX_ROWS + 1).enumerate() {
        if rows.len() == MAX_ROWS {
            truncated = true;
            break;
        }
        rows.push(RuntimeSession::new(
            RuntimeKind::Background,
            candidate.instance_id,
            candidate.plugin_id,
            Some(candidate.window),
            Some(candidate.code_revision),
            candidate.phase,
            RuntimeEvidence::Admission,
        ));
    }
    (rows, truncated)
}

fn stable_key(candidate: &Candidate) -> (&str, &str) {
    (&candidate.plugin_id, &candidate.code_revision)
}

fn valid(candidate: &Candidate) -> bool {
    valid_text(&candidate.window, 128)
        && candidate.instance_id.len() == 36
        && uuid::Uuid::parse_str(&candidate.instance_id)
            .is_ok_and(|id| id.to_string() == candidate.instance_id)
        && valid_text(&candidate.plugin_id, 256)
        && candidate.code_revision.len() == 64
        && candidate
            .code_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_background_runtime::{dto::Request, receipt::IntentState};
    use parking_lot::Mutex;
    use serde_json::json;
    use std::time::Duration;
    use tokio::sync::Notify;
    use tokio::time::Instant;

    fn request(session_id: &str, operation: Operation, revision: &str) -> Request {
        Request {
            request_id: "00000000-0000-4000-8000-000000000001".into(),
            session_id: session_id.into(),
            plugin_id: "harris.test-plugin".into(),
            code_revision: revision.into(),
            operation,
        }
    }

    fn admission(request: Request) -> Admission {
        Admission {
            window: "main".into(),
            request,
            run_id: "private-task-run-id".into(),
            action: json!({"path":"/private/plugin/path","payload":"secret bytes"}),
        }
    }

    fn intent(request: Request, closed: bool) -> Arc<Intent> {
        let mut state = IntentState::default();
        state.closed = closed;
        Arc::new(Intent {
            window: "main".into(),
            request,
            action: json!({"path":"/private/plugin/path","payload":"secret bytes"}),
            created: Instant::now() - Duration::from_millis(1),
            state: Mutex::new(state),
            changed: Notify::new(),
        })
    }

    #[test]
    fn retained_closing_owner_deduplicates_and_keeps_saved_revision() {
        let session = "00000000-0000-4000-8000-000000000010";
        let old_revision = "a".repeat(64);
        let admission = admission(request(session, Operation::Start, &old_revision));
        let admitted = from_admission(&admission, RuntimePhase::Ready, 2);
        let closing = vec![(
            from_request("main", &admission.request, RuntimePhase::Stopping, 4),
            true,
        )];
        let (rows, truncated) = project(&[admitted], &[], &closing);

        assert!(!truncated);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].phase, RuntimePhase::Stopping);
        assert_eq!(rows[0].evidence, RuntimeEvidence::Admission);
        assert_eq!(
            rows[0].code_revision.as_deref(),
            Some(old_revision.as_str())
        );
        assert_eq!(rows[0].window_label.as_deref(), Some("main"));
    }

    #[test]
    fn live_stop_intent_marks_its_exact_admission_stopping() {
        let session = "00000000-0000-4000-8000-000000000011";
        let revision = "b".repeat(64);
        let admission = admission(request(session, Operation::Start, &revision));
        let admitted = from_admission(&admission, RuntimePhase::Ready, 2);
        let stop = intent(request(session, Operation::Stop, &revision), false);
        let (rows, _) = project(&[admitted], &[stop], &[]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].phase, RuntimePhase::Stopping);
        assert_eq!(rows[0].instance_id, session);
    }

    #[test]
    fn closed_intents_are_omitted_and_action_data_never_enters_projection() {
        let session = "00000000-0000-4000-8000-000000000012";
        let closed = intent(request(session, Operation::Start, &"c".repeat(64)), true);
        let (rows, _) = project(&[], &[closed], &[]);
        assert!(rows.is_empty());

        let ready = admission(request(session, Operation::Start, &"d".repeat(64)));
        let admitted = from_admission(&ready, RuntimePhase::Ready, 2);
        let (rows, _) = project(&[admitted], &[], &[]);
        let serialized = serde_json::to_string(&rows).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!serialized.contains("/private/plugin/path"));
        assert!(!serialized.contains("secret bytes"));
        assert!(!serialized.contains("private-task-run-id"));
    }

    #[test]
    fn projection_is_bounded_and_reports_invalid_or_excess_rows() {
        let revision = "e".repeat(64);
        let candidates = (0..129)
            .map(|index| Candidate {
                window: "main".into(),
                instance_id: format!("00000000-0000-4000-8000-{index:012x}"),
                plugin_id: "harris.test-plugin".into(),
                code_revision: revision.clone(),
                phase: RuntimePhase::Ready,
                priority: 2,
            })
            .collect();
        let (rows, truncated) = project_candidates(candidates);
        assert_eq!(rows.len(), MAX_ROWS);
        assert!(truncated);
    }
}
