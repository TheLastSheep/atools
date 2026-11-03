use super::{
    signal_owned_process_group, signal_process_group_with, validate_process_group,
    ProcessGroupClaim,
};
use std::io;

#[test]
fn process_group_claim_requires_a_positive_matching_pid() {
    let mut called = false;
    assert_eq!(
        validate_process_group(Some(17), |pid| {
            called = true;
            assert_eq!(pid, 17);
            Ok(17)
        })
        .unwrap(),
        Some(17)
    );
    assert!(called);

    called = false;
    assert!(validate_process_group(None, |_| {
        called = true;
        Ok(1)
    })
    .is_err());
    assert!(!called);

    called = false;
    assert!(validate_process_group(Some(0), |_| {
        called = true;
        Ok(0)
    })
    .is_err());
    assert!(!called);

    called = false;
    assert!(validate_process_group(Some(i32::MAX as u32 + 1), |_| {
        called = true;
        Ok(1)
    })
    .is_err());
    assert!(!called);

    assert!(validate_process_group(Some(17), |_| Ok(1)).is_err());
}

#[test]
fn only_a_verified_group_is_signaled_and_the_attempt_is_idempotent() {
    let mut claim = ProcessGroupClaim::owned(17);
    let mut signaled = Vec::new();
    assert!(claim
        .signal_once_with(|group| {
            signaled.push(group);
            Ok(())
        })
        .is_none());
    assert_eq!(signaled, vec![-17]);
    assert!(claim
        .signal_once_with(|_| panic!("an attempted group must not be signaled twice"))
        .is_none());

    let mut unowned = ProcessGroupClaim::failed("refused non-independent process group".into());
    assert!(unowned
        .signal_once_with(|_| panic!("an unowned group must never be signaled"))
        .is_some());
}

#[test]
fn missing_group_is_complete_and_permission_error_is_provisional_until_reap_probe() {
    let error = signal_owned_process_group(9, |_| Err(io::Error::from_raw_os_error(libc::ESRCH)));
    assert!(error.is_ok());

    let mut already_gone = ProcessGroupClaim::owned(9);
    assert!(already_gone
        .signal_once_with(|_| Err(io::Error::from_raw_os_error(libc::ESRCH)))
        .is_none());
    assert!(already_gone
        .signal_once_with(|_| panic!("ESRCH completes cleanup and disarms the token"))
        .is_none());

    let mut claim = ProcessGroupClaim::owned(9);
    let mut signals = 0;
    assert!(claim
        .signal_once_with(|target| {
            signals += 1;
            assert_eq!(target, -9);
            Err(io::Error::from_raw_os_error(libc::EPERM))
        })
        .is_none());
    assert!(!claim.cleanup_confirmed());
    assert!(claim
        .observe_gone_after_reap_with(|pgid| {
            assert_eq!(pgid, 9);
            Err(io::Error::from_raw_os_error(libc::ESRCH))
        })
        .unwrap());
    assert_eq!(signals, 1, "post-reap confirmation must never signal again");
    assert!(claim.cleanup_confirmed());
    assert!(claim.initial_error().is_none());
}

#[test]
fn permission_error_stays_strict_when_group_is_present_or_observation_fails() {
    let mut still_present = ProcessGroupClaim::owned(23);
    assert!(still_present
        .signal_once_with(|_| Err(io::Error::from_raw_os_error(libc::EPERM)))
        .is_none());
    assert!(!still_present
        .observe_gone_after_reap_with(|_| Ok(()))
        .unwrap());
    let timeout = still_present.fail_unconfirmed_after_reap(std::time::Duration::from_secs(1));
    assert!(timeout.to_string().contains("failed to signal"));
    assert!(!still_present.cleanup_confirmed());

    let mut observation_failed = ProcessGroupClaim::owned(24);
    assert!(observation_failed
        .signal_once_with(|_| Err(io::Error::from_raw_os_error(libc::EPERM)))
        .is_none());
    let first = observation_failed
        .observe_gone_after_reap_with(|_| Err(io::Error::from_raw_os_error(libc::EACCES)))
        .unwrap_err();
    assert!(first.to_string().contains("failed to signal"));
    assert!(first.to_string().contains("failed to observe"));
    let second = observation_failed
        .observe_gone_after_reap_with(|_| Err(io::Error::from_raw_os_error(libc::ESRCH)))
        .unwrap_err();
    assert_eq!(
        first, second,
        "later ESRCH cannot clear observation failure"
    );
}

#[test]
fn non_permission_signal_errors_cannot_be_cleared_by_a_later_missing_group() {
    let mut claim = ProcessGroupClaim::owned(29);
    let first = claim
        .signal_once_with(|_| Err(io::Error::from_raw_os_error(libc::EIO)))
        .expect("non-EPERM signal error stays strict");
    let second = claim
        .observe_gone_after_reap_with(|_| Err(io::Error::from_raw_os_error(libc::ESRCH)))
        .unwrap_err();
    assert_eq!(first, second);
    assert!(!claim.cleanup_confirmed());
}

#[test]
fn invalid_pgid_never_reaches_signal_syscall() {
    let error = signal_owned_process_group(0, |_| {
        panic!("invalid process group ID must not reach the syscall")
    });
    assert_eq!(error.unwrap_err().kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn production_group_signal_shim_passes_the_negative_target_to_kill() {
    let mut observed = None;
    signal_process_group_with(-17, |target, signal| {
        observed = Some((target, signal));
        0
    })
    .unwrap();
    assert_eq!(observed, Some((-17, libc::SIGKILL)));
}
