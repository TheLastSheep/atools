pub(crate) mod commands;
mod legacy;
mod production_legacy;
mod resolution_types;
mod service;
mod spec;
mod transaction;

#[cfg(feature = "legacy-node-smoke")]
use std::path::Path;
#[cfg(any(test, all(feature = "legacy-node-smoke", target_os = "macos")))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

pub(crate) use production_legacy::{
    inspect_legacy_launch_at_login, recover_for_startup, resolve_legacy_launch_at_login,
};
pub(crate) use resolution_types::{
    valid_legacy_revision, LegacyLoginChoice, LegacyLoginInspection,
};

pub(crate) const UNSUPPORTED: &str = "SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED";
pub(crate) const UNAVAILABLE: &str = "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE";
pub(crate) const CONFLICT: &str = "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT";
pub(crate) const APPROVAL_REQUIRED: &str = "SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED";
pub(crate) const LEGACY_CONFIGURATION: &str = "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION";
pub(crate) const RECOVERY_FAILED: &str = "SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED";

static OS_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn with_os_operation<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let lock = OS_OPERATION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| UNAVAILABLE.to_owned())?;
    operation()
}

#[cfg(target_os = "macos")]
fn is_isolated_identifier(identifier: &str) -> bool {
    identifier.starts_with("dev.atools.renderer-settings-input.")
        || identifier.starts_with("dev.atools.renderer-smoke.")
}

#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
#[derive(Debug)]
struct IsolatedSmokeProof {
    proof: spec::IsolatedProof,
    active: AtomicBool,
}

pub(crate) fn read(app: &AppHandle) -> Result<bool, String> {
    read_apply(app, None, None)
}

pub(crate) fn read_apply(
    app: &AppHandle,
    expected: Option<bool>,
    target: Option<bool>,
) -> Result<bool, String> {
    #[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
    {
        let identifier = app.config().identifier.as_str();
        if target.is_some() && is_isolated_identifier(identifier) {
            return with_isolated_operation(app, identifier, |_| {
                if !service::current_bundle_identifier_matches(identifier) {
                    return Err(UNAVAILABLE.to_owned());
                }
                run_transaction(expected, target)
            });
        }
    }

    with_os_operation(|| read_apply_locked(app, expected, target))
}

fn read_apply_locked(
    app: &AppHandle,
    expected: Option<bool>,
    target: Option<bool>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let identifier = app.config().identifier.as_str();
        if spec::is_production_identifier(identifier) {
            if !spec::production_bundle_matches(
                identifier,
                service::current_bundle_identifier_matches(identifier),
            ) {
                return Err(UNAVAILABLE.to_owned());
            }
            production_legacy::recover_locked()?;
            reject_legacy_configuration()?;
        } else if is_isolated_identifier(identifier) {
            if !service::current_bundle_identifier_matches(identifier) {
                return Err(UNAVAILABLE.to_owned());
            }
            if target.is_some() {
                return Err(UNAVAILABLE.to_owned());
            }
        } else {
            return Err(UNAVAILABLE.to_owned());
        }
        run_transaction(expected, target)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, expected, target);
        Err(UNSUPPORTED.to_owned())
    }
}

#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub(crate) fn install_isolated(
    app: &AppHandle,
    root: &Path,
    run_id: &str,
    executable: &Path,
) -> Result<(), String> {
    with_os_operation(|| {
        use tauri::Manager;

        let identifier = app.config().identifier.as_str();
        if !is_isolated_identifier(identifier)
            || !service::current_bundle_identifier_matches(identifier)
        {
            return Err(UNAVAILABLE.to_owned());
        }
        let proof = spec::validate_isolated_scope(identifier, root, run_id, executable)
            .map_err(str::to_owned)?;
        if app.try_state::<IsolatedSmokeProof>().is_some() {
            return Err(UNAVAILABLE.to_owned());
        }
        if !app.manage(IsolatedSmokeProof {
            proof,
            active: AtomicBool::new(true),
        }) {
            return Err(UNAVAILABLE.to_owned());
        }
        Ok(())
    })
}

