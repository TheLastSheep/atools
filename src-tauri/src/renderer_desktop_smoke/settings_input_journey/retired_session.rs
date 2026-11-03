use super::{native, probe, state::Harness};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ReplayPlan {
    pub(super) generation: u64,
    pub(super) next_sequence: u64,
}

pub(super) async fn verify_replay(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    retired_session_id: &str,
    current_session_id: &str,
) -> Result<bool, &'static str> {
    if !retired_id_is_retired(retired_session_id, current_session_id) {
        return Ok(false);
    }
    let (before_child, before_id) = native::active_child(app, Duration::from_secs(2)).await?;
    if before_id != current_session_id || before_child.label() != child.label() {
        return Ok(false);
    }
    let before = runtime_snapshot(app)?;
    let Some(plan) = replay_plan(&before) else {
        return Ok(false);
    };

    let evidence =
        probe::child_retired_session(app, harness, child, retired_session_id, plan).await?;

    let after = runtime_snapshot(app)?;
    let (after_child, after_id) = native::active_child(app, Duration::from_secs(2)).await?;
    Ok(replay_succeeded(
        &evidence,
        &before,
        &after,
        &before_id,
        &after_id,
        current_session_id,
    ) && after_child.label() == child.label())
}

fn retired_id_is_retired(retired_session_id: &str, current_session_id: &str) -> bool {
    !retired_session_id.is_empty() && retired_session_id != current_session_id
}

fn runtime_snapshot(app: &AppHandle<Wry>) -> Result<Value, &'static str> {
    let snapshot = crate::renderer_settings_view::snapshot(app);
    if snapshot["stateAvailable"].as_bool() == Some(true)
        && snapshot["runtimeInitialized"].as_bool() == Some(true)
    {
        Ok(snapshot)
    } else {
        Err("settings-input-native-state-invalid")
    }
}

pub(super) fn replay_plan(snapshot: &Value) -> Option<ReplayPlan> {
    let input = &snapshot["subInput"];
    let generation = input["generation"].as_u64()?;
    let sequence = input["controlSequence"].as_u64()?;
    let next_sequence = sequence.checked_add(1)?;
    if snapshot["sessionCount"].as_u64() != Some(1)
        || snapshot["phase"].as_str() != Some("open")
        || snapshot["ready"].as_bool() != Some(true)
        || snapshot["documentAuthorized"].as_bool() != Some(true)
        || snapshot["childPresent"].as_bool() != Some(true)
        || snapshot["pendingCalls"].as_u64() != Some(0)
        || snapshot["pendingWrites"].as_u64() != Some(0)
        || input["closed"].as_bool() != Some(false)
        || input["visible"].as_bool() != Some(true)
        || input["valueBytes"].as_u64() != Some(0)
        || generation == 0
        || generation > MAX_SAFE_INTEGER
        || next_sequence > MAX_SAFE_INTEGER
    {
        return None;
    }
    Some(ReplayPlan {
        generation,
        next_sequence,
    })
}

pub(super) fn replay_succeeded(
    evidence: &Value,
    before: &Value,
    after: &Value,
    before_id: &str,
    after_id: &str,
    expected_current_id: &str,
) -> bool {
    evidence["rejected"].as_bool() == Some(true)
        && evidence["expectedCode"].as_bool() == Some(true)
        && replay_plan(before).is_some()
        && replay_plan(after).is_some()
        && before == after
        && before_id == expected_current_id
        && after_id == expected_current_id
}

#[cfg(test)]
mod tests {
    use super::{replay_plan, replay_succeeded, retired_id_is_retired};
    use serde_json::json;

    fn current_state() -> serde_json::Value {
        json!({
            "stateAvailable": true,
            "runtimeInitialized": true,
            "sessionCount": 1,
            "phase": "open",
            "ready": true,
            "documentAuthorized": true,
            "childPresent": true,
            "pendingCalls": 0,
            "pendingWrites": 0,
            "subInput": {
                "closed": false,
                "visible": true,
                "generation": 5,
                "controlSequence": 8,
                "revision": 11,
                "valueVersion": 2,
                "valueBytes": 0,
                "placeholderBytes": 12
            }
        })
    }

    #[test]
    fn replay_plan_uses_the_current_generation_and_next_control_sequence() {
        assert_eq!(
            replay_plan(&current_state()),
            Some(super::ReplayPlan {
                generation: 5,
                next_sequence: 9,
            })
        );
    }

    #[test]
    fn never_replays_with_the_current_session_id() {
        assert!(retired_id_is_retired("closed-id", "fresh-id"));
        assert!(!retired_id_is_retired("fresh-id", "fresh-id"));
        assert!(!retired_id_is_retired("", "fresh-id"));
    }

    #[test]
    fn replay_requires_expected_rejection_and_an_unchanged_fresh_session() {
        let before = current_state();
        let evidence = json!({"rejected": true, "expectedCode": true});
        assert!(replay_succeeded(
            &evidence, &before, &before, "fresh-id", "fresh-id", "fresh-id"
        ));

        let unexpected_code = json!({"rejected": true, "expectedCode": false});
        assert!(!replay_succeeded(
            &unexpected_code,
            &before,
            &before,
            "fresh-id",
            "fresh-id",
            "fresh-id"
        ));

        let resolved = json!({"rejected": false, "expectedCode": false});
        assert!(!replay_succeeded(
            &resolved, &before, &before, "fresh-id", "fresh-id", "fresh-id"
        ));

        let mut changed = before.clone();
        changed["subInput"]["controlSequence"] = json!(9);
        assert!(!replay_succeeded(
            &evidence, &before, &changed, "fresh-id", "fresh-id", "fresh-id"
        ));

        assert!(!replay_succeeded(
            &evidence,
            &before,
            &before,
            "fresh-id",
            "different-id",
            "fresh-id"
        ));
    }

    #[test]
    fn incomplete_or_nonempty_native_state_cannot_create_a_replay_plan() {
        let mut state = current_state();
        state["subInput"]["generation"] = json!(null);
        assert_eq!(replay_plan(&state), None);

        let mut state = current_state();
        state["pendingCalls"] = json!(1);
        assert_eq!(replay_plan(&state), None);

        let mut state = current_state();
        state["subInput"]["valueBytes"] = json!(1);
        assert_eq!(replay_plan(&state), None);
    }
}
