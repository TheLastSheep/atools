#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ServiceStatus {
    NotRegistered,
    Enabled,
    RequiresApproval,
    NotFound,
    Unknown(isize),
}

pub(super) trait ServicePort {
    fn status(&mut self) -> Result<ServiceStatus, &'static str>;
    fn set_enabled(&mut self, enabled: bool) -> Result<(), &'static str>;
}

pub(super) fn read_apply<P: ServicePort>(
    port: &mut P,
    expected: Option<bool>,
    target: Option<bool>,
) -> Result<bool, &'static str> {
    let before_status = port.status()?;
    let before = known_state(before_status)?;
    if expected.is_some_and(|expected| expected != before) {
        return Err(super::CONFLICT);
    }
    let Some(target) = target else {
        return Ok(before);
    };
    if before == target {
        return Ok(before);
    }

    let _set_result = port.set_enabled(target);
    match port.status().and_then(known_state) {
        Ok(observed) if observed == target => Ok(observed),
        after => {
            let primary_error = match after {
                Err(super::APPROVAL_REQUIRED) => super::APPROVAL_REQUIRED,
                _ => super::UNAVAILABLE,
            };
            if after == Ok(before) {
                return Err(primary_error);
            }
            let _restore_result = port.set_enabled(before);
            match port.status().and_then(known_state) {
                Ok(restored) if restored == before => Err(primary_error),
                _ => Err(super::RECOVERY_FAILED),
            }
        }
    }
}

pub(super) fn known_state(status: ServiceStatus) -> Result<bool, &'static str> {
    match status {
        ServiceStatus::NotRegistered | ServiceStatus::NotFound => Ok(false),
        ServiceStatus::Enabled => Ok(true),
        ServiceStatus::RequiresApproval => Err(super::APPROVAL_REQUIRED),
        ServiceStatus::Unknown(_) => Err(super::UNAVAILABLE),
    }
}

#[cfg(test)]
mod tests {
    use super::{read_apply, ServicePort, ServiceStatus};
    use std::collections::VecDeque;

    struct FakeService {
        status: ServiceStatus,
        after_set: VecDeque<ServiceStatus>,
        set_results: VecDeque<Result<(), &'static str>>,
        requested: Vec<bool>,
    }

    impl FakeService {
        fn new(status: ServiceStatus) -> Self {
            Self {
                status,
                after_set: VecDeque::new(),
                set_results: VecDeque::new(),
                requested: Vec::new(),
            }
        }
    }

    impl ServicePort for FakeService {
        fn status(&mut self) -> Result<ServiceStatus, &'static str> {
            Ok(self.status)
        }

        fn set_enabled(&mut self, enabled: bool) -> Result<(), &'static str> {
            self.requested.push(enabled);
            if let Some(status) = self.after_set.pop_front() {
                self.status = status;
            } else {
                self.status = if enabled {
                    ServiceStatus::Enabled
                } else {
                    ServiceStatus::NotRegistered
                };
            }
            self.set_results.pop_front().unwrap_or(Ok(()))
        }
    }

    #[test]
    fn read_uses_actual_status_and_conflict_has_no_mutation() {
        let mut service = FakeService::new(ServiceStatus::Enabled);
        assert_eq!(read_apply(&mut service, None, None), Ok(true));
        assert_eq!(
            read_apply(&mut service, Some(false), Some(false)),
            Err(super::super::CONFLICT)
        );
        assert!(service.requested.is_empty());
    }

    #[test]
    fn unknown_and_approval_statuses_never_become_false() {
        let mut unknown = FakeService::new(ServiceStatus::Unknown(99));
        assert_eq!(
            read_apply(&mut unknown, None, None),
            Err(super::super::UNAVAILABLE)
        );
        let mut approval = FakeService::new(ServiceStatus::RequiresApproval);
        assert_eq!(
            read_apply(&mut approval, None, None),
            Err(super::super::APPROVAL_REQUIRED)
        );
    }

    #[test]
    fn not_found_is_a_known_disabled_state() {
        let mut service = FakeService::new(ServiceStatus::NotFound);
        assert_eq!(read_apply(&mut service, None, None), Ok(false));
        assert!(service.requested.is_empty());
    }

    #[test]
    fn not_found_can_register_only_with_enabled_readback() {
        let mut service = FakeService::new(ServiceStatus::NotFound);
        assert_eq!(read_apply(&mut service, Some(false), Some(true)), Ok(true));
        assert_eq!(service.requested, vec![true]);
    }

    #[test]
    fn not_found_after_unregister_is_confirmed_disabled() {
        let mut service = FakeService::new(ServiceStatus::Enabled);
        service.after_set.push_back(ServiceStatus::NotFound);
        assert_eq!(read_apply(&mut service, Some(true), Some(false)), Ok(false));
        assert_eq!(service.requested, vec![false]);
    }

    #[test]
    fn mutation_returns_only_verified_status() {
        let mut service = FakeService::new(ServiceStatus::NotRegistered);
        assert_eq!(read_apply(&mut service, Some(false), Some(true)), Ok(true));
        assert_eq!(service.requested, vec![true]);
    }

    #[test]
    fn failed_mutation_restores_original_and_preserves_approval_error() {
        let mut service = FakeService::new(ServiceStatus::NotRegistered);
        service.after_set.extend([
            ServiceStatus::RequiresApproval,
            ServiceStatus::NotRegistered,
        ]);
        service
            .set_results
            .extend([Err(super::super::UNAVAILABLE), Ok(())]);
        assert_eq!(
            read_apply(&mut service, Some(false), Some(true)),
            Err(super::super::APPROVAL_REQUIRED)
        );
        assert_eq!(service.requested, vec![true, false]);
        assert_eq!(service.status, ServiceStatus::NotRegistered);
    }

    #[test]
    fn failed_restoration_has_stable_recovery_error() {
        let mut service = FakeService::new(ServiceStatus::Enabled);
        service
            .after_set
            .extend([ServiceStatus::Unknown(99), ServiceStatus::Unknown(100)]);
        assert_eq!(
            read_apply(&mut service, Some(true), Some(false)),
            Err(super::super::RECOVERY_FAILED)
        );
        assert_eq!(service.requested, vec![false, true]);
    }
}
