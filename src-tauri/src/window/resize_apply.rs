//! Execute one planned geometry through a platform port; preserve the plan across native anchors.
use tauri::{PhysicalPosition, PhysicalSize, Window};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Geometry {
    pub position: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
}
trait Port {
    type Error;
    fn size(&mut self, size: PhysicalSize<u32>) -> Result<(), Self::Error>;
    fn position(&mut self, position: PhysicalPosition<i32>) -> Result<(), Self::Error>;
    fn rollback_failed(&mut self, stage: &'static str, error: &Self::Error);
}
fn apply_port<P: Port>(port: &mut P, original: Geometry, target: Geometry) -> Result<(), P::Error> {
    // Cocoa may move the top-left while changing content size. Reapply the exact
    // planned position AFTER size even when it matched the pre-resize position.
    port.size(target.size)?;
    if let Err(error) = port.position(target.position) {
        // Requests are asynchronous; this is best-effort compensation, never
        // a claim that the old frame was confirmed restored. Preserve the error.
        if let Err(rollback) = port.size(original.size) {
            port.rollback_failed("size", &rollback);
        }
        if let Err(rollback) = port.position(original.position) {
            port.rollback_failed("position", &rollback);
        }
        return Err(error);
    }
    Ok(())
}

struct NativePort<'a> {
    window: &'a Window,
}
impl Port for NativePort<'_> {
    type Error = tauri::Error;
    fn size(&mut self, size: PhysicalSize<u32>) -> tauri::Result<()> {
        self.window.set_size(tauri::Size::Physical(size))
    }
    fn position(&mut self, position: PhysicalPosition<i32>) -> tauri::Result<()> {
        self.window.set_position(position)
    }
    fn rollback_failed(&mut self, stage: &'static str, error: &Self::Error) {
        tracing::warn!(stage, %error, "main window resize rollback request failed");
    }
}
/// Success means both native requests were accepted, not an actual frame readback.
pub(super) fn apply(window: &Window, original: Geometry, target: Geometry) -> tauri::Result<()> {
    apply_port(&mut NativePort { window }, original, target)
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Backend {
        geometry: Geometry,
        calls: Vec<&'static str>,
        size_calls: u32,
        position_calls: u32,
        fail_size: Option<u32>,
        fail_position: Option<u32>,
        rollback_errors: Vec<&'static str>,
    }
    fn geometry(y: i32, height: u32) -> Geometry {
        Geometry {
            position: PhysicalPosition::new(712, y),
            size: PhysicalSize::new(1600, height),
        }
    }
    fn backend(original: Geometry) -> Backend {
        Backend {
            geometry: original,
            calls: vec![],
            size_calls: 0,
            position_calls: 0,
            fail_size: None,
            fail_position: None,
            rollback_errors: vec![],
        }
    }
    impl Port for Backend {
        type Error = &'static str;
        fn size(&mut self, size: PhysicalSize<u32>) -> Result<(), Self::Error> {
            self.calls.push("size");
            self.size_calls += 1;
            if self.fail_size == Some(self.size_calls) {
                return Err("size-error");
            }
            // Replays candidate4's observed NSWindow boundary, not a universal backend assumption.
            self.geometry.position.y -= size.height as i32 - self.geometry.size.height as i32;
            self.geometry.size = size;
            Ok(())
        }
        fn position(&mut self, position: PhysicalPosition<i32>) -> Result<(), Self::Error> {
            self.calls.push("position");
            self.position_calls += 1;
            if self.fail_position == Some(self.position_calls) {
                return Err("position-error");
            }
            self.geometry.position = position;
            Ok(())
        }
        fn rollback_failed(&mut self, stage: &'static str, _: &Self::Error) {
            self.rollback_errors.push(stage);
        }
    }
    #[test]
    fn observed_apply1_position_then_growth_must_end_at_planned_y() {
        let original = geometry(1216, 122);
        let target = geometry(764, 1200);
        let mut port = backend(original);
        apply_port(&mut port, original, target).unwrap();
        assert_eq!(port.geometry, target);
    }
    #[test]
    fn observed_apply4_equal_original_y_must_be_reapplied_after_growth() {
        let original = geometry(66, 122);
        let target = geometry(66, 1200);
        let mut port = backend(original);
        apply_port(&mut port, original, target).unwrap();
        assert_eq!(port.geometry, target);
    }
    #[test]
    fn shrinking_also_reapplies_the_same_planned_position() {
        let original = geometry(66, 1200);
        let target = geometry(66, 122);
        let mut port = backend(original);
        apply_port(&mut port, original, target).unwrap();
        assert_eq!(port.geometry, target);
        assert_eq!(port.calls, ["size", "position"]);
    }
    #[test]
    fn rejected_size_does_not_send_position_or_claim_success() {
        let original = geometry(66, 122);
        let target = geometry(66, 1200);
        let mut port = backend(original);
        port.fail_size = Some(1);
        assert_eq!(apply_port(&mut port, original, target), Err("size-error"));
        assert_eq!(port.geometry, original);
        assert_eq!(port.calls, ["size"]);
    }
    #[test]
    fn rejected_position_compensates_size_then_position_and_returns_original_error() {
        let original = geometry(1216, 122);
        let target = geometry(764, 1200);
        let mut port = backend(original);
        port.fail_position = Some(1);
        assert_eq!(
            apply_port(&mut port, original, target),
            Err("position-error")
        );
        assert_eq!(port.geometry, original);
        assert_eq!(port.calls, ["size", "position", "size", "position"]);
        assert!(port.rollback_errors.is_empty());
    }
    #[test]
    fn rollback_size_failure_is_visible_and_does_not_skip_position_compensation() {
        let original = geometry(1216, 122);
        let target = geometry(764, 1200);
        let mut port = backend(original);
        port.fail_position = Some(1);
        port.fail_size = Some(2);
        assert_eq!(
            apply_port(&mut port, original, target),
            Err("position-error")
        );
        assert_eq!(port.calls, ["size", "position", "size", "position"]);
        assert_eq!(port.rollback_errors, ["size"]);
        assert_ne!(port.geometry, original); // do not turn accepted rollback requests into restored fact
    }
}
