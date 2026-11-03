use serde_json::Value;

pub(super) fn business_passed(
    database: &Value,
    stages: &Value,
    counters: &Value,
    cleanup: &Value,
    errors: &[&str],
) -> bool {
    errors.is_empty()
        && super::valid_database(database)
        && database["beforeSha256"].as_str().is_some()
        && database["beforeSha256"] == database["afterSha256"]
        && super::valid_stages(stages)
        && super::valid_counters(counters)
        && counters["readLaunchAtLogin"].as_u64() == Some(3)
        && counters["changeLaunchAtLogin"].as_u64() == Some(2)
        && counters["saveGeneralSettings"].as_u64() == Some(1)
        && super::valid_cleanup(cleanup)
        && cleanup["fallbackWindowCount"].as_u64() == Some(0)
        && cleanup["coordinatorTerminal"].as_bool() == Some(true)
        && cleanup["databaseRestored"].as_bool() == Some(true)
        && cleanup["pendingProbes"].as_u64() == Some(0)
        && super::STAGES.iter().all(|(name, _)| {
            stage_matches(
                name,
                &stages[*name],
                database["originalLaunchAtLogin"].as_bool(),
            )
        })
}

pub(super) fn stage_matches(
    name: &str,
    stage: &Value,
    original_launch_at_login: Option<bool>,
) -> bool {
    match name {
        "initial" => vue_stage(
            stage,
            Some(true),
            Some(true),
            Some(false),
            Some(true),
            false,
        ),
        "fallbackInitial" => fallback_stage(
            stage,
            Some(true),
            Some(true),
            Some(false),
            Some(true),
            false,
            false,
        ),
        "fallbackDisabled" => fallback_stage(
            stage,
            Some(false),
            Some(false),
            Some(false),
            Some(true),
            false,
            true,
        ),
        "vueAfterDisabled" => vue_stage(
            stage,
            Some(false),
            Some(false),
            Some(false),
            Some(true),
            false,
        ),
        "vueReenabled" => vue_stage(stage, Some(true), Some(true), Some(false), Some(true), true),
        "fallbackFresh" => fallback_stage(
            stage,
            Some(true),
            Some(true),
            Some(false),
            Some(true),
            false,
            false,
        ),
        "ordinarySave" => {
            fallback_stage(
                stage,
                Some(true),
                Some(true),
                Some(false),
                Some(true),
                false,
                true,
            ) && stage["saveState"].as_str() == Some("saved")
        }
        "conflict" => fallback_stage(
            stage,
            None,
            Some(false),
            Some(false),
            Some(true),
            true,
            true,
        ),
        "reread" => fallback_stage(
            stage,
            Some(false),
            Some(false),
            Some(false),
            Some(true),
            false,
            true,
        ),
        "final" => vue_stage(
            stage,
            Some(true),
            Some(true),
            original_launch_at_login,
            None,
            true,
        ),
        _ => false,
    }
}

fn vue_stage(
    stage: &Value,
    enabled: Option<bool>,
    native: Option<bool>,
    database: Option<bool>,
    marker: Option<bool>,
    action_required: bool,
) -> bool {
    stage["surface"].as_str() == Some("vue")
        && stage["ready"].as_bool() == Some(true)
        && stage["controlUnique"].as_bool() == Some(true)
        && stage["enabled"].as_bool() == enabled
        && stage["routeGeneral"].as_bool() == Some(true)
        && stage["getterEnabled"].as_bool() == enabled
        && stage["disabled"].is_null()
        && stage["indeterminate"].is_null()
        && stage["overviewUnknown"].is_null()
        && stage["hasConflictMessage"].is_null()
        && stage["saveState"].is_null()
        && stage["nativeEnabled"].as_bool() == native
        && stage["databaseEnabled"].as_bool() == database
        && stage["unknownMarkerPreserved"].as_bool() == marker
        && action_state(stage, action_required)
}

fn fallback_stage(
    stage: &Value,
    enabled: Option<bool>,
    native: Option<bool>,
    database: Option<bool>,
    marker: Option<bool>,
    conflict: bool,
    action_required: bool,
) -> bool {
    stage["surface"].as_str() == Some("fallback")
        && stage["ready"].as_bool() == Some(true)
        && stage["controlUnique"].as_bool() == Some(true)
        && stage["enabled"].as_bool() == enabled
        && stage["disabled"].as_bool() == Some(conflict)
        && stage["indeterminate"].as_bool() == Some(conflict)
        && stage["overviewUnknown"].as_bool() == Some(conflict)
        && stage["hasConflictMessage"].as_bool() == Some(conflict)
        && stage["routeGeneral"].is_null()
        && stage["getterEnabled"].is_null()
        && stage["nativeEnabled"].as_bool() == native
        && stage["databaseEnabled"].as_bool() == database
        && stage["unknownMarkerPreserved"].as_bool() == marker
        && action_state(stage, action_required)
}

fn action_state(stage: &Value, required: bool) -> bool {
    if required {
        stage["actionDispatched"].as_bool() == Some(true)
            && stage["actionSucceeded"].as_bool() == Some(true)
    } else {
        stage["actionDispatched"].is_null() && stage["actionSucceeded"].is_null()
    }
}
