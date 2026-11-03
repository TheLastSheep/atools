use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Operation {
    Search,
    SpaceDisabled,
    Unlisted,
    LaunchDenied,
    LaunchSucceeded,
    RestoreInput,
}

impl Operation {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::SpaceDisabled => "space-disabled",
            Self::Unlisted => "unlisted",
            Self::LaunchDenied => "launch-denied",
            Self::LaunchSucceeded => "launch-succeeded",
            Self::RestoreInput => "restore-input",
        }
    }

    pub(super) fn sequence(enter_case: bool) -> Vec<Self> {
        let mut operations = vec![Self::Search, Self::Unlisted];
        if enter_case {
            operations.push(Self::SpaceDisabled);
        }
        operations.extend([Self::LaunchDenied, Self::LaunchSucceeded]);
        operations
    }
}

#[derive(Debug)]
pub(super) enum Evidence {
    Search(SearchEvidence),
    SpaceDisabled(SpaceDisabledEvidence),
    Unlisted(UnlistedEvidence),
    Launch(LaunchEvidence),
    RestoreInput(bool),
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum ProbeId {
    First,
    Second,
}

impl ProbeId {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Second => "second",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SearchEvidence {
    pub(super) dom_input: bool,
    pub(super) space_enabled: bool,
    pub(super) result_count: u64,
    pub(super) selected_before: ProbeId,
    pub(super) selected_after: ProbeId,
    pub(super) selection_changed: bool,
    pub(super) selected_identity_matched: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SpaceDisabledEvidence {
    pub(super) sent: bool,
    pub(super) default_prevented: bool,
    pub(super) launch_call_delta: u64,
    pub(super) selection_unchanged: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UnlistedEvidence {
    pub(super) rejected: bool,
    pub(super) error_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LaunchEvidence {
    pub(super) key: String,
    pub(super) default_prevented: bool,
    pub(super) selected_probe: ProbeId,
    pub(super) launch_call_delta: u64,
    pub(super) launch_settled: bool,
    pub(super) main_history_applied: bool,
    pub(super) app_state_accepted_delta: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RestoreInputEvidence {
    pub(super) restored: bool,
}

pub(super) fn parse(operation: Operation, value: &Value, enter_case: bool) -> Result<Evidence, ()> {
    match operation {
        Operation::Search => {
            let evidence: SearchEvidence = serde_json::from_value(value.clone()).map_err(|_| ())?;
            if !evidence.dom_input
                || evidence.space_enabled != !enter_case
                || evidence.result_count != 2
                || evidence.selected_before != ProbeId::First
                || evidence.selected_after != ProbeId::Second
                || !evidence.selection_changed
                || !evidence.selected_identity_matched
            {
                return Err(());
            }
            Ok(Evidence::Search(evidence))
        }
        Operation::SpaceDisabled => {
            let evidence: SpaceDisabledEvidence =
                serde_json::from_value(value.clone()).map_err(|_| ())?;
            if !enter_case
                || !evidence.sent
                || evidence.default_prevented
                || evidence.launch_call_delta != 0
                || !evidence.selection_unchanged
            {
                return Err(());
            }
            Ok(Evidence::SpaceDisabled(evidence))
        }
        Operation::Unlisted => {
            let evidence: UnlistedEvidence =
                serde_json::from_value(value.clone()).map_err(|_| ())?;
            if !evidence.rejected || evidence.error_code != "CATALOG_REJECTED" {
                return Err(());
            }
            Ok(Evidence::Unlisted(evidence))
        }
        Operation::LaunchDenied | Operation::LaunchSucceeded => {
            let evidence: LaunchEvidence = serde_json::from_value(value.clone()).map_err(|_| ())?;
            let expected_key = if enter_case { "Enter" } else { "Space" };
            let successful = operation == Operation::LaunchSucceeded;
            if evidence.key != expected_key
                || !evidence.default_prevented
                || evidence.selected_probe != ProbeId::Second
                || evidence.launch_call_delta != 1
                || !evidence.launch_settled
                || evidence.main_history_applied != successful
                || (successful && evidence.app_state_accepted_delta == 0)
                || (!successful && evidence.app_state_accepted_delta != 0)
            {
                return Err(());
            }
            Ok(Evidence::Launch(evidence))
        }
        Operation::RestoreInput => {
            let evidence: RestoreInputEvidence =
                serde_json::from_value(value.clone()).map_err(|_| ())?;
            Ok(Evidence::RestoreInput(evidence.restored))
        }
    }
}
