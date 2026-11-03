use super::*;
use serde_json::json;

fn owner() -> Owner {
    Owner::new(
        "main",
        "fixture-plugin",
        "9fe6b202-0c8b-4b9b-b320-c8c64e0bfeef",
    )
    .unwrap()
}

fn owner_with_instance(index: u8) -> Owner {
    Owner::new(
        "main",
        "fixture-plugin",
        &format!("9fe6b202-0c8b-4b9b-b320-c8c64e0bfe{index:02x}"),
    )
    .unwrap()
}

fn try_reserve_for(
    runtime: &Runtime,
    owner: Owner,
    window_id: &str,
) -> Result<Arc<NativeWindow>, String> {
    let intent = runtime
        .create_open_intent(
            owner,
            "source-a".into(),
            window_id.into(),
            json!({"width":700,"height":400}),
            true,
        )
        .unwrap();
    intent.set_run(&format!("run-{}", intent.id)).unwrap();
    let spec = match intent.payload.lock().as_ref().unwrap() {
        Payload::Open { spec: Some(spec) } => spec.clone(),
        _ => unreachable!(),
    };
    let ticket = format!("ticket-{}", intent.id);
    let url = format!("tauri://localhost/atools-native-window.html#{ticket}");
    match runtime.reserve(&intent, "main".into(), url, ticket, spec) {
        Ok((window, _)) => Ok(window),
        Err(error) => {
            runtime.cancel_intent(&intent.id, "reservation rejected");
            Err(error)
        }
    }
}

fn reserve_error(runtime: &Runtime, owner: Owner, window_id: &str) -> String {
    try_reserve_for(runtime, owner, window_id)
        .err()
        .expect("reservation must be rejected")
}

fn reserve_for(runtime: &Runtime, owner: Owner, window_id: &str) -> Arc<NativeWindow> {
    try_reserve_for(runtime, owner, window_id).unwrap()
}

fn reserve(runtime: &Runtime, window_id: &str) -> Arc<NativeWindow> {
    reserve_for(runtime, owner(), window_id)
}

fn consume_reservation(runtime: &Runtime, window: &NativeWindow) {
    let intent = runtime.intent(&window.intent_id).unwrap();
    let ticket = format!("ticket-{}", intent.id);
    let url = format!("tauri://localhost/atools-native-window.html#{ticket}");
    let run_id = intent.run_id.lock().clone().unwrap();
    assert!(runtime
        .consume_reservation("main", &url, &window.creator_binding_id, &run_id)
        .is_some());
}

fn activate_for(runtime: &Runtime, owner: Owner, window_id: &str) -> Arc<NativeWindow> {
    let window = reserve_for(runtime, owner, window_id);
    consume_reservation(runtime, &window);
    runtime.mark_loaded(&window.native_label).unwrap();
    window
}

fn activate(runtime: &Runtime, window_id: &str) -> Arc<NativeWindow> {
    activate_for(runtime, owner(), window_id)
}

