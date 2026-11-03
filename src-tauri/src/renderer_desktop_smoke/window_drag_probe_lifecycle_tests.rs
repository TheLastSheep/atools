use super::DocumentLifecycle;

#[test]
fn navigation_cannot_be_authorized_before_the_initial_probe() {
    let lifecycle = DocumentLifecycle::new();
    let before = lifecycle.snapshot();

    assert_eq!(
        lifecycle.authorize_navigation(),
        Err("window-drag-navigation-protocol-rejected")
    );
    assert_eq!(lifecycle.snapshot(), before);
    assert!(!lifecycle.mark_resume_probe_injected());
    assert_eq!(
        lifecycle.observe_page_load_started(),
        Err("window-drag-page-load-protocol-poisoned")
    );
    assert_eq!(lifecycle.snapshot(), before);
}

#[test]
fn unrequested_started_event_does_not_commit_state_or_enable_resume() {
    let lifecycle = DocumentLifecycle::new();
    assert!(lifecycle.mark_initial_probe_injected());
    let before = lifecycle.snapshot();

    assert_eq!(
        lifecycle.observe_page_load_started(),
        Err("window-drag-unrequested-page-load-start")
    );
    assert_eq!(lifecycle.snapshot(), before);
    assert_eq!(
        lifecycle.observe_page_load_finished(),
        Err("window-drag-page-load-protocol-poisoned")
    );
    assert_eq!(lifecycle.snapshot(), before);
    assert!(!lifecycle.mark_resume_probe_injected());
}

#[test]
fn unrequested_finished_event_does_not_change_document_or_enable_resume() {
    let lifecycle = DocumentLifecycle::new();
    assert!(lifecycle.mark_initial_probe_injected());
    let before = lifecycle.snapshot();

    assert_eq!(
        lifecycle.observe_page_load_finished(),
        Err("window-drag-unrequested-page-load-finish")
    );
    assert_eq!(lifecycle.snapshot(), before);
    assert_eq!(lifecycle.document_id(), before.document_id);
    assert!(!lifecycle.mark_resume_probe_injected());
}

#[test]
fn authorized_reload_changes_document_once_and_allows_one_resume_injection() {
    let lifecycle = DocumentLifecycle::new();
    assert!(lifecycle.mark_initial_probe_injected());
    let original_document_id = lifecycle.document_id();

    assert_eq!(lifecycle.authorize_navigation(), Ok(()));
    assert_eq!(lifecycle.observe_page_load_started(), Ok(()));
    let started = lifecycle.snapshot();
    assert_eq!(started.document_generation, 0);
    assert_eq!(started.page_load_starts, 1);
    assert_eq!(started.page_load_finishes, 0);
    assert_eq!(started.document_id, original_document_id);

    let finished = lifecycle.observe_page_load_finished().unwrap();
    assert_eq!(finished.document_generation, 1);
    assert_eq!(finished.page_load_starts, 1);
    assert_eq!(finished.page_load_finishes, 1);
    assert_ne!(finished.document_id, original_document_id);
    assert!(lifecycle.mark_resume_probe_injected());
    assert!(!lifecycle.mark_resume_probe_injected());

    let after_finish = lifecycle.snapshot();
    assert_eq!(
        lifecycle.observe_page_load_finished(),
        Err("window-drag-page-load-finish-protocol-rejected")
    );
    assert_eq!(lifecycle.snapshot(), after_finish);
    assert!(!lifecycle.mark_resume_probe_injected());
}

#[test]
fn out_of_order_or_duplicate_started_events_poison_resume_authorization() {
    let out_of_order = DocumentLifecycle::new();
    assert!(out_of_order.mark_initial_probe_injected());
    assert_eq!(out_of_order.authorize_navigation(), Ok(()));
    let before_start = out_of_order.snapshot();
    assert_eq!(
        out_of_order.observe_page_load_finished(),
        Err("window-drag-page-load-finish-protocol-rejected")
    );
    assert_eq!(out_of_order.snapshot(), before_start);
    assert_eq!(
        out_of_order.observe_page_load_started(),
        Err("window-drag-page-load-protocol-poisoned")
    );
    assert_eq!(out_of_order.snapshot(), before_start);
    assert!(!out_of_order.mark_resume_probe_injected());

    let duplicate_start = DocumentLifecycle::new();
    assert!(duplicate_start.mark_initial_probe_injected());
    assert_eq!(duplicate_start.authorize_navigation(), Ok(()));
    assert_eq!(duplicate_start.observe_page_load_started(), Ok(()));
    let after_start = duplicate_start.snapshot();
    assert_eq!(
        duplicate_start.observe_page_load_started(),
        Err("window-drag-page-load-start-protocol-rejected")
    );
    assert_eq!(duplicate_start.snapshot(), after_start);
    assert_eq!(
        duplicate_start.observe_page_load_finished(),
        Err("window-drag-page-load-protocol-poisoned")
    );
    assert_eq!(duplicate_start.snapshot(), after_start);
    assert!(!duplicate_start.mark_resume_probe_injected());
}
