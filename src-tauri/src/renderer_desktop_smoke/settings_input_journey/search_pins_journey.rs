use super::{native, probe, stage, state::Harness};
use atools_core::db::RendererAppStateSnapshot;
use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Wry};

const PIN_KEY: &str = "pinned-commands";
const HISTORY_KEY: &str = "command-history";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

struct SearchState {
    revision: u64,
    history: Option<String>,
    pins: Vec<Value>,
}

pub(super) async fn pin_search_stage(
    app: &AppHandle<Wry>,
    harness: &Harness,
    started: Instant,
    child: &tauri::Webview<Wry>,
    target: &(String, String),
    baseline_count: u64,
) -> Result<(), &'static str> {
    let before = read_state(harness).await?;
    let initially_empty = before.pins.is_empty();
    let mut search_pins = harness.search_pins();
    search_pins["initiallyEmpty"] = Value::Bool(initially_empty);
    search_pins["initialRevision"] = Value::from(before.revision);
    harness.set_search_pins(search_pins);
    harness.set_initial_history_raw(before.history.clone());
    if !initially_empty {
        return Err("settings-input-search-pin-initial-state-invalid");
    }

    let evidence = probe::child_pin_search(app, harness, child, target).await?;
    let after = read_state(harness).await?;
    let pin_stored = only_target_pin(&after.pins, target) && write_advanced_from(&before, &after);
    let pin_read_back = bool_field(&evidence, "readBack");
    let history_unchanged = before.history == after.history;
    let mut search_pins = harness.search_pins();
    search_pins["pinStored"] = Value::Bool(pin_stored);
    search_pins["pinReadBack"] = Value::Bool(pin_read_back);
    search_pins["pinnedRevision"] = Value::from(after.revision);
    search_pins["historyUnchanged"] = Value::Bool(history_unchanged);
    harness.set_search_pins(search_pins);

    let stage_ok = child_pin_operation_ok(&evidence, baseline_count)
        && pin_stored
        && pin_read_back
        && history_unchanged;
    stage::record(
        app,
        harness,
        started,
        "pinSearch",
        Some(evidence),
        None,
        None,
        probe::main_inspect(app, harness).await?,
        stage_ok,
        "settings-input-search-pin-operation-invalid",
    )
    .await
}

pub(super) async fn verify_main_pin(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target_name: &str,
) -> Result<(), &'static str> {
    let expected_revision = harness.search_pins()["pinnedRevision"]
        .as_u64()
        .ok_or("settings-input-search-pin-state-invalid")?;
    let evidence =
        probe::main_pinned_search(app, harness, target_name, true, expected_revision).await?;
    let main_pinned = main_pin_evidence_ok(&evidence, true);
    let mut search_pins = harness.search_pins();
    search_pins["mainPinned"] = Value::Bool(main_pinned);
    harness.set_search_pins(search_pins);
    if main_pinned {
        Ok(())
    } else {
        Err("settings-input-search-pin-main-dom-invalid")
    }
}