#[test]
fn frontend_id_stays_reserved_until_real_destroyed_and_close_run_survives_cascade() {
    let runtime = Runtime::default();
    let window = reserve(&runtime, "same-id");
    let label = window.native_label.clone();
    let intent = runtime.intent(&window.intent_id).unwrap();
    let ticket = format!("ticket-{}", intent.id);
    let url = format!("tauri://localhost/atools-native-window.html#{ticket}");
    assert!(runtime
        .consume_reservation(
            "main",
            &url,
            "source-a",
            &intent.run_id.lock().clone().unwrap()
        )
        .is_some());
    assert!(runtime.mark_loaded(&label).is_some());
    assert!(runtime.finish_intent(&intent, Ok(json!({"opened":true}))));

    let duplicate = runtime
        .create_open_intent(
            owner(),
            "source-a".into(),
            "same-id".into(),
            json!({}),
            true,
        )
        .unwrap();
    duplicate.set_run("run-duplicate").unwrap();
    let duplicate_spec = match duplicate.payload.lock().as_ref().unwrap() {
        Payload::Open { spec: Some(spec) } => spec.clone(),
        _ => unreachable!(),
    };
    let duplicate_ticket = format!("ticket-{}", duplicate.id);
    let error = runtime
        .reserve(
            &duplicate,
            "main".into(),
            format!("tauri://localhost/atools-native-window.html#{duplicate_ticket}"),
            duplicate_ticket,
            duplicate_spec,
        )
        .err()
        .expect("duplicate frontend ID must be rejected");
    assert!(
        error.contains("ID already exists"),
        "unexpected duplicate ID error: {error}"
    );
    runtime.cancel_intent(&duplicate.id, "duplicate check complete");

    let close = runtime
        .create_action_intent(
            owner(),
            "source-a".into(),
            "same-id".into(),
            "destroy".into(),
            Vec::new(),
            true,
        )
        .unwrap();
    close.set_run("run-close").unwrap();
    close.set_state(IntentState::Running);
    let sibling = runtime
        .create_action_intent(
            owner(),
            "source-b".into(),
            "same-id".into(),
            "show".into(),
            Vec::new(),
            true,
        )
        .unwrap();
    sibling.set_run("run-sibling").unwrap();

    runtime.begin_expected_close(&label, "run-close").unwrap();
    let closing_duplicate = runtime
        .create_open_intent(
            owner(),
            "source-a".into(),
            "same-id".into(),
            json!({}),
            true,
        )
        .unwrap();
    closing_duplicate.set_run("run-closing-duplicate").unwrap();
    let closing_spec = match closing_duplicate.payload.lock().as_ref().unwrap() {
        Payload::Open { spec: Some(spec) } => spec.clone(),
        _ => unreachable!(),
    };
    let closing_ticket = format!("ticket-{}", closing_duplicate.id);
    let closing_error = runtime
        .reserve(
            &closing_duplicate,
            "main".into(),
            format!("tauri://localhost/atools-native-window.html#{closing_ticket}"),
            closing_ticket,
            closing_spec,
        )
        .err()
        .expect("closing frontend ID must remain reserved");
    assert!(
        closing_error.contains("ID already exists"),
        "unexpected close-race ID error: {closing_error}"
    );
    runtime.cancel_intent(&closing_duplicate.id, "close race check complete");
    let (destroyed, expected, cancelled) = runtime.remove_destroyed(&label).unwrap();
    assert_eq!(expected.as_deref(), Some("run-close"));
    assert_eq!(destroyed.frontend_window_id, "same-id");
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].id, sibling.id);
    assert_eq!(close.state(), IntentState::Running);
    assert!(runtime
        .store
        .lock()
        .protected_close_runs
        .contains("run-close"));
    runtime.clear_protected_close("run-close");

    let after_destroy = reserve(&runtime, "same-id");
    assert_ne!(after_destroy.native_label, label);
}

#[test]
fn manager_selects_the_exact_target_among_same_owner_windows() {
    let runtime = Runtime::default();
    let first = activate(&runtime, "window-first");
    let second = activate(&runtime, "window-second");

    let selected = runtime
        .window_for_identity(&owner(), true, "source-a", "main", "window-second")
        .unwrap();
    assert_eq!(selected.native_label, second.native_label);
    assert_ne!(selected.native_label, first.native_label);
    assert!(runtime
        .window_for_identity(&owner(), true, "source-a", "main", "missing-window")
        .is_err());

    let self_source = runtime
        .window_for_identity(
            &owner(),
            true,
            "source-self-first",
            "child:window-first",
            "window-first",
        )
        .unwrap();
    assert_eq!(self_source.native_label, first.native_label);
    assert!(
        runtime
            .window_for_identity(
                &owner(),
                true,
                "source-self-first",
                "child:window-first",
                "window-second",
            )
            .is_err(),
        "a self-frame source must not control sibling windows"
    );
}

