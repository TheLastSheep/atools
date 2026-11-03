//! Deferred approval/open lifecycle boundaries for display sessions.
use super::tests::fixture;

#[tokio::test]
async fn deferred_grant_transfers_run_to_session_then_retires_intent_once() {
    let (_, plugin, binding, runtime) = fixture();
    let intent = runtime
        .intent_with_document("owner".into(), plugin.id.clone(), binding.clone(), None)
        .unwrap();
    *runtime.store.lock().intents[&intent].run.lock() = Some("run-deferred".into());
    let opener_run = runtime.store.lock().intents[&intent].run.clone();

    let session = runtime.open(&intent, &plugin, &binding).unwrap();
    assert!(std::sync::Arc::ptr_eq(&opener_run, &session.opener_run));
    runtime.complete_open(&intent, &session.id).unwrap();

    assert_eq!(runtime.store.lock().intents.len(), 0);
    assert_eq!(session.opener_run.lock().as_deref(), Some("run-deferred"));
    assert!(session.opening_intent.lock().is_none());
    assert!(runtime.open(&intent, &plugin, &binding).is_err());
    assert!(runtime.complete_open(&intent, &session.id).is_err());
}

#[tokio::test]
async fn consumed_success_does_not_use_pending_capacity_and_close_preserves_other_owner() {
    let (_, plugin, binding, runtime) = fixture();
    let intent = runtime
        .intent_with_document(
            "completed-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    *runtime.store.lock().intents[&intent].run.lock() = Some("completed-run".into());
    let session = runtime.open(&intent, &plugin, &binding).unwrap();
    runtime.complete_open(&intent, &session.id).unwrap();

    let unrelated = runtime
        .intent_with_document(
            "unrelated-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    *runtime.store.lock().intents[&unrelated].run.lock() = Some("unrelated-run".into());
    for index in 0..31 {
        runtime
            .intent_with_document(
                format!("pending-{index}"),
                plugin.id.clone(),
                binding.clone(),
                None,
            )
            .unwrap();
    }
    assert_eq!(runtime.store.lock().intents.len(), 32);
    assert!(runtime
        .intent_with_document(
            "over-capacity".into(),
            plugin.id.clone(),
            binding.clone(),
            None
        )
        .is_err());

    let runs = runtime
        .close(Some("completed-owner"), Some(&plugin.id), false)
        .await;
    assert_eq!(runs, vec!["completed-run".to_string()]);
    assert!(runtime.store.lock().intents.contains_key(&unrelated));
    assert_eq!(runtime.store.lock().sessions.len(), 0);
}

#[tokio::test]
async fn rotations_keep_one_lineage_run_without_a_permanent_open_count_cap() {
    let (_, plugin, binding, runtime) = fixture();
    let root = "lineage-0".to_string();
    let intent = runtime
        .intent_with_document(root.clone(), plugin.id.clone(), binding.clone(), None)
        .unwrap();
    *runtime.store.lock().intents[&intent].run.lock() = Some("lineage-run".into());
    let first = runtime.open(&intent, &plugin, &binding).unwrap();
    runtime.complete_open(&intent, &first.id).unwrap();

    let mut owner = root.clone();
    let mut session = first;
    for index in 1..=40 {
        let next = format!("lineage-{index}");
        runtime
            .rotate(&owner, &next, &plugin.id, &[session.id.clone()])
            .unwrap();
        session = runtime
            .store
            .lock()
            .sessions
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(session.opener_run.lock().as_deref(), Some("lineage-run"));
        assert!(session.opening_intent.lock().is_none());
        owner = next;
    }
    assert_eq!(runtime.store.lock().intents.len(), 0);
    assert_eq!(
        runtime.close(Some(&root), Some(&plugin.id), false).await,
        vec!["lineage-run".to_string()]
    );
}

#[tokio::test]
async fn completion_rejects_a_different_session_even_for_matching_owner_and_plugin() {
    let (_, plugin, binding, runtime) = fixture();
    let first_intent = runtime
        .intent_with_document(
            "same-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    *runtime.store.lock().intents[&first_intent].run.lock() = Some("run-a".into());
    let first = runtime.open(&first_intent, &plugin, &binding).unwrap();
    let second_intent = format!("{first_intent}-different");
    let mut duplicate = runtime.store.lock().intents[&first_intent].clone();
    duplicate.cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    duplicate.claimed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    duplicate.run = std::sync::Arc::new(parking_lot::Mutex::new(Some("run-b".into())));
    runtime
        .store
        .lock()
        .intents
        .insert(second_intent.clone(), duplicate);

    assert!(runtime.complete_open(&second_intent, &first.id).is_err());
    assert!(runtime.complete_open(&first_intent, &first.id).is_ok());
    assert!(!runtime.store.lock().intents.contains_key(&first_intent));
    assert!(runtime.store.lock().intents.contains_key(&second_intent));
}

#[tokio::test]
async fn owner_close_wins_open_completion_race_without_orphaning_run_or_session() {
    let (_, plugin, binding, runtime) = fixture();
    let intent = runtime
        .intent_with_document(
            "closing-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    *runtime.store.lock().intents[&intent].run.lock() = Some("racing-run".into());
    let session = runtime.open(&intent, &plugin, &binding).unwrap();

    let runs = runtime
        .close(Some("closing-owner"), Some(&plugin.id), false)
        .await;
    assert_eq!(runs, vec!["racing-run".to_string()]);
    assert!(runtime.complete_open(&intent, &session.id).is_err());
    assert_eq!(runtime.store.lock().intents.len(), 0);
    assert_eq!(runtime.store.lock().sessions.len(), 0);
    assert!(!*session.active.lock());
}

#[tokio::test]
async fn failed_transport_open_retires_exact_intent_and_allows_immediate_retry() {
    let (_, plugin, binding, runtime) = fixture();
    let failed_intent = runtime
        .intent_with_document(
            "retry-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    *runtime.store.lock().intents[&failed_intent].run.lock() = Some("failed-run".into());
    let failed_session = runtime.open(&failed_intent, &plugin, &binding).unwrap();

    // Models transport::ensure_server returning an error. The failed TaskRun
    // receives that error from execute; abort_open must not cancel it again.
    assert!(runtime.abort_open(&failed_intent, &failed_session.id).await);
    assert!(!*failed_session.active.lock());
    assert!(!runtime.store.lock().intents.contains_key(&failed_intent));
    assert!(runtime.store.lock().sessions.is_empty());

    let retry_intent = runtime
        .intent_with_document(
            "retry-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    *runtime.store.lock().intents[&retry_intent].run.lock() = Some("retry-run".into());
    let retry_session = runtime.open(&retry_intent, &plugin, &binding).unwrap();
    runtime
        .complete_open(&retry_intent, &retry_session.id)
        .unwrap();
    assert_eq!(runtime.store.lock().intents.len(), 0);
    assert_eq!(
        retry_session.opener_run.lock().as_deref(),
        Some("retry-run")
    );
}

#[tokio::test]
async fn abort_after_owner_close_is_noop_and_does_not_duplicate_cancellation() {
    let (_, plugin, binding, runtime) = fixture();
    let intent = runtime
        .intent_with_document(
            "close-race-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    *runtime.store.lock().intents[&intent].run.lock() = Some("close-race-run".into());
    let session = runtime.open(&intent, &plugin, &binding).unwrap();

    let cancelled = runtime
        .close(Some("close-race-owner"), Some(&plugin.id), false)
        .await;
    assert_eq!(cancelled, vec!["close-race-run".to_string()]);
    assert!(!runtime.abort_open(&intent, &session.id).await);
    assert!(runtime.store.lock().intents.is_empty());
    assert!(runtime.store.lock().sessions.is_empty());
    assert!(!*session.active.lock());
}

#[tokio::test]
async fn abort_rejects_wrong_intent_and_preserves_other_authorization() {
    let (_, plugin, binding, runtime) = fixture();
    let intent = runtime
        .intent_with_document(
            "same-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    *runtime.store.lock().intents[&intent].run.lock() = Some("real-run".into());
    let session = runtime.open(&intent, &plugin, &binding).unwrap();
    let unrelated = runtime
        .intent_with_document(
            "other-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();

    assert!(!runtime.abort_open(&unrelated, &session.id).await);
    assert!(runtime.store.lock().intents.contains_key(&intent));
    assert!(runtime.store.lock().intents.contains_key(&unrelated));
    assert!(runtime.store.lock().sessions.contains_key(&session.id));

    assert!(runtime.abort_open(&intent, &session.id).await);
    assert!(!runtime.store.lock().intents.contains_key(&intent));
    assert!(runtime.store.lock().intents.contains_key(&unrelated));
    assert!(!*session.active.lock());
}

#[tokio::test]
async fn failed_completion_aborts_only_the_original_opening_intent() {
    let (_, plugin, binding, runtime) = fixture();
    let intent = runtime
        .intent_with_document(
            "completion-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    *runtime.store.lock().intents[&intent].run.lock() = Some("opening-run".into());
    let session = runtime.open(&intent, &plugin, &binding).unwrap();
    let unrelated = format!("{intent}-other");
    let mut wrong = runtime.store.lock().intents[&intent].clone();
    wrong.cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    wrong.claimed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    wrong.run = std::sync::Arc::new(parking_lot::Mutex::new(Some("different-run".into())));
    runtime
        .store
        .lock()
        .intents
        .insert(unrelated.clone(), wrong);

    assert!(runtime.complete_open(&unrelated, &session.id).is_err());
    assert!(!runtime.abort_open(&unrelated, &session.id).await);
    assert!(runtime.abort_open(&intent, &session.id).await);
    assert!(!runtime.store.lock().intents.contains_key(&intent));
    assert!(runtime.store.lock().intents.contains_key(&unrelated));
    assert!(runtime.store.lock().sessions.is_empty());
}

#[tokio::test]
async fn duplicate_session_rejection_does_not_claim_authorization_before_retry() {
    let (_, plugin, binding, runtime) = fixture();
    let first_intent = runtime
        .intent_with_document(
            "duplicate-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    let first = runtime.open(&first_intent, &plugin, &binding).unwrap();
    runtime.complete_open(&first_intent, &first.id).unwrap();

    let retry_intent = runtime
        .intent_with_document(
            "duplicate-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    assert!(runtime.open(&retry_intent, &plugin, &binding).is_err());
    assert!(!runtime.store.lock().intents[&retry_intent]
        .claimed
        .load(std::sync::atomic::Ordering::Acquire));

    runtime.remove(&first.id).await;
    let retry = runtime.open(&retry_intent, &plugin, &binding).unwrap();
    runtime.complete_open(&retry_intent, &retry.id).unwrap();
    assert!(retry.opener_run.lock().is_none());
}

#[tokio::test]
async fn capacity_rejection_does_not_claim_authorization_before_retry() {
    let (_, plugin, binding, runtime) = fixture();
    let mut sessions = Vec::new();
    for index in 0..32 {
        let intent = runtime
            .intent_with_document(
                format!("capacity-owner-{index}"),
                plugin.id.clone(),
                binding.clone(),
                None,
            )
            .unwrap();
        let session = runtime.open(&intent, &plugin, &binding).unwrap();
        runtime.complete_open(&intent, &session.id).unwrap();
        sessions.push(session);
    }

    let retry_intent = runtime
        .intent_with_document(
            "capacity-retry-owner".into(),
            plugin.id.clone(),
            binding.clone(),
            None,
        )
        .unwrap();
    assert!(runtime.open(&retry_intent, &plugin, &binding).is_err());
    assert!(!runtime.store.lock().intents[&retry_intent]
        .claimed
        .load(std::sync::atomic::Ordering::Acquire));

    runtime.remove(&sessions.pop().unwrap().id).await;
    let retry = runtime.open(&retry_intent, &plugin, &binding).unwrap();
    runtime.complete_open(&retry_intent, &retry.id).unwrap();
    assert!(retry.opening_intent.lock().is_none());
}
