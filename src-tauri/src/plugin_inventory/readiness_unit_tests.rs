use super::{Phase, PluginInventoryReadiness};

#[test]
fn terminal_phase_cannot_be_replaced_by_late_completion() {
    let ready = PluginInventoryReadiness::pending();
    let guard = ready.begin_bootstrap().unwrap();
    guard.complete(Ok(()));
    assert!(!ready.transition(Phase::Failed("late failure")));
    assert_eq!(*ready.inner.phase.borrow(), Phase::Ready);

    let failed = PluginInventoryReadiness::pending();
    let guard = failed.begin_bootstrap().unwrap();
    guard.complete(Err("loader failure".into()));
    assert!(!failed.transition(Phase::Ready));
    assert_eq!(
        *failed.inner.phase.borrow(),
        Phase::Failed("PLUGIN_INVENTORY_BOOTSTRAP_FAILED")
    );
}

#[test]
fn bootstrap_guard_is_single_claim_and_fixture_ready_is_not_reopened() {
    let readiness = PluginInventoryReadiness::pending();
    let _guard = readiness.begin_bootstrap().unwrap();
    assert_eq!(
        readiness.begin_bootstrap().err().unwrap(),
        "PLUGIN_INVENTORY_BOOTSTRAP_ALREADY_STARTED"
    );

    let fixture = PluginInventoryReadiness::prepopulated_ready();
    assert_eq!(
        fixture.begin_bootstrap().err().unwrap(),
        "PLUGIN_INVENTORY_BOOTSTRAP_ALREADY_STARTED"
    );
}
