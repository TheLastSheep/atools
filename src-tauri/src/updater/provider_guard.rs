//! Host registration evidence, not a page-selected provider or a managed-profile grant.
use super::{coordinator::failure, UpdateCommandError};
use tauri::Manager;
// Only the normal SDK plugin-registration chain creates this marker. No managed constructor.
pub(crate) struct SdkHostMarker(());
pub(crate) fn sdk_host_marker() -> SdkHostMarker {
    SdkHostMarker(())
}
#[derive(Clone, Copy)]
pub(super) struct HostFacts {
    state_present: bool,
    managed: bool,
    sdk_registered: bool,
}
pub(super) fn facts(app: &tauri::AppHandle) -> HostFacts {
    let state = app.try_state::<crate::state::AppState>();
    HostFacts {
        state_present: state.is_some(),
        managed: app.config().identifier != "dev.atools.desktop"
            || state
                .as_ref()
                .is_none_or(|s| s.release_smoke.lock().is_some()),
        sdk_registered: app.try_state::<SdkHostMarker>().is_some(),
    }
}
pub(super) fn authorize(
    facts: HostFacts,
    loopback_requested: bool,
) -> Result<(), UpdateCommandError> {
    // Environment selects a normal debug endpoint, never grants SDK access.
    let _ = loopback_requested;
    if !facts.state_present || !facts.sdk_registered {
        return Err(failure("provider_unavailable"));
    }
    if facts.managed {
        return Err(failure("provider_disabled"));
    }
    Ok(())
}

pub(super) fn create_guarded<T>(
    facts: HostFacts,
    loopback: bool,
    create: impl FnOnce() -> Result<T, UpdateCommandError>,
) -> Result<T, UpdateCommandError> {
    authorize(facts, loopback)?;
    create()
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn missing_host_or_managed_loopback_never_reaches_sdk_constructor() {
        let cases = [
            (
                "missing-state",
                HostFacts {
                    state_present: false,
                    managed: true,
                    sdk_registered: false,
                },
                "provider_unavailable",
            ),
            (
                "missing-marker",
                HostFacts {
                    state_present: true,
                    managed: false,
                    sdk_registered: false,
                },
                "provider_unavailable",
            ),
            (
                "old-managed-smoke",
                HostFacts {
                    state_present: true,
                    managed: true,
                    sdk_registered: false,
                },
                "provider_unavailable",
            ),
            (
                "managed-even-with-sdk",
                HostFacts {
                    state_present: true,
                    managed: true,
                    sdk_registered: true,
                },
                "provider_disabled",
            ),
        ];
        let mut observed = Vec::new();
        let mut expected = Vec::new();
        for (label, facts, code) in cases {
            for loopback in [false, true] {
                let called = Cell::new(0);
                let result = create_guarded(facts, loopback, || {
                    called.set(called.get() + 1);
                    Ok(())
                });
                observed.push((label, loopback, result.err().map(|e| e.code), called.get()));
                expected.push((label, loopback, Some(code.to_string()), 0));
            }
        }
        assert_eq!(
            observed, expected,
            "unauthorized SDK constructor count must remain zero in every host/environment case"
        );
    }
    #[test]
    fn only_existing_normal_registered_sdk_host_can_construct_provider() {
        let called = Cell::new(0);
        for loopback in [false, true] {
            create_guarded(
                HostFacts {
                    state_present: true,
                    managed: false,
                    sdk_registered: true,
                },
                loopback,
                || {
                    called.set(called.get() + 1);
                    Ok(())
                },
            )
            .unwrap();
        }
        assert_eq!(called.get(), 2);
    }
}