#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub(crate) fn cleanup_isolated(app: &AppHandle) -> Result<(), String> {
    let identifier = app.config().identifier.as_str();
    with_isolated_cleanup(app, identifier, || {
        if !service::current_bundle_identifier_matches(identifier) {
            return Err(UNAVAILABLE.to_owned());
        }
        let _unregister_result = service::set_enabled(false);
        confirm_cleanup_status(service::status())
    })
}

#[cfg(any(test, all(feature = "legacy-node-smoke", target_os = "macos")))]
fn confirm_cleanup_status(
    status: Result<transaction::ServiceStatus, &'static str>,
) -> Result<(), String> {
    match status {
        Ok(transaction::ServiceStatus::NotRegistered) => Ok(()),
        Ok(transaction::ServiceStatus::RequiresApproval) => Err(APPROVAL_REQUIRED.to_owned()),
        _ => Err(UNAVAILABLE.to_owned()),
    }
}

#[cfg(any(test, all(feature = "legacy-node-smoke", target_os = "macos")))]
fn with_proof_operation<T>(
    active: &AtomicBool,
    revoke_on_success: bool,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    with_os_operation(|| {
        if !active.load(Ordering::Acquire) {
            return Err(UNAVAILABLE.to_owned());
        }
        let value = operation()?;
        if revoke_on_success {
            active.store(false, Ordering::Release);
        }
        Ok(value)
    })
}

#[cfg(any(test, all(feature = "legacy-node-smoke", target_os = "macos")))]
fn isolated_mutation<T>(
    active: &AtomicBool,
    validate: impl FnOnce() -> Result<(), String>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    with_proof_operation(active, false, || {
        validate()?;
        operation()
    })
}

#[cfg(any(test, all(feature = "legacy-node-smoke", target_os = "macos")))]
fn isolated_cleanup<T>(
    active: &AtomicBool,
    validate: impl FnOnce() -> Result<(), String>,
    cleanup: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    with_proof_operation(active, true, || {
        validate()?;
        cleanup()
    })
}

#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
fn with_isolated_operation<T>(
    app: &AppHandle,
    identifier: &str,
    operation: impl FnOnce(&IsolatedSmokeProof) -> Result<T, String>,
) -> Result<T, String> {
    use tauri::Manager;

    let proof = app
        .try_state::<IsolatedSmokeProof>()
        .ok_or_else(|| UNAVAILABLE.to_owned())?;
    isolated_mutation(
        &proof.active,
        || validate_isolated_proof(&proof, identifier),
        || operation(&proof),
    )
}

#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
fn with_isolated_cleanup<T>(
    app: &AppHandle,
    identifier: &str,
    cleanup: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use tauri::Manager;

    let proof = app
        .try_state::<IsolatedSmokeProof>()
        .ok_or_else(|| UNAVAILABLE.to_owned())?;
    isolated_cleanup(
        &proof.active,
        || validate_isolated_proof(&proof, identifier),
        cleanup,
    )
}

#[cfg(all(feature = "legacy-node-smoke", not(target_os = "macos")))]
pub(crate) fn install_isolated(
    _app: &AppHandle,
    _root: &Path,
    _run_id: &str,
    _executable: &Path,
) -> Result<(), String> {
    Err(UNSUPPORTED.to_owned())
}

pub(crate) fn legacy_plist(executable_path: &str) -> String {
    spec::legacy_plist(executable_path)
}

#[cfg(target_os = "macos")]
fn run_transaction(expected: Option<bool>, target: Option<bool>) -> Result<bool, String> {
    transaction::read_apply(&mut service::MainAppService, expected, target).map_err(str::to_owned)
}

#[cfg(target_os = "macos")]
fn reject_legacy_configuration() -> Result<(), String> {
    if spec::legacy_configuration_present().map_err(str::to_owned)? {
        Err(LEGACY_CONFIGURATION.to_owned())
    } else {
        Ok(())
    }
}