pub(super) async fn unpin_search_stage(
    app: &AppHandle<Wry>,
    harness: &Harness,
    started: Instant,
    child: &tauri::Webview<Wry>,
    target: &(String, String),
    baseline_count: u64,
) -> Result<(), &'static str> {
    let before = read_state(harness).await?;
    let initial_history = harness
        .initial_history_raw()
        .ok_or("settings-input-search-pin-state-invalid")?;
    if !only_target_pin(&before.pins, target)
        || before.history != initial_history
        || harness.search_pins()["pinnedRevision"].as_u64() != Some(before.revision)
    {
        return Err("settings-input-search-pin-state-invalid");
    }

    let evidence = probe::child_unpin_search(app, harness, child, target).await?;
    let after = read_state(harness).await?;
    let unpin_stored = after.pins.is_empty() && write_advanced_from(&before, &after);
    let unpin_read_back = bool_field(&evidence, "readBack");
    let history_unchanged = before.history == after.history && after.history == initial_history;
    let mut search_pins = harness.search_pins();
    search_pins["unpinStored"] = Value::Bool(unpin_stored);
    search_pins["unpinReadBack"] = Value::Bool(unpin_read_back);
    search_pins["historyUnchanged"] =
        Value::Bool(search_pins["historyUnchanged"].as_bool() == Some(true) && history_unchanged);
    search_pins["unpinnedRevision"] = Value::from(after.revision);
    harness.set_search_pins(search_pins);

    let stage_ok = child_pin_operation_ok(&evidence, baseline_count)
        && unpin_stored
        && unpin_read_back
        && history_unchanged;
    stage::record(
        app,
        harness,
        started,
        "unpinSearch",
        Some(evidence),
        None,
        None,
        probe::main_inspect(app, harness).await?,
        stage_ok,
        "settings-input-search-pin-operation-invalid",
    )
    .await?;

    super::command_availability::run(app, harness, child).await;

    super::material::verify_general_theme(app, harness, child).await;

    super::local_app_search::run(app, harness, child).await?;
    super::plugin_inventory_journey::toggle_timestamp_inventory(app, harness, target).await?;
    let evidence =
        probe::main_pinned_search(app, harness, &target.0, false, after.revision).await?;
    let main_unpinned = main_pin_evidence_ok(&evidence, false);
    let mut search_pins = harness.search_pins();
    search_pins["mainUnpinned"] = Value::Bool(main_unpinned);
    harness.set_search_pins(search_pins);
    if main_unpinned {
        Ok(())
    } else {
        Err("settings-input-search-unpin-main-dom-invalid")
    }
}

async fn read_state(harness: &Harness) -> Result<SearchState, &'static str> {
    let db = harness.database();
    let snapshot = tauri::async_runtime::spawn_blocking(move || db.read_renderer_app_state())
        .await
        .map_err(|_| "settings-input-search-pin-state-invalid")?
        .map_err(|_| "settings-input-search-pin-state-invalid")?;
    from_snapshot(snapshot)
}

fn from_snapshot(snapshot: RendererAppStateSnapshot) -> Result<SearchState, &'static str> {
    let history = snapshot
        .values
        .get(HISTORY_KEY)
        .cloned()
        .ok_or("settings-input-search-pin-state-invalid")?;
    let raw_pins = snapshot
        .values
        .get(PIN_KEY)
        .cloned()
        .ok_or("settings-input-search-pin-state-invalid")?;
    let pins = parse_rows(raw_pins.as_deref())?;
    Ok(SearchState {
        revision: snapshot.revision,
        history,
        pins,
    })
}

fn parse_rows(raw: Option<&str>) -> Result<Vec<Value>, &'static str> {
    match raw {
        Some(raw) => {
            serde_json::from_str(raw).map_err(|_| "settings-input-search-pin-state-invalid")
        }
        None => Ok(Vec::new()),
    }
}

fn only_target_pin(rows: &[Value], target: &(String, String)) -> bool {
    rows.len() == 1
        && rows[0]["path"].as_str() == Some(target.1.as_str())
        && rows[0]["name"].as_str() == Some(target.0.as_str())
        && rows[0]["type"].as_str() == Some("direct")
        && rows[0]["subType"].as_str() == Some("app")
}

fn write_advanced_from(before: &SearchState, after: &SearchState) -> bool {
    before.history == after.history
        && before
            .revision
            .checked_add(1)
            .is_some_and(|next| next <= MAX_SAFE_INTEGER && after.revision == next)
}

fn child_pin_operation_ok(evidence: &Value, baseline_count: u64) -> bool {
    [
        "menuOpened",
        "menuItemFound",
        "clickDispatched",
        "menuStateReflected",
        "readBack",
    ]
    .into_iter()
    .all(|key| bool_field(evidence, key))
        && bool_field(evidence, "routeValid")
        && bool_field(evidence, "targetUnique")
        && bool_field(evidence, "queryMatches")
        && evidence["baselineCount"].as_u64() == Some(baseline_count)
        && evidence["filteredCount"].as_u64() == Some(baseline_count)
        && evidence["matchedCount"].as_u64() == Some(baseline_count)
        && evidence["restoredCount"].is_null()
}

