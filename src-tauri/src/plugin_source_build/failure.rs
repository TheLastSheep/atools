//! Bounded, structured observation of the outer source-build runner only.

pub(crate) const MAX_CAPTURED_RUNNER_LOG_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunnerFailureClass {
    NonzeroExit,
    SignalExit,
    Timeout,
    Cancelled,
    CleanupUnconfirmed,
    SupervisorFailure,
}

/// Fixed supervisor/source-build codes; arbitrary error strings are never kept
/// in the persisted diagnostic DTO.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunnerFailureCode {
    ProcessFailed,
    Timeout,
    Cancelled,
    CleanupUnconfirmed,
    SpawnFailed,
    PipeConfigurationFailed,
    WaitFailed,
    LogLimitExceeded,
    LogReadFailed,
    PrivateEnvironmentFailed,
    ProfileWriteFailed,
}

impl RunnerFailureCode {
    fn from_observed(value: &str) -> Option<Self> {
        match value {
            "SourceBuildProcessFailed" => Some(Self::ProcessFailed),
            "SourceBuildTimeout" => Some(Self::Timeout),
            "SOURCE_BUILD_CANCELLED" => Some(Self::Cancelled),
            "SOURCE_BUILD_CLEANUP_UNCONFIRMED" => Some(Self::CleanupUnconfirmed),
            "SourceBuildSpawnFailed" => Some(Self::SpawnFailed),
            "SourceBuildPipeConfigurationFailed" => Some(Self::PipeConfigurationFailed),
            "SourceBuildWaitFailed" => Some(Self::WaitFailed),
            "SourceBuildLogLimitExceeded" => Some(Self::LogLimitExceeded),
            "SourceBuildLogReadFailed" => Some(Self::LogReadFailed),
            "SourceBuildPrivateEnvironmentFailed" => Some(Self::PrivateEnvironmentFailed),
            "SourceBuildProfileWriteFailed" => Some(Self::ProfileWriteFailed),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ProcessFailed => "SourceBuildProcessFailed",
            Self::Timeout => "SourceBuildTimeout",
            Self::Cancelled => "SOURCE_BUILD_CANCELLED",
            Self::CleanupUnconfirmed => "SOURCE_BUILD_CLEANUP_UNCONFIRMED",
            Self::SpawnFailed => "SourceBuildSpawnFailed",
            Self::PipeConfigurationFailed => "SourceBuildPipeConfigurationFailed",
            Self::WaitFailed => "SourceBuildWaitFailed",
            Self::LogLimitExceeded => "SourceBuildLogLimitExceeded",
            Self::LogReadFailed => "SourceBuildLogReadFailed",
            Self::PrivateEnvironmentFailed => "SourceBuildPrivateEnvironmentFailed",
            Self::ProfileWriteFailed => "SourceBuildProfileWriteFailed",
        }
    }
}

impl RunnerFailureClass {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::NonzeroExit => "nonzero_exit",
            Self::SignalExit => "signal_exit",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::CleanupUnconfirmed => "cleanup_unconfirmed",
            Self::SupervisorFailure => "supervisor_failure",
        }
    }
}

#[derive(Debug)]
pub(crate) struct RunnerFailure {
    pub(crate) classification: RunnerFailureClass,
    pub(crate) failure_code: Option<RunnerFailureCode>,
    pub(crate) runner_exit_code: Option<i32>,
    pub(crate) runner_signal: Option<i32>,
    pub(crate) cleanup_confirmed: bool,
    pub(crate) captured_log: Vec<u8>,
}

impl RunnerFailure {
    pub(crate) fn observed(
        failure_code: &str,
        cleanup_confirmed: bool,
        runner_exit_code: Option<i32>,
        runner_signal: Option<i32>,
        captured_log: Vec<u8>,
    ) -> Self {
        let classification = if !cleanup_confirmed
            || failure_code == "SOURCE_BUILD_CLEANUP_UNCONFIRMED"
        {
            RunnerFailureClass::CleanupUnconfirmed
        } else {
            match failure_code {
                "SourceBuildTimeout" => RunnerFailureClass::Timeout,
                "SOURCE_BUILD_CANCELLED" => RunnerFailureClass::Cancelled,
                "SourceBuildProcessFailed" if runner_signal.is_some() => {
                    RunnerFailureClass::SignalExit
                }
                "SourceBuildProcessFailed" if runner_exit_code.is_some_and(|code| code != 0) => {
                    RunnerFailureClass::NonzeroExit
                }
                _ => RunnerFailureClass::SupervisorFailure,
            }
        };
        Self {
            classification,
            failure_code: RunnerFailureCode::from_observed(failure_code),
            runner_exit_code,
            runner_signal,
            cleanup_confirmed,
            captured_log: captured_log
                .into_iter()
                .take(MAX_CAPTURED_RUNNER_LOG_BYTES)
                .collect(),
        }
    }

