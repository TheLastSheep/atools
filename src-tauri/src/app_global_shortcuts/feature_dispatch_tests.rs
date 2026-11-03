use super::*;
use crate::app_global_shortcuts::recording_gate::Gate;
use crate::hotkey::recording::Target;

#[derive(Clone, PartialEq, Eq)]
struct FakeOwner(u8);
impl OwnerIdentity for FakeOwner { fn matches(&self, other: &Self) -> bool { self == other } }
fn target() -> Target {
    Target { session_id: "session".into(), label: "child".into(), origin: "local".into(), bundle_revision: "rev".into(), visibility_epoch: 0 }
}
fn fixture() -> (Arc<Gate>, Arc<Receipt>, Ledger<FakeOwner>, String, u64) {
    let gate = Arc::new(Gate::default());
    let receipt = gate.receipt(None).unwrap();
    receipt.publish();
    let epoch = receipt.edge(true).unwrap();
    let permit = Arc::new(receipt.admit(epoch).unwrap());
    receipt.edge(false);
    let ledger = Ledger::<FakeOwner>::default();
    let id = ledger.offer(FakeOwner(1), "code".into(), "plugin".into(), Arc::downgrade(&receipt), epoch, permit).unwrap();
    (gate, receipt, ledger, id, epoch)
}
#[test]
fn cancel_offer_wins_over_delayed_consumer() {
    let (gate, _receipt, ledger, id, _) = fixture();
    ledger.remove_where(|ticket| !ticket.claimed);
    assert!(gate.start(target(), 1).is_ok());
    assert!(ledger.claim(&FakeOwner(1), &id, "code", Some("plugin")).is_err());
}
#[test]
fn claimed_native_future_remains_busy_after_ui_completes() {
    let (gate, _receipt, ledger, id, _) = fixture();
    let native_future = ledger.claim(&FakeOwner(1), &id, "code", Some("plugin")).unwrap();
    ledger.remove_where(|ticket| !ticket.claimed);
    assert!(gate.start(target(), 1).is_err());
    assert!(ledger.complete(&FakeOwner(1), &id, "committed").is_ok());
    assert!(ledger.complete(&FakeOwner(1), &id, "committed").is_ok());
    assert!(ledger.complete(&FakeOwner(1), &id, "failed").is_err());
    assert!(gate.start(target(), 1).is_err());
    drop(native_future);
    assert!(gate.start(target(), 1).is_ok());
}
#[test]
fn wrong_owner_duplicate_and_retired_registration_cannot_claim() {
    let (_gate, receipt, ledger, id, _) = fixture();
    assert!(ledger.claim(&FakeOwner(2), &id, "code", Some("plugin")).is_err());
    assert!(ledger.claim(&FakeOwner(1), &id, "other", Some("plugin")).is_err());
    assert!(ledger.claim(&FakeOwner(1), &id, "code", Some("other")).is_err());
    receipt.retire();
    assert!(ledger.claim(&FakeOwner(1), &id, "code", Some("plugin")).is_err());
    assert!(ledger.complete(&FakeOwner(2), &id, "failed").is_err());
}
#[test]
fn claim_is_once_and_cancelled_offer_cannot_report_commit() {
    let (_gate, _receipt, ledger, id, _) = fixture();
    assert!(ledger.complete(&FakeOwner(1), &id, "committed").is_err());
    let permit = ledger.claim(&FakeOwner(1), &id, "code", Some("plugin")).unwrap();
    assert!(ledger.claim(&FakeOwner(1), &id, "code", Some("plugin")).is_err());
    drop(permit);
    assert!(ledger.complete(&FakeOwner(1), &id, "failed").is_ok());
}

#[test]
fn malformed_ticket_ids_are_rejected_at_claim_and_completion() {
    let (_gate, _receipt, ledger, _id, _) = fixture();
    for id in ["", "a", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "gggggggggggggggggggggggggggggggg", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] {
        assert!(ledger.claim(&FakeOwner(1), id, "code", Some("plugin")).is_err());
        assert!(ledger.complete(&FakeOwner(1), id, "failed").is_err());
    }
}
