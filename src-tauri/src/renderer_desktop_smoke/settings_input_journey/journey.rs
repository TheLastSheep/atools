use super::{native, probe, readiness, schema, stage, state::Harness};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Wry};

const JOURNEY_TIMEOUT: Duration = Duration::from_secs(150);
const INPUT_TIMEOUT: Duration = Duration::from_secs(8);

pub(super) fn start(app: AppHandle<Wry>) {
    let harness = app.state::<Harness>().inner().clone();
    let launch_at_login = harness.profile().settings_input_journey;
    if launch_at_login {
        super::launch_at_login_journey::initialize(&app);
    }
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        match tokio::time::timeout(JOURNEY_TIMEOUT, run_stages(&app, &harness, started)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => harness.add_error(error),
            Err(_) => harness.mark_timed_out(),
        }
        if launch_at_login {
            super::launch_at_login_journey::finalize(&app, &harness, started).await;
        }
        super::cleanup::finalize(&app, &harness, started).await;
    });
}

async fn run_stages(
    app: &AppHandle<Wry>,
    harness: &Harness,
    started: Instant,
) -> Result<(), &'static str> {
    let main_ready = harness.wait_main_ready().await?;
    if main_ready["inputFound"].as_bool() != Some(true) {
        return Err("settings-input-main-ready-timeout");
    }
    native::select_real_catalog_target(app, harness).await?;
    let target = harness
        .target()
        .ok_or("settings-input-catalog-target-unavailable")?;
    super::plugin_inventory_journey::release_pending_inventory(app, harness, &target).await?;

    super::updater_status::record_updater_status(app, harness).await?;
    stage::record(
        app,
        harness,
        started,
        "startup",
        None,
        None,
        None,
        probe::main_inspect(app, harness).await?,
        true,
        "settings-input-native-state-invalid",
    )
    .await?;

    super::launch_at_login_journey::install_isolated(app, harness);
    let open = probe::main_open_settings(app, harness).await?;
    if !bool_field(&open, "openCallAvailable") || !bool_field(&open, "openCallDispatched") {
        return Err("settings-input-settings-open-failed");
    }
    let open_state_before = probe::main_open_state(app, harness).await.ok();
    let (first_child, first_id) =
        super::diagnostics::active_child_after_open(app, harness, open_state_before).await?;
    harness.set_first_session_id(first_id.clone());
    let baseline =
        probe::child_baseline(app, harness, &first_child, &target, "childBaseline").await?;
    let baseline_main = wait_for_main_search_input(app, harness).await?;
    let baseline_count = baseline["baselineCount"].as_u64().unwrap_or(0);
    let open_ok = bool_field(&baseline, "routeValid")
        && bool_field(&baseline, "queryMatches")
        && bool_field(&baseline, "targetUnique")
        && baseline_count > 0
        && baseline["filteredCount"].as_u64() == Some(baseline_count)
        && baseline["matchedCount"].as_u64() == Some(baseline_count);
    stage::record(
        app,
        harness,
        started,
        "openAllCommands",
        Some(baseline),
        None,
        None,
        baseline_main,
        open_ok,
        "settings-input-catalog-baseline-invalid",
    )
    .await?;

    let opened_input = runtime_snapshot(app)?["subInput"].clone();
    let start_user_sequence = count(&opened_input, "userSequence")?;
    let start_generation = count(&opened_input, "generation")?;
    let start_value_version = count(&opened_input, "valueVersion")?;
    let target_query = target.0.clone();
    let match_event = probe::main_input(app, harness, &target_query).await?;
    let match_native = wait_for_user_input(app, start_user_sequence, target_query.len()).await?;
    let match_dom = probe::child_target(app, harness, &first_child, &target).await?;
    let match_ok = main_input_evidence_ok(&match_event, &target_query)
        && bool_field(&match_dom, "queryMatches")
        && bool_field(&match_dom, "targetUnique")
        && match_dom["filteredCount"].as_u64() == Some(1)
        && match_dom["matchedCount"].as_u64() == Some(1)
        && count(&match_native, "userSequence")? > start_user_sequence
        && count(&match_native, "generation")? == start_generation
        && count(&match_native, "valueVersion")? == start_value_version;
    stage::record(
        app,
        harness,
        started,
        "mainMatch",
        Some(match_dom),
        None,
        None,
        probe::main_inspect(app, harness).await?,
        match_ok,
        "settings-input-main-match-invalid",
    )
    .await?;

    let after_match_sequence = count(&match_native, "userSequence")?;
    let no_match_query = format!(
        "__atools_native_settings_no_match_{}",
        harness.profile().run_id
    );
    let no_match_event = probe::main_input(app, harness, &no_match_query).await?;
    let no_match_native =
        wait_for_user_input(app, after_match_sequence, no_match_query.len()).await?;
    let no_match_dom = probe::child_no_match(app, harness, &first_child).await?;
    let no_match_ok = main_input_evidence_ok(&no_match_event, &no_match_query)
        && bool_field(&no_match_dom, "queryMatches")
        && no_match_dom["filteredCount"].as_u64() == Some(0)
        && no_match_dom["matchedCount"].as_u64() == Some(0)
        && count(&no_match_native, "userSequence")? > after_match_sequence
        && count(&no_match_native, "generation")? == start_generation;
    stage::record(
        app,
        harness,
        started,
        "mainNoMatch",
        Some(no_match_dom),
        None,
        None,
        probe::main_inspect(app, harness).await?,
        no_match_ok,
        "settings-input-main-no-match-invalid",
    )
    .await?;

    let before_clear_sequence = count(&no_match_native, "userSequence")?;
    let clear_event = probe::main_input(app, harness, "").await?;
    let clear_native = wait_for_user_input(app, before_clear_sequence, 0).await?;
    let clear_dom = probe::child_clear(app, harness, &first_child).await?;
    let clear_ok = main_input_evidence_ok(&clear_event, "")
        && bool_field(&clear_dom, "queryMatches")
        && clear_dom["filteredCount"].as_u64() == Some(baseline_count)
        && clear_dom["matchedCount"].as_u64() == Some(baseline_count)
        && clear_dom["restoredCount"].as_u64() == Some(baseline_count)
        && count(&clear_native, "valueBytes")? == 0
        && count(&clear_native, "userSequence")? > before_clear_sequence
        && count(&clear_native, "generation")? == start_generation;
    stage::record(
        app,
        harness,
        started,
        "mainClear",
        Some(clear_dom),
        None,
        None,
        probe::main_inspect(app, harness).await?,
        clear_ok,
        "settings-input-main-clear-invalid",
    )
    .await?;

    super::search_pins_journey::pin_search_stage(
        app,
        harness,
        started,
        &first_child,
        &target,
        baseline_count,
    )
    .await?;

    let before_child_value = clear_native.clone();
    let child_value_evidence =
        probe::child_value(app, harness, &first_child, &target_query).await?;
    let child_value_native = wait_for_control_value(
        app,
        count(&before_child_value, "controlSequence")?,
        count(&before_child_value, "valueVersion")?,
        target_query.len(),
    )
    .await?;
    let child_main_value = probe::main_value_matches(app, harness, &target_query).await?;
    let child_value_dom = probe::child_target(app, harness, &first_child, &target).await?;
    let child_value_ok = bool_field(&child_value_evidence, "apiAvailable")
        && bool_field(&child_value_evidence, "acknowledged")
        && bool_field(&child_main_value, "inputFound")
        && bool_field(&child_main_value, "valueMatches")
        && bool_field(&child_value_dom, "queryMatches")
        && child_value_dom["filteredCount"].as_u64() == Some(1)
        && child_value_dom["matchedCount"].as_u64() == Some(1)
        && count(&child_value_native, "userSequence")?
            == count(&before_child_value, "userSequence")?
        && count(&child_value_native, "controlSequence")?
            > count(&before_child_value, "controlSequence")?
        && count(&child_value_native, "valueVersion")?
            > count(&before_child_value, "valueVersion")?
        && count(&child_value_native, "generation")? == start_generation;
    stage::record(
        app,
        harness,
        started,
        "childValueReturn",
        Some(child_value_dom),
        None,
        None,
        probe::main_inspect(app, harness).await?,
        child_value_ok,
        "settings-input-child-value-return-invalid",
    )
    .await?;

    let before_rotation = runtime_snapshot(app)?["subInput"].clone();
    let old_generation = count(&before_rotation, "generation")?;
    let old_session_id = first_id;
    let owner_route = probe::child_owner_route(app, harness, &first_child, &target).await?;
    let rotated = wait_for_generation(app, old_generation).await?;
    let current_generation = count(&rotated, "generation")?;
    let current_sequence = count(&rotated, "controlSequence")?;
    let current_revision = count(&rotated, "revision")?;
    let current_version = count(&rotated, "valueVersion")?;
    let stale = probe::child_stale(
        app,
        harness,
        &first_child,
        old_generation,
        current_generation,
        current_sequence + 1,
        current_revision,
        current_version,
    )
    .await?;
    let after_stale = runtime_snapshot(app)?["subInput"].clone();
    let stale_rejected = bool_field(&stale, "replyValid")
        && !bool_field(&stale, "applied")
        && bool_field(&stale, "replyMatchesCurrent")
        && unchanged_sub_input(&rotated, &after_stale);
    let owner_ok = bool_field(&owner_route, "routeValid")
        && current_generation > old_generation
        && runtime_snapshot(app)?["sessionCount"].as_u64() == Some(1)
        && stale_rejected;
    stage::record(
        app,
        harness,
        started,
        "ownerRotation",
        Some(owner_route),
        Some(stale_rejected),
        None,
        probe::main_inspect(app, harness).await?,
        owner_ok,
        "settings-input-stale-owner-not-rejected",
    )
    .await?;

    super::cleanup::close_child_via_plugin(app, harness, &first_child).await?;
    let closed_main = probe::main_inspect(app, harness).await?;
    let closed_ok = bool_field(&closed_main, "inputEmpty");
    stage::record(
        app,
        harness,
        started,
        "closeCleanup",
        None,
        None,
        None,
        closed_main,
        closed_ok,
        "settings-input-close-not-drained",
    )
    .await?;
    super::search_pins_journey::verify_main_pin(app, harness, &target.0).await?;

    let reopened = probe::main_open_settings(app, harness).await?;
    if !bool_field(&reopened, "openCallAvailable") || !bool_field(&reopened, "openCallDispatched") {
        return Err("settings-input-settings-open-failed");
    }
    let reopen_state_before = probe::main_open_state(app, harness).await.ok();
    let (fresh_child, fresh_id) =
        super::diagnostics::active_child_after_open(app, harness, reopen_state_before).await?;
    let fresh_baseline =
        probe::child_baseline(app, harness, &fresh_child, &target, "childReopenBaseline").await?;
    let fresh_main = wait_for_main_search_input(app, harness).await?;
    let retired_input_rejected = super::retired_session::verify_replay(
        app,
        harness,
        &fresh_child,
        &old_session_id,
        &fresh_id,
    )
    .await?;
    let fresh_native = runtime_snapshot(app)?;
    let fresh_session = fresh_id != old_session_id;
    let fresh_ok = fresh_session
        && bool_field(&fresh_baseline, "routeValid")
        && bool_field(&fresh_baseline, "queryMatches")
        && bool_field(&fresh_baseline, "targetUnique")
        && fresh_baseline["baselineCount"].as_u64() == Some(baseline_count)
        && fresh_baseline["filteredCount"].as_u64() == Some(baseline_count)
        && count(&fresh_native["subInput"], "valueBytes")? == 0
        && fresh_native["sessionCount"].as_u64() == Some(1)
        && retired_input_rejected;
    stage::record(
        app,
        harness,
        started,
        "freshReopen",
        Some(fresh_baseline),
        Some(retired_input_rejected),
        Some(fresh_session),
        fresh_main,
        fresh_ok,
        "settings-input-fresh-session-invalid",
    )
    .await?;
    super::search_pins_journey::unpin_search_stage(
        app,
        harness,
        started,
        &fresh_child,
        &target,
        baseline_count,
    )
    .await?;
    super::command_aliases::run(app, harness, &target).await?;
    super::window_opacity_journey::run(app, harness).await?;
    super::tray_visibility_journey::run(app, harness).await?;
    super::main_hotkey_journey::run(app, harness).await?;
    super::general_policies_journey::run(app, harness).await?;
    super::auto_back_journey::run(app, harness).await?;
    super::launch_at_login_journey::run(app, harness).await;
    Ok(())
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

