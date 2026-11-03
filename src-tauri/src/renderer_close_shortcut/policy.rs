//! Native policy is a projection of General settings, never a second persistence store.
use serde_json::Value;
use std::time::{Duration, Instant};
pub(super) const REJECTED: &str = "SETTINGS_CLOSE_SHORTCUT_REJECTED";
pub(super) const UNSUPPORTED: &str = "SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED";
pub(super) const RECOVERY: &str = "SETTINGS_NATIVE_RECOVERY_FAILED";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) enabled: bool,
    pub(crate) generation: u64,
}
pub(crate) fn enabled(raw: Option<&str>) -> bool {
    raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get("builtinAppShortcutsEnabled")?
                .get("closePlugin")?
                .as_bool()
        })
        .unwrap_or(true)
}
#[derive(Default)]
pub(super) struct CloseGuard {
    closing: Option<String>,
    after_close: Option<Instant>,
    completed: Option<String>,
}
impl CloseGuard {
    pub(super) fn begin(&mut self, id: &str) -> bool {
        if self.closing.is_some() || self.completed.as_deref() == Some(id) {
            return false;
        }
        self.closing = Some(id.into());
        true
    }
    pub(super) fn complete(
        &mut self,
        id: &str,
        current_id: &str,
        reason: &str,
        succeeded: bool,
        now: Instant,
    ) -> bool {
        if id != current_id {
            return false;
        }
        if self.closing.as_deref() == Some(id) {
            self.closing = None;
        }
        if !succeeded
            || !matches!(reason, "child-out" | "escape")
            || self.completed.as_deref() == Some(id)
        {
            return false;
        }
        self.closing = None;
        self.completed = Some(id.into());
        self.after_close = Some(now + Duration::from_millis(100));
        true
    }
    pub(super) fn abandon(&mut self, id: &str) {
        if self.closing.as_deref() == Some(id) {
            self.closing = None;
        }
    }
    pub(super) fn suppress_hide(&self, now: Instant) -> bool {
        self.closing.is_some() || self.after_close.is_some_and(|deadline| now < deadline)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_false_only_disables_and_default_is_true() {
        for raw in [
            None,
            Some("{}"),
            Some(r#"{"builtinAppShortcutsEnabled":{"closePlugin":null}}"#),
        ] {
            assert!(enabled(raw));
        }
        assert!(!enabled(Some(
            r#"{"builtinAppShortcutsEnabled":{"closePlugin":false}}"#
        )));
    }
    #[test]
    fn closing_coalesces_and_completion_protects_exactly_one_hundred_ms() {
        let mut guard = CloseGuard::default();
        let now = Instant::now();
        assert!(guard.begin("a"));
        assert!(!guard.begin("b"));
        assert!(guard.suppress_hide(now));
        guard.complete("b", "a", "child-out", true, now);
        assert!(guard.suppress_hide(now));
        guard.complete("a", "a", "child-out", true, now);
        assert!(guard.suppress_hide(now + Duration::from_millis(99)));
        assert!(!guard.suppress_hide(now + Duration::from_millis(100)));
    }
    #[test]
    fn normal_child_out_and_escape_complete_without_a_native_menu_reservation() {
        for reason in ["child-out", "escape"] {
            let mut guard = CloseGuard::default();
            let now = Instant::now();
            assert!(guard.complete("a", "a", reason, true, now));
            assert!(guard.suppress_hide(now + Duration::from_millis(99)));
            assert!(!guard.suppress_hide(now + Duration::from_millis(100)));
            assert!(!guard.complete("a", "a", reason, true, now + Duration::from_millis(90)));
            assert!(!guard.suppress_hide(now + Duration::from_millis(100)));
        }
    }
    #[test]
    fn failed_or_old_session_completion_cannot_change_current_guard() {
        let mut guard = CloseGuard::default();
        let now = Instant::now();
        assert!(guard.begin("a"));
        assert!(!guard.complete("a", "a", "child-out", false, now));
        assert!(!guard.suppress_hide(now));
        assert!(guard.begin("b"));
        assert!(!guard.complete("a", "b", "escape", true, now));
        guard.abandon("a");
        assert!(guard.suppress_hide(now));
        assert!(guard.complete("b", "b", "escape", true, now));
        guard.abandon("a");
        assert!(guard.suppress_hide(now + Duration::from_millis(99)));
    }
}