#[test]
fn source_navigation_preserves_native_top_but_creator_revocation_closes_it() {
    let runtime = Runtime::default();
    let window = activate(&runtime, "window-child");
    let completed_child_action = runtime
        .create_action_intent(
            owner(),
            "child-doc-old".into(),
            "window-child".into(),
            "show".into(),
            Vec::new(),
            true,
        )
        .unwrap();
    completed_child_action
        .set_run("run-completed-child-action")
        .unwrap();
    runtime.finish_intent(&completed_child_action, Ok(json!({"done":true})));
    let pending_child_action = runtime
        .create_action_intent(
            owner(),
            "child-doc-old".into(),
            "window-child".into(),
            "focus".into(),
            Vec::new(),
            true,
        )
        .unwrap();
    pending_child_action
        .set_run("run-pending-child-action")
        .unwrap();

    let (cancelled, closed_windows, _) = runtime.close_sources(&["child-doc-old".into()]);
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].id, pending_child_action.id);
    assert!(
        closed_windows.is_empty(),
        "iframe navigation must preserve its native top-level"
    );
    assert!(runtime.window(&window.native_label).is_some());
    assert!(
        runtime.intent(&completed_child_action.id).is_err(),
        "source close must drop completed private handoffs"
    );
    assert!(
        runtime.intent(&pending_child_action.id).is_err(),
        "source close must drop cancelled intents"
    );

    let (_, creator_windows, _) = runtime.close_sources(&["source-a".into()]);
    assert_eq!(
        creator_windows.len(),
        1,
        "revoking the creating source must close its owned window"
    );
    assert_eq!(creator_windows[0].native_label, window.native_label);
}

#[test]
fn repeated_cancel_and_source_replacement_releases_the_intent_budget() {
    let runtime = Runtime::default();
    for index in 0..40 {
        let source = format!("replaceable-source-{index}");
        let intent = runtime
            .create_action_intent(
                owner(),
                source.clone(),
                format!("window-{index}"),
                "show".into(),
                Vec::new(),
                true,
            )
            .unwrap();
        intent.set_run(&format!("run-{index}")).unwrap();
        if index % 2 == 0 {
            runtime.finish_intent(&intent, Ok(json!({"completed":true})));
        }
        runtime.close_sources(&[source]);
        assert!(runtime.intent(&intent.id).is_err());
    }
    let next = runtime.create_action_intent(
        owner(),
        "fresh-source".into(),
        "fresh-window".into(),
        "show".into(),
        Vec::new(),
        true,
    );
    assert!(
        next.is_ok(),
        "more than 32 cancelled/replaced sources must not exhaust the intent budget"
    );
}

#[test]
fn abandoned_close_timeout_keeps_destroying_budget_until_real_destroyed() {
    let runtime = Runtime::default();
    let window = activate(&runtime, "timeout-close");
    let close = runtime
        .create_action_intent(
            owner(),
            "source-a".into(),
            "timeout-close".into(),
            "destroy".into(),
            Vec::new(),
            true,
        )
        .unwrap();
    close.set_run("run-timeout-close").unwrap();
    assert!(close.set_state(IntentState::Running));
    runtime
        .begin_expected_close(&window.native_label, "run-timeout-close")
        .unwrap();

    assert!(runtime
        .abandon_expected_close(&window.native_label, "run-timeout-close")
        .is_some());
    assert_eq!(*window.life.lock(), WindowLife::Destroying);
    assert!(runtime.window(&window.native_label).is_some());
    assert!(runtime
        .window_for_identity(&owner(), true, "source-a", "main", "timeout-close")
        .is_err());
    assert!(!runtime
        .store
        .lock()
        .expected_close_runs
        .contains_key(&window.native_label));

    assert!(runtime.finish_intent(&close, Err("close timed out".into())));
    let (destroyed, expected, _) = runtime.remove_destroyed(&window.native_label).unwrap();
    assert_eq!(destroyed.native_label, window.native_label);
    assert_eq!(expected, None);
    assert!(runtime.window(&window.native_label).is_none());

    let replacement = reserve(&runtime, "timeout-close");
    assert_ne!(replacement.native_label, window.native_label);
}