async fn wait_for_user_input(
    app: &AppHandle<Wry>,
    after_sequence: u64,
    expected_bytes: usize,
) -> Result<Value, &'static str> {
    wait_for_input(app, |input| {
        input["userSequence"]
            .as_u64()
            .is_some_and(|value| value > after_sequence)
            && input["valueBytes"].as_u64() == Some(expected_bytes as u64)
    })
    .await
}

async fn wait_for_main_search_input(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<Value, &'static str> {
    let deadline = tokio::time::Instant::now() + INPUT_TIMEOUT;
    loop {
        let native = runtime_snapshot(app)?;
        let main = probe::main_inspect(app, harness).await?;
        if readiness::main_search_input_is_ready(&native, &main) {
            return Ok(main);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("settings-input-main-ready-timeout");
        }
        tokio::time::sleep(schema::POLL_INTERVAL).await;
    }
}

async fn wait_for_control_value(
    app: &AppHandle<Wry>,
    after_sequence: u64,
    after_version: u64,
    expected_bytes: usize,
) -> Result<Value, &'static str> {
    wait_for_input(app, |input| {
        input["controlSequence"]
            .as_u64()
            .is_some_and(|value| value > after_sequence)
            && input["valueVersion"]
                .as_u64()
                .is_some_and(|value| value > after_version)
            && input["valueBytes"].as_u64() == Some(expected_bytes as u64)
    })
    .await
}

