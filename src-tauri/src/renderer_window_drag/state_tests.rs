use super::{DragState, LockInstall, MAX_ACTIVE_OPERATIONS};
use crate::renderer_window_drag::request::WindowSize;
use std::panic::{catch_unwind, AssertUnwindSafe};

#[test]
fn repeated_lock_keeps_original_size_until_resize_and_release() {
    let state = DragState::new();
    let generation = state.try_admit().unwrap().1;
    let original = WindowSize {
        width: 720.0,
        height: 108.0,
    };
    let repeated = WindowSize {
        width: 1440.0,
        height: 216.0,
    };
    assert_eq!(
        state.install_lock(generation, original),
        Ok(LockInstall::Installed)
    );
    assert_eq!(
        state.install_lock(generation, repeated),
        Ok(LockInstall::AlreadyLocked)
    );
    assert_eq!(state.locked_size(generation), Ok(Some(original)));

    let after_window_resize = WindowSize {
        width: 720.0,
        height: 420.0,
    };
    assert_eq!(state.resize_locked_size(after_window_resize), Ok(true));
    // Move operations use the latest captured logical size.
    assert_eq!(state.locked_size(generation), Ok(Some(after_window_resize)));
    assert_eq!(state.release_lock(generation), Ok(true));
    assert_eq!(state.is_locked(), Some(false));
    assert_ne!(state.try_admit().unwrap().1, generation);
}

#[test]
fn clear_invalidates_queued_operations_without_restoring_a_stale_lock() {
    let state = DragState::new();
    let (_, generation) = state.try_admit().unwrap();
    state
        .install_lock(
            generation,
            WindowSize {
                width: 640.0,
                height: 100.0,
            },
        )
        .unwrap();

    assert_eq!(state.invalidate_lock(), Ok(true));
    assert_eq!(
        state.locked_size(generation),
        Err("window drag operation was invalidated")
    );
    assert_eq!(
        state.install_lock(
            generation,
            WindowSize {
                width: 640.0,
                height: 100.0,
            }
        ),
        Ok(LockInstall::Invalidated)
    );
    assert_eq!(state.is_locked(), Some(false));
}

#[test]
fn admission_is_bounded_and_permits_live_until_their_owner_releases_them() {
    let state = DragState::new();
    let held = (0..MAX_ACTIVE_OPERATIONS)
        .map(|_| state.try_admit().unwrap().0)
        .collect::<Vec<_>>();
    assert_eq!(
        state.try_admit().err(),
        Some("window drag operation capacity is exhausted")
    );

    drop(held);
    assert!(state.try_admit().is_ok());
}

#[test]
fn poisoned_state_is_unknown_to_read_only_lock_observers() {
    let state = DragState::new();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let _guard = state.geometry.lock().unwrap();
        panic!("poison fixture");
    }));
    assert!(result.is_err());
    assert_eq!(state.is_locked(), None);
}