    pub(crate) fn cleanup_unconfirmed(&self) -> bool {
        self.classification == RunnerFailureClass::CleanupUnconfirmed
    }

    pub(crate) fn captured_log_bytes(&self) -> usize {
        self.captured_log.len()
    }

    pub(crate) fn with_cleanup_unconfirmed(mut self) -> Self {
        self.classification = RunnerFailureClass::CleanupUnconfirmed;
        self.cleanup_confirmed = false;
        self
    }
}

#[derive(Debug)]
pub(crate) enum SourceBuildFailure {
    Message(String),
    Runner(RunnerFailure),
}

impl SourceBuildFailure {
    pub(crate) fn safe_message(&self) -> &str {
        match self {
            Self::Message(message) => message,
            Self::Runner(_) => "Source build runner failed; see the TaskRun log artifact.",
        }
    }

    pub(crate) fn is_code(&self, code: &str) -> bool {
        matches!(self, Self::Message(message) if message == code)
    }

    pub(crate) fn cleanup_unconfirmed(&self) -> bool {
        matches!(self, Self::Runner(failure) if failure.cleanup_unconfirmed())
            || self.is_code("SOURCE_BUILD_CLEANUP_UNCONFIRMED")
    }
}

impl From<String> for SourceBuildFailure {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<&'static str> for SourceBuildFailure {
    fn from(message: &'static str) -> Self {
        Self::Message(message.to_owned())
    }
}

impl PartialEq<&str> for SourceBuildFailure {
    fn eq(&self, other: &&str) -> bool {
        self.is_code(other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_failure_classification_uses_only_observed_outer_facts() {
        let cases = [
            (
                "SourceBuildTimeout",
                true,
                None,
                None,
                RunnerFailureClass::Timeout,
            ),
            (
                "SOURCE_BUILD_CANCELLED",
                true,
                Some(9),
                Some(9),
                RunnerFailureClass::Cancelled,
            ),
            (
                "SOURCE_BUILD_CLEANUP_UNCONFIRMED",
                false,
                Some(9),
                Some(9),
                RunnerFailureClass::CleanupUnconfirmed,
            ),
            (
                "SourceBuildProcessFailed",
                true,
                Some(7),
                None,
                RunnerFailureClass::NonzeroExit,
            ),
            (
                "SourceBuildProcessFailed",
                true,
                None,
                Some(15),
                RunnerFailureClass::SignalExit,
            ),
            (
                "SourceBuildWaitFailed",
                true,
                None,
                None,
                RunnerFailureClass::SupervisorFailure,
            ),
        ];
        for (code, cleanup, exit, signal, expected) in cases {
            let failure = RunnerFailure::observed(code, cleanup, exit, signal, Vec::new());
            assert_eq!(failure.classification, expected);
        }
    }

    #[test]
    fn captured_runner_log_is_capped_without_inventing_truncation_metadata() {
        let failure = RunnerFailure::observed(
            "SourceBuildProcessFailed",
            true,
            Some(1),
            None,
            vec![b'x'; MAX_CAPTURED_RUNNER_LOG_BYTES + 100],
        );
        assert_eq!(failure.captured_log_bytes(), MAX_CAPTURED_RUNNER_LOG_BYTES);
    }

    #[test]
    fn nonzero_signal_does_not_hide_an_allowlisted_supervisor_error_code() {
        let failure = RunnerFailure::observed(
            "SourceBuildLogLimitExceeded",
            true,
            None,
            Some(15),
            Vec::new(),
        );
        assert_eq!(
            failure.classification,
            RunnerFailureClass::SupervisorFailure
        );
        assert_eq!(
            failure.failure_code,
            Some(RunnerFailureCode::LogLimitExceeded)
        );
        assert_eq!(
            failure.failure_code.unwrap().as_str(),
            "SourceBuildLogLimitExceeded"
        );
    }

    #[test]
    fn later_cleanup_uncertainty_keeps_observed_runner_status_and_log() {
        let failure = RunnerFailure::observed(
            "SourceBuildTimeout",
            true,
            Some(9),
            None,
            b"bounded diagnostic".to_vec(),
        )
        .with_cleanup_unconfirmed();
        assert_eq!(
            failure.classification,
            RunnerFailureClass::CleanupUnconfirmed
        );
        assert_eq!(failure.runner_exit_code, Some(9));
        assert!(!failure.cleanup_confirmed);
        assert_eq!(failure.captured_log, b"bounded diagnostic");
    }
}