async fn wait_for_generation(
    app: &AppHandle<Wry>,
    old_generation: u64,
) -> Result<Value, &'static str> {
    wait_for_input(app, |input| {
        input["generation"]
            .as_u64()
            .is_some_and(|value| value > old_generation)
            && input["visible"].as_bool() == Some(true)
    })
    .await
}

async fn wait_for_input(
    app: &AppHandle<Wry>,
    predicate: impl Fn(&Value) -> bool,
) -> Result<Value, &'static str> {
    let deadline = tokio::time::Instant::now() + INPUT_TIMEOUT;
    loop {
        let snapshot = runtime_snapshot(app)?;
        let input = snapshot["subInput"].clone();
        if predicate(&input) {
            return Ok(input);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("settings-input-native-state-invalid");
        }
        tokio::time::sleep(schema::POLL_INTERVAL).await;
    }
}

fn main_input_evidence_ok(evidence: &Value, query: &str) -> bool {
    bool_field(evidence, "inputFound")
        && bool_field(evidence, "eventDispatched")
        && bool_field(evidence, "valueMatches")
        && evidence["inputEmpty"].as_bool() == Some(query.is_empty())
}

fn unchanged_sub_input(before: &Value, after: &Value) -> bool {
    [
        "generation",
        "revision",
        "valueVersion",
        "controlSequence",
        "userSequence",
        "valueBytes",
        "visible",
    ]
    .into_iter()
    .all(|field| before.get(field) == after.get(field))
}

fn bool_field(value: &Value, key: &str) -> bool {
    value[key].as_bool() == Some(true)
}

fn count(value: &Value, key: &str) -> Result<u64, &'static str> {
    value[key]
        .as_u64()
        .ok_or("settings-input-native-state-invalid")
}