#[test]
fn owner_and_global_budgets_count_all_lifecycles_until_real_destroyed() {
    let runtime = Runtime::default();
    let owner_one = owner_with_instance(1);
    let unconsumed = reserve_for(&runtime, owner_one.clone(), "budget-unconsumed");
    let creating = reserve_for(&runtime, owner_one.clone(), "budget-creating");
    consume_reservation(&runtime, &creating);
    let marked_destroying = activate_for(&runtime, owner_one.clone(), "budget-marked");
    let close_requested = activate_for(&runtime, owner_one.clone(), "budget-close");
    assert_eq!(*unconsumed.life.lock(), WindowLife::Creating);
    assert_eq!(*creating.life.lock(), WindowLife::Creating);
    assert_eq!(*marked_destroying.life.lock(), WindowLife::Alive);
    assert_eq!(*close_requested.life.lock(), WindowLife::Alive);
    let owner_limit = reserve_error(&runtime, owner_one.clone(), "budget-owner-limit");
    assert!(owner_limit.contains("Native BrowserWindow limit reached"));
    runtime
        .mark_destroying(&marked_destroying.native_label)
        .expect("markDestroying keeps the record allocated");
    runtime
        .begin_expected_close(&close_requested.native_label, "run-budget-close")
        .expect("a close request keeps the record allocated");
    assert_eq!(*marked_destroying.life.lock(), WindowLife::Destroying);
    assert_eq!(*close_requested.life.lock(), WindowLife::Destroying);
    let owner_limit_after_close = reserve_error(
        &runtime,
        owner_one.clone(),
        "budget-owner-limit-after-close",
    );
    assert!(owner_limit_after_close.contains("Native BrowserWindow limit reached"));
    runtime
        .remove_destroyed(&marked_destroying.native_label)
        .expect("only real Destroyed releases the allocated slot");
    let owner_replacement = reserve_for(&runtime, owner_one, "budget-after-destroyed");
    assert_ne!(
        owner_replacement.native_label,
        marked_destroying.native_label
    );
    let owner_two = owner_with_instance(2);
    let mut owner_two_windows = Vec::new();
    for index in 0..4 {
        let window = reserve_for(
            &runtime,
            owner_two.clone(),
            &format!("global-owner-two-{index}"),
        );
        if index == 0 {
            consume_reservation(&runtime, &window);
        }
        owner_two_windows.push(window);
    }
    for owner_index in [3, 4] {
        let other_owner = owner_with_instance(owner_index);
        for index in 0..4 {
            reserve_for(
                &runtime,
                other_owner.clone(),
                &format!("global-owner-{owner_index}-{index}"),
            );
        }
    }
    let global_limit = reserve_error(&runtime, owner_with_instance(5), "budget-global-limit");
    assert!(global_limit.contains("Native BrowserWindow limit reached"));
    runtime
        .remove_destroyed(&owner_two_windows[0].native_label)
        .expect("a consumed Creating window is retained until its real Destroyed callback");
    let global_replacement = reserve_for(
        &runtime,
        owner_with_instance(5),
        "budget-global-after-destroyed",
    );
    assert_ne!(
        global_replacement.native_label,
        owner_two_windows[0].native_label
    );
}

#[test]
fn cancelled_intent_cannot_be_rebound_restarted_or_completed() {
    let runtime = Runtime::default();
    let intent = runtime
        .create_action_intent(
            owner(),
            "source-cancel-race".into(),
            "window-cancel-race".into(),
            "show".into(),
            Vec::new(),
            true,
        )
        .unwrap();
    intent.set_run("run-cancel-race").unwrap();
    assert!(runtime.cancel_intent(&intent.id, "cancel wins").is_some());
    assert_eq!(intent.state(), IntentState::Cancelled);
    assert!(intent.set_run("run-late-rebind").is_err());
    assert!(!intent.set_state(IntentState::Running));
    assert!(!intent.complete(Ok(json!({"late":true}))));
    assert_eq!(intent.state(), IntentState::Cancelled);
    assert!(matches!(intent.result.lock().as_ref(), Some(Err(reason)) if reason == "cancel wins"));

    let completed = runtime
        .create_action_intent(
            owner(),
            "source-complete-race".into(),
            "window-complete-race".into(),
            "show".into(),
            Vec::new(),
            true,
        )
        .unwrap();
    assert!(runtime.finish_intent(&completed, Ok(json!({"ok":true}))));
    assert!(completed.set_run("run-too-late").is_err());
    assert!(!completed.set_state(IntentState::Running));
    assert!(!completed.cancel("late cancellation"));
    assert_eq!(completed.state(), IntentState::Complete);
}
