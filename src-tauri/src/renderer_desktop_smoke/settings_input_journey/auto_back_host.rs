use super::super::{diagnostics, native, probe, state::Harness};
use super::observations::{returned_to_search, sample, session_closed};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Webview, Wry};

const POLL_INTERVAL: Duration = Duration::from_millis(50);
const QUERYABLE_INPUT_TIMEOUT: Duration = Duration::from_secs(4);

pub(super) async fn open_settings(
    app: &AppHandle<Wry>,
    harness: &Harness,
    failure: &'static str,
) -> Result<(Webview<Wry>, String), &'static str> {
    let before = probe::main_open_state(app, harness).await.ok();
    let opened = probe::main_open_settings(app, harness)
        .await
        .map_err(|_| failure)?;
    if opened["openCallAvailable"].as_bool() != Some(true)
        || opened["openCallDispatched"].as_bool() != Some(true)
    {
        return Err(failure);
    }
    diagnostics::active_child_after_open(app, harness, before)
        .await
        .map_err(|_| failure)
}

pub(super) async fn navigate_general(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    failure: &'static str,
) -> Result<Value, &'static str> {
    let route = probe::child_theme_navigate(app, harness, child)
        .await
        .map_err(|_| failure)?;
    if route["routeGeneral"].as_bool() != Some(true)
        || route["themeControlFound"].as_bool() != Some(true)
    {
        return Err(failure);
    }
    Ok(route)
}

pub(super) async fn set_main_query(
    app: &AppHandle<Wry>,
    harness: &Harness,
    query: &str,
    failure: &'static str,
) -> Result<(), &'static str> {
    let evidence = probe::main_input(app, harness, query)
        .await
        .map_err(|_| failure)?;
    if evidence["inputFound"].as_bool() != Some(true)
        || evidence["eventDispatched"].as_bool() != Some(true)
        || evidence["valueMatches"].as_bool() != Some(true)
        || evidence["inputEmpty"].as_bool() != Some(false)
    {
        return Err(failure);
    }
    Ok(())
}

pub(super) async fn prepare_queryable_settings_and_set_main_query(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    session_id: &str,
    general_route_before: bool,
    query: &str,
) -> Value {
    let mut facts = serde_json::json!({
        "generalRouteBefore": general_route_before,
        "sameSession": null,
        "allCommandsRoute": null,
        "targetUnique": null,
        "queryMatches": null,
        "baselineCount": null,
        "filteredCount": null,
        "childDocumentHidden": null,
        "childDocumentHasFocus": null,
        "subInputVisibleBeforeRoute": null,
        "subInputRevisionBeforeRoute": null,
        "subInputVisible": null,
        "subInputRevision": null,
        "subInputControlSequence": null,
        "mainInputFound": null,
        "mainInputEmptyBeforeQuery": null,
        "mainDocumentHidden": null,
        "mainDocumentHasFocus": null,
        "mainInputEventDispatched": null,
        "mainInputValueMatches": null,
        "mainInputEmptyAfterQuery": null,
        "ready": false,
    });
    let Some(target) = harness.target() else {
        return facts;
    };
    let before = crate::renderer_settings_view::snapshot(app);
    let sub_input_visible_before_route = before["subInput"]["visible"].as_bool();
    facts["subInputVisibleBeforeRoute"] = before["subInput"]["visible"].clone();
    facts["subInputRevisionBeforeRoute"] = before["subInput"]["revision"].clone();
    let Some(before_revision) = before["subInput"]["revision"].as_u64() else {
        return facts;
    };

    let Ok(route) = probe::child_baseline(app, harness, child, &target, "childBaseline").await
    else {
        return facts;
    };
    facts["allCommandsRoute"] = route["routeValid"].clone();
    facts["targetUnique"] = route["targetUnique"].clone();
    facts["queryMatches"] = route["queryMatches"].clone();
    facts["baselineCount"] = route["baselineCount"].clone();
    facts["filteredCount"] = route["filteredCount"].clone();
    facts["childDocumentHidden"] = route["documentHidden"].clone();
    facts["childDocumentHasFocus"] = route["documentHasFocus"].clone();

    let same_session = native::active_child(app, Duration::from_millis(400))
        .await
        .is_ok_and(|(active, active_session)| {
            active.label() == child.label() && active_session == session_id
        });
    facts["sameSession"] = Value::Bool(same_session);
    let baseline_count = route["baselineCount"].as_u64();
    let route_ready = general_route_before
        && same_session
        && route["routeValid"].as_bool() == Some(true)
        && route["targetUnique"].as_bool() == Some(true)
        && route["queryMatches"].as_bool() == Some(true)
        && baseline_count.is_some_and(|count| count > 0)
        && route["filteredCount"].as_u64() == baseline_count
        && route["matchedCount"].as_u64() == baseline_count
        && route["documentHidden"].as_bool() == Some(true)
        && route["documentHasFocus"].as_bool() == Some(false)
        && sub_input_visible_before_route == Some(false);
    if !route_ready {
        return facts;
    }

    let deadline = Instant::now() + QUERYABLE_INPUT_TIMEOUT;
    loop {
        let snapshot = crate::renderer_settings_view::snapshot(app);
        let sub_input = &snapshot["subInput"];
        facts["subInputVisible"] = sub_input["visible"].clone();
        facts["subInputRevision"] = sub_input["revision"].clone();
        facts["subInputControlSequence"] = sub_input["controlSequence"].clone();
        let revision_advanced = sub_input["revision"]
            .as_u64()
            .is_some_and(|revision| revision > before_revision);
        if sub_input["visible"].as_bool() == Some(true) && revision_advanced {
            if let Ok(input) = probe::main_inspect(app, harness).await {
                facts["mainInputFound"] = input["inputFound"].clone();
                facts["mainInputEmptyBeforeQuery"] = input["inputEmpty"].clone();
                facts["mainDocumentHidden"] = input["documentHidden"].clone();
                facts["mainDocumentHasFocus"] = input["documentHasFocus"].clone();
                let input_ready = input["inputFound"].as_bool() == Some(true)
                    && input["inputEmpty"].as_bool() == Some(true)
                    && input["documentHidden"].as_bool() == Some(true)
                    && input["documentHasFocus"].as_bool() == Some(false);
                if input_ready {
                    if let Ok(set) = probe::main_input(app, harness, query).await {
                        facts["mainInputEventDispatched"] = set["eventDispatched"].clone();
                        facts["mainInputValueMatches"] = set["valueMatches"].clone();
                        facts["mainInputEmptyAfterQuery"] = set["inputEmpty"].clone();
                        facts["ready"] = Value::Bool(
                            set["inputFound"].as_bool() == Some(true)
                                && set["eventDispatched"].as_bool() == Some(true)
                                && set["valueMatches"].as_bool() == Some(true)
                                && set["inputEmpty"].as_bool() == Some(false),
                        );
                    }
                    return facts;
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    facts
}

pub(super) async fn wait_for_search_return(
    app: &AppHandle<Wry>,
    harness: &Harness,
    timeout: Duration,
    failure: &'static str,
    focus_events_before: u64,
) -> Result<Value, &'static str> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if session_closed(app) {
            let facts = sample(app, harness).await;
            if returned_to_search(&facts, focus_events_before) {
                return Ok(facts);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(failure);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
