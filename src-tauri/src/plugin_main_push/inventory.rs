//! Read-only projection of prepared MainPush runners and pending Prepare intents.
use super::{
    admission::{Admission, TTL},
    dto::{Identity, Operation},
    manager,
    store::Intent,
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
    let (admissions, intents) = {
        let store = runtime.0.lock();
        (
            store.admissions.values().cloned().collect::<Vec<_>>(),
            store.intents.values().cloned().collect::<Vec<_>>(),
        )
    };
    Ok(project(&admissions, &intents))
}

fn project(admissions: &[Admission], intents: &[Arc<Intent>]) -> (Vec<RuntimeSession>, bool) {
    let mut candidates = admissions
        .iter()
        .map(|admission| {
            let phase = if admission.used.elapsed() < TTL {
                RuntimePhase::Ready
            } else {
                // Expiry invalidates consent; it does not prove the renderer vanished.
                RuntimePhase::Unknown
            };
            from_identity(
                &admission.window,
                &admission.runner,
                &admission.identity,
                phase,
                if phase == RuntimePhase::Ready { 3 } else { 2 },
            )
        })
        .collect::<Vec<_>>();

    for intent in intents {
        if !intent.live() || intent.request.operation != Operation::Prepare {
            // Query and Select are callbacks against a prepared runner, not resources.
            continue;
        }
        candidates.push(from_identity(
            &intent.window,
            &intent.request.runner_id,
            &intent.request.identity,
            RuntimePhase::Starting,
            1,
        ));
    }

    project_candidates(candidates)
}

fn from_identity(
    window: &str,
    runner: &str,
    identity: &Identity,
    phase: RuntimePhase,
    priority: u8,
) -> Candidate {
    Candidate {
        window: window.to_owned(),
        instance_id: runner.to_owned(),
        plugin_id: identity.plugin_id.clone(),
        code_revision: identity.code_revision.clone(),
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
            RuntimeKind::MainPush,
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
        && candidate.instance_id.len() <= 36
        && uuid::Uuid::parse_str(&candidate.instance_id).is_ok()
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
    use super::{project, project_candidates, Candidate, MAX_ROWS, TTL};
    use crate::plugin_main_push::{
        admission::Admission,
        dto::{CommandType, Identity, Operation, Request},
        store::{Intent, State},
    };
    use crate::plugin_runtime_inventory::{RuntimeEvidence, RuntimePhase};
    use parking_lot::Mutex;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::Notify;

    fn identity(plugin: &str, revision: &str) -> Identity {
        Identity {
            plugin_id: plugin.into(),
            feature_code: "private-feature-code".into(),
            command_type: CommandType::Text,
            code_revision: revision.into(),
        }
    }

    fn request(runner: &str, operation: Operation, revision: &str) -> Request {
        Request {
            request_id: "00000000-0000-4000-8000-000000000101".into(),
            runner_id: runner.into(),
            identity: identity("harris.test-plugin", revision),
            operation,
            input_bytes: 4096,
            query_generation: 77,
        }
    }

    fn admission(runner: &str, revision: &str, used: Instant) -> Admission {
        Admission {
            window: "main".into(),
            runner: runner.into(),
            identity: identity("harris.test-plugin", revision),
            request: "private-request-id".into(),
            run: "private-task-run-id".into(),
            used,
        }
    }

    fn intent(request: Request) -> Arc<Intent> {
        Arc::new(Intent {
            window: "main".into(),
            request,
            created: Instant::now(),
            prepared_by: None,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        })
    }

    #[test]
    fn pending_prepare_is_starting_with_saved_revision_and_no_input_metadata() {
        let runner = "00000000-0000-4000-8000-000000000110";
        let revision = "a".repeat(64);
        let (rows, truncated) = project(
            &[],
            &[intent(request(runner, Operation::Prepare, &revision))],
        );

        assert!(!truncated);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].phase, RuntimePhase::Starting);
        assert_eq!(rows[0].evidence, RuntimeEvidence::Admission);
        assert_eq!(rows[0].code_revision.as_deref(), Some(revision.as_str()));
        let serialized = serde_json::to_string(&rows).unwrap();
        assert!(!serialized.contains("private-feature-code"));
        assert!(!serialized.contains("private-request-id"));
        assert!(!serialized.contains("private-task-run-id"));
        assert!(!serialized.contains("queryGeneration"));
    }

    #[test]
    fn admission_and_callback_intents_are_one_runner_row() {
        let runner = "00000000-0000-4000-8000-000000000111";
        let revision = "b".repeat(64);
        let admission = admission(runner, &revision, Instant::now());
        let query = intent(request(runner, Operation::Query, &revision));
        let select = intent(request(runner, Operation::Select, &revision));
        let (rows, _) = project(&[admission], &[query, select]);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].instance_id, runner);
        assert_eq!(rows[0].phase, RuntimePhase::Ready);
        assert_eq!(rows[0].code_revision.as_deref(), Some(revision.as_str()));
    }

    #[test]
    fn expired_admission_is_unknown_without_mutating_the_source() {
        let runner = "00000000-0000-4000-8000-000000000112";
        let revision = "c".repeat(64);
        let old = admission(
            runner,
            &revision,
            Instant::now() - TTL - Duration::from_secs(1),
        );
        let (rows, _) = project(std::slice::from_ref(&old), &[]);

        assert_eq!(rows[0].phase, RuntimePhase::Unknown);
        assert_eq!(old.identity.code_revision, revision);
        assert!(old.used.elapsed() >= TTL);
    }

    #[test]
    fn projection_caps_rows_and_ignores_query_intent_without_admission() {
        let revision = "d".repeat(64);
        let candidates = (0..129)
            .map(|index| Candidate {
                window: "main".into(),
                instance_id: format!("00000000-0000-4000-8000-{index:012x}"),
                plugin_id: "harris.test-plugin".into(),
                code_revision: revision.clone(),
                phase: RuntimePhase::Ready,
                priority: 3,
            })
            .collect();
        let (rows, truncated) = project_candidates(candidates);
        assert_eq!(rows.len(), MAX_ROWS);
        assert!(truncated);

        let query_runner = "00000000-0000-4000-8000-000000000113";
        let (rows, _) = project(
            &[],
            &[intent(request(query_runner, Operation::Query, &revision))],
        );
        assert!(rows.is_empty());
    }
}