fn main_pin_evidence_ok(evidence: &Value, should_be_present: bool) -> bool {
    bool_field(evidence, "inputFound")
        && bool_field(evidence, "inputEmpty")
        && bool_field(evidence, "searchViewReady")
        && bool_field(evidence, "revisionMatches")
        && if should_be_present {
            bool_field(evidence, "pinnedGroupFound")
                && bool_field(evidence, "targetPresent")
                && evidence["targetAbsent"].as_bool() == Some(false)
        } else {
            bool_field(evidence, "targetAbsent")
        }
}

fn bool_field(value: &Value, key: &str) -> bool {
    value[key].as_bool() == Some(true)
}

#[cfg(test)]
mod tests {
    use super::{main_pin_evidence_ok, only_target_pin, write_advanced_from, SearchState};
    use serde_json::json;

    fn target() -> (String, String) {
        (
            "Fixture App".to_owned(),
            "/Applications/Fixture.app".to_owned(),
        )
    }

    fn state(revision: u64, pins: Vec<serde_json::Value>) -> SearchState {
        SearchState {
            revision,
            history: Some("[]".to_owned()),
            pins,
        }
    }

    #[test]
    fn pinned_state_requires_only_the_exact_direct_app_target() {
        let target = target();
        let record = json!({
            "path": target.1.clone(),
            "name": target.0.clone(),
            "type": "direct",
            "subType": "app",
        });
        assert!(only_target_pin(std::slice::from_ref(&record), &target));
        assert!(!only_target_pin(&[], &target));
        assert!(!only_target_pin(&[record.clone(), record.clone()], &target));

        let mut plugin = record.clone();
        plugin["type"] = json!("plugin");
        assert!(!only_target_pin(&[plugin], &target));
        let mut wrong_identity = record;
        wrong_identity["path"] = json!("/Applications/Other.app");
        assert!(!only_target_pin(&[wrong_identity], &target));
    }

    #[test]
    fn a_pin_write_must_advance_one_safe_revision_without_touching_history() {
        let before = state(10, vec![]);
        assert!(write_advanced_from(&before, &state(11, vec![])));
        assert!(!write_advanced_from(&before, &state(10, vec![])));
        assert!(!write_advanced_from(&before, &state(12, vec![])));

        let mut changed_history = state(11, vec![]);
        changed_history.history = Some("[{\"private\":true}]".to_owned());
        assert!(!write_advanced_from(&before, &changed_history));
        assert!(!write_advanced_from(
            &state(super::MAX_SAFE_INTEGER, vec![]),
            &state(super::MAX_SAFE_INTEGER, vec![]),
        ));
    }

    #[test]
    fn main_pin_dom_result_requires_original_search_view_and_matching_native_revision() {
        let pinned = json!({
            "inputFound": true,
            "inputEmpty": true,
            "searchViewReady": true,
            "revisionMatches": true,
            "pinnedGroupFound": true,
            "targetPresent": true,
            "targetAbsent": false,
        });
        assert!(main_pin_evidence_ok(&pinned, true));
        for key in ["searchViewReady", "revisionMatches"] {
            let mut stale = pinned.clone();
            stale[key] = json!(false);
            assert!(!main_pin_evidence_ok(&stale, true));
        }
        let unpinned = json!({
            "inputFound": true,
            "inputEmpty": true,
            "searchViewReady": true,
            "revisionMatches": true,
            "pinnedGroupFound": false,
            "targetPresent": false,
            "targetAbsent": true,
        });
        assert!(main_pin_evidence_ok(&unpinned, false));
        for key in ["searchViewReady", "revisionMatches"] {
            let mut stale = unpinned.clone();
            stale[key] = json!(false);
            assert!(!main_pin_evidence_ok(&stale, false));
        }
    }
}