#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
fn validate_isolated_proof(proof: &IsolatedSmokeProof, identifier: &str) -> Result<(), String> {
    if !proof.active.load(Ordering::Acquire) || proof.proof.identifier != identifier {
        return Err(UNAVAILABLE.to_owned());
    }
    let current = spec::validate_isolated_scope(
        identifier,
        &proof.proof.root,
        &proof.proof.run_id,
        &proof.proof.executable,
    )
    .map_err(str::to_owned)?;
    if current != proof.proof {
        return Err(UNAVAILABLE.to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        confirm_cleanup_status, isolated_cleanup, isolated_mutation, transaction::ServiceStatus,
        APPROVAL_REQUIRED, LEGACY_CONFIGURATION, UNAVAILABLE, UNSUPPORTED,
    };
    use std::sync::{atomic::AtomicBool, mpsc, Arc, Barrier, Mutex};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn public_error_codes_are_fixed_and_nonempty() {
        for code in [
            APPROVAL_REQUIRED,
            LEGACY_CONFIGURATION,
            UNSUPPORTED,
            UNAVAILABLE,
        ] {
            assert!(code.starts_with("SETTINGS_LAUNCH_AT_LOGIN_"));
            assert!(code.len() < 80);
        }
    }

    #[test]
    fn isolated_cleanup_accepts_only_confirmed_not_registered() {
        assert_eq!(
            confirm_cleanup_status(Ok(ServiceStatus::NotRegistered)),
            Ok(())
        );
        assert_eq!(
            confirm_cleanup_status(Ok(ServiceStatus::RequiresApproval)),
            Err(APPROVAL_REQUIRED.to_owned())
        );
        for status in [
            Ok(ServiceStatus::Enabled),
            Ok(ServiceStatus::NotFound),
            Ok(ServiceStatus::Unknown(77)),
            Err(UNAVAILABLE),
        ] {
            assert_eq!(confirm_cleanup_status(status), Err(UNAVAILABLE.to_owned()));
        }
    }

    #[test]
    fn cleanup_serializes_with_inflight_mutation_and_revokes_late_calls() {
        let active = Arc::new(AtomicBool::new(true));
        let events = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let mutation_wait = Arc::new(Barrier::new(2));
        let (mutation_started_tx, mutation_started_rx) = mpsc::channel();
        let mutation_active = Arc::clone(&active);
        let mutation_events = Arc::clone(&events);
        let mutation_waiter = Arc::clone(&mutation_wait);
        let mutation = thread::spawn(move || {
            isolated_mutation(
                &mutation_active,
                || Ok(()),
                || {
                    mutation_events.lock().unwrap().push("register-start");
                    mutation_started_tx.send(()).unwrap();
                    mutation_waiter.wait();
                    mutation_events.lock().unwrap().push("register-finished");
                    Ok(())
                },
            )
        });
        mutation_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("mutation entered the shared operation boundary");

        let (cleanup_attempted_tx, cleanup_attempted_rx) = mpsc::channel();
        let cleanup_active = Arc::clone(&active);
        let cleanup_events = Arc::clone(&events);
        let cleanup = thread::spawn(move || {
            cleanup_attempted_tx.send(()).unwrap();
            isolated_cleanup(
                &cleanup_active,
                || Ok(()),
                || {
                    cleanup_events.lock().unwrap().push("unregister");
                    confirm_cleanup_status(Ok(ServiceStatus::NotRegistered))
                },
            )
        });
        cleanup_attempted_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("cleanup reached the shared operation boundary");
        assert_eq!(*events.lock().unwrap(), vec!["register-start"]);

        mutation_wait.wait();
        assert_eq!(mutation.join().unwrap(), Ok(()));
        assert_eq!(cleanup.join().unwrap(), Ok(()));
        assert_eq!(
            *events.lock().unwrap(),
            vec!["register-start", "register-finished", "unregister"]
        );
        assert!(!active.load(std::sync::atomic::Ordering::Acquire));

        let mut late_operation_called = false;
        let mut late_validation_called = false;
        assert_eq!(
            isolated_mutation(
                &active,
                || {
                    late_validation_called = true;
                    Ok(())
                },
                || {
                    late_operation_called = true;
                    Ok(())
                },
            ),
            Err(UNAVAILABLE.to_owned())
        );
        assert!(!late_validation_called);
        assert!(!late_operation_called);
    }

    #[test]
    fn unconfirmed_cleanup_keeps_proof_active_for_retry() {
        let active = AtomicBool::new(true);
        assert_eq!(
            isolated_cleanup(
                &active,
                || Ok(()),
                || confirm_cleanup_status(Ok(ServiceStatus::Unknown(9))),
            ),
            Err(UNAVAILABLE.to_owned())
        );
        assert!(active.load(std::sync::atomic::Ordering::Acquire));
    }
}
