use serde_json::{json, Value};
use std::collections::HashSet;

const PREFERENCE_FIELDS: &[&str] = &[
    "searchMode",
    "showRecentInSearch",
    "pinnedRows",
    "recentRows",
    "showMatchRecommendation",
    "tabKeyFunction",
    "tabTargetCommand",
    "spaceOpenCommand",
];

pub(super) fn empty_report(enabled: bool) -> Value {
    json!({
        "schemaVersion": 2,
        "enabled": enabled,
        "passed": false,
        "bootstrap": {
            "domMounted": false,
            "nativeReady": false,
            "platform": null,
            "launchAtLoginAvailable": false,
            "opacityApplied": false,
            "sourceTrusted": false,
            "nativeBounds": {
                "expectedHeaderLogical": 58,
                "initial": null,
                "reopen": null
            },
            "childIncognitoDataStorePersistent": null
        },
        "entryPoints": {
            "button": {"mainPluginMode": false, "childViews": null},
            "keyboard": {"mainPluginMode": false, "childViews": null}
        },
        "save": {
            "inputChanged": false,
            "committed": false,
            "rawUpdated": false,
            "mainNotified": false
        },
        "preferences": {
            "schemaVersion": 1,
            "editableFieldCount": 13,
            "fields": [
                {"field":"searchMode","edited":false,"committed":false,"mainApplied":false,"reopened":false},
                {"field":"showRecentInSearch","edited":false,"committed":false,"mainApplied":false,"reopened":false},
                {"field":"pinnedRows","edited":false,"committed":false,"mainApplied":false,"reopened":false},
                {"field":"recentRows","edited":false,"committed":false,"mainApplied":false,"reopened":false},
                {"field":"showMatchRecommendation","edited":false,"committed":false,"mainApplied":false,"reopened":false},
                {"field":"tabKeyFunction","edited":false,"committed":false,"mainApplied":false,"reopened":false},
                {"field":"tabTargetCommand","edited":false,"committed":false,"mainApplied":false,"reopened":false},
                {"field":"spaceOpenCommand","edited":false,"committed":false,"mainApplied":false,"reopened":false}
            ],
            "probeStages": {
                "searchMode": "not-run",
                "showRecentInSearch": "not-run",
                "pinnedRows": "not-run",
                "recentRows": "not-run",
                "showMatchRecommendation": "not-run",
                "tabKeyFunction": "not-run",
                "tabTargetCommand": "not-run",
                "spaceOpenCommand": "not-run"
            },
            "coldStartup": {
                "passed": false,
                "scope": "native-seed-before-plugin-entry",
                "piniaAppFound": false,
                "windowStoreFound": false,
                "fieldCount": 0,
                "fieldMatches": {
                    "placeholder": false,
                    "theme": false,
                    "primaryColor": false,
                    "customColor": false,
                    "autoClear": false,
                    "showRecentInSearch": false,
                    "recentRows": false,
                    "pinnedRows": false,
                    "searchMode": false,
                    "showMatchRecommendation": false,
                    "tabKeyFunction": false,
                    "tabTargetCommand": false,
                    "spaceOpenCommand": false
                },
                "tabTargetCommandBytes": null
            },
            "readonlyRejected": false,
            "invalidValueRejected": false,
            "mainObservation": {
                "piniaAppFound": false,
                "windowStoreFound": false,
                "presentFields": [],
                "values": {
                    "showRecentInSearch": null,
                    "recentRows": null,
                    "pinnedRows": null,
                    "searchMode": null,
                    "showMatchRecommendation": null,
                    "tabKeyFunction": null,
                    "tabTargetCommand": null,
                    "spaceOpenCommand": null
                },
                "searchModeStructure": {
                    "verified": false,
                    "mode": null,
                    "selector": null,
                    "visible": false,
                    "rowCountClaimed": false,
                    "queryInjected": false,
                    "queryRestored": false,
                    "resultCount": 0,
                    "unavailableReason": "input-unavailable"
                }
            },
            "reopenObservation": {
                "controlsVerified": false,
                "nativeMatches": false,
                "controlFound": {},
                "controlValues": {},
                "nativeValues": {}
            },
            "rejectionEvidence": {
                "readonly": {"errorCode": null, "revisionUnchanged": false, "rawUnchanged": false, "projectionUnchanged": false},
                "invalidValue": {"errorCode": null, "revisionUnchanged": false, "rawUnchanged": false, "projectionUnchanged": false}
            }
        },
        "reopen": {"freshDocument": false, "persistedDOM": false},
        "exit": {
            "button": {
                "childAbsent": false,
                "layoutRegistrations": null,
                "searchQueryEmpty": false,
                "searchFocused": false,
                "nativeWindowVisible": false,
                "nativeWindowFocused": false
            },
            "childEscape": {
                "childAbsent": false,
                "layoutRegistrations": null,
                "searchQueryEmpty": false,
                "searchFocused": false,
                "nativeWindowVisible": false,
                "nativeWindowFocused": false
            }
        },
        "isolation": {
            "secretsAbsent": false,
            "staleSessionRejected": false,
            "genericAppDenied": false,
            "coreDenied": false,
            "coreDenialDiagnosticInitial": null,
            "coreDenialDiagnosticReopen": null,
            "unlistedResourceDenied": false
        },
        "cleanup": {
            "runtimeInitialized": false,
            "stateAvailable": false,
            "sessions": null,
            "childViews": null,
            "layoutRegistrations": null,
            "pendingCalls": null,
            "pendingWrites": null,
            "bundleCached": null
        },
        "fixture": {
            "readonlyDataAccepted": false,
            "unknownFieldsPreserved": false,
            "projectionFieldCount": null
        },
        "errors": []
    })
}

pub(super) fn compute_passed(report: &Value) -> bool {
    report["enabled"].as_bool() == Some(true)
        && report["schemaVersion"].as_u64() == Some(2)
        && report["bootstrap"]["domMounted"].as_bool() == Some(true)
        && report["bootstrap"]["nativeReady"].as_bool() == Some(true)
        && report["bootstrap"]["platform"].as_str() == Some("darwin")
        && report["bootstrap"]["launchAtLoginAvailable"].as_bool() == Some(true)
        && report["bootstrap"]["opacityApplied"].as_bool() == Some(true)
        && report["bootstrap"]["sourceTrusted"].as_bool() == Some(true)
        && report["bootstrap"]["nativeBounds"]["expectedHeaderLogical"].as_u64() == Some(58)
        && report["bootstrap"]["nativeBounds"]["initial"]["boundsVerified"].as_bool() == Some(true)
        && report["bootstrap"]["nativeBounds"]["reopen"]["boundsVerified"].as_bool() == Some(true)
        && report["bootstrap"]["childIncognitoDataStorePersistent"].as_bool() == Some(false)
        && report["entryPoints"]["button"]["mainPluginMode"].as_bool() == Some(true)
        && report["entryPoints"]["button"]["childViews"].as_u64() == Some(1)
        && report["entryPoints"]["keyboard"]["mainPluginMode"].as_bool() == Some(true)
        && report["entryPoints"]["keyboard"]["childViews"].as_u64() == Some(1)
        && report["save"]["inputChanged"].as_bool() == Some(true)
        && report["save"]["committed"].as_bool() == Some(true)
        && report["save"]["rawUpdated"].as_bool() == Some(true)
        && report["save"]["mainNotified"].as_bool() == Some(true)
        && preferences_pass(&report["preferences"])
        && report["reopen"]["freshDocument"].as_bool() == Some(true)
        && report["reopen"]["persistedDOM"].as_bool() == Some(true)
        && ["button", "childEscape"].into_iter().all(|kind| {
            report["exit"][kind]["childAbsent"].as_bool() == Some(true)
                && report["exit"][kind]["layoutRegistrations"].as_u64() == Some(0)
                && report["exit"][kind]["searchQueryEmpty"].as_bool() == Some(true)
                && report["exit"][kind]["searchFocused"].as_bool() == Some(true)
                && report["exit"][kind]["nativeWindowVisible"].as_bool() == Some(true)
                && report["exit"][kind]["nativeWindowFocused"].as_bool() == Some(true)
        })
        && report["isolation"]["secretsAbsent"].as_bool() == Some(true)
        && report["isolation"]["staleSessionRejected"].as_bool() == Some(true)
        && report["isolation"]["genericAppDenied"].as_bool() == Some(true)
        && report["isolation"]["coreDenied"].as_bool() == Some(true)
        && report["isolation"]["unlistedResourceDenied"].as_bool() == Some(true)
        && report["cleanup"]["runtimeInitialized"].as_bool() == Some(true)
        && report["cleanup"]["stateAvailable"].as_bool() == Some(true)
        && [
            "sessions",
            "childViews",
            "layoutRegistrations",
            "pendingCalls",
            "pendingWrites",
        ]
        .into_iter()
        .all(|key| report["cleanup"][key].as_u64() == Some(0))
        && report["fixture"]["readonlyDataAccepted"].as_bool() == Some(true)
        && report["fixture"]["unknownFieldsPreserved"].as_bool() == Some(true)
        && report["fixture"]["projectionFieldCount"].as_u64() == Some(43)
        && report["errors"].as_array().is_some_and(Vec::is_empty)
}

fn preferences_pass(preferences: &Value) -> bool {
    let Some(rows) = preferences["fields"].as_array() else {
        return false;
    };
    if preferences["schemaVersion"].as_u64() != Some(1)
        || preferences["editableFieldCount"].as_u64() != Some(13)
        || preferences["readonlyRejected"].as_bool() != Some(true)
        || preferences["invalidValueRejected"].as_bool() != Some(true)
        || !cold_startup_pass(&preferences["coldStartup"])
        || rows.len() != PREFERENCE_FIELDS.len()
        || preferences["mainObservation"]["piniaAppFound"].as_bool() != Some(true)
        || preferences["mainObservation"]["windowStoreFound"].as_bool() != Some(true)
        || preferences["mainObservation"]["searchModeStructure"]["verified"].as_bool() != Some(true)
        || preferences["mainObservation"]["searchModeStructure"]["rowCountClaimed"].as_bool()
            != Some(false)
        || preferences["reopenObservation"]["controlsVerified"].as_bool() != Some(true)
        || preferences["reopenObservation"]["nativeMatches"].as_bool() != Some(true)
    {
        return false;
    }

    let mut seen = HashSet::with_capacity(PREFERENCE_FIELDS.len());
    rows.iter().all(|row| {
        let Some(object) = row.as_object() else {
            return false;
        };
        if object.len() != 5
            || !["field", "edited", "committed", "mainApplied", "reopened"]
                .into_iter()
                .all(|key| object.contains_key(key))
        {
            return false;
        }
        let Some(field) = row["field"].as_str() else {
            return false;
        };
        seen.insert(field.to_owned())
            && PREFERENCE_FIELDS.contains(&field)
            && ["edited", "committed", "mainApplied", "reopened"]
                .into_iter()
                .all(|key| row[key].as_bool() == Some(true))
    }) && seen.len() == PREFERENCE_FIELDS.len()
}

fn cold_startup_pass(cold: &Value) -> bool {
    const FIELDS: &[&str] = &[
        "placeholder",
        "theme",
        "primaryColor",
        "customColor",
        "autoClear",
        "showRecentInSearch",
        "recentRows",
        "pinnedRows",
        "searchMode",
        "showMatchRecommendation",
        "tabKeyFunction",
        "tabTargetCommand",
        "spaceOpenCommand",
    ];
    cold["passed"].as_bool() == Some(true)
        && cold["piniaAppFound"].as_bool() == Some(true)
        && cold["windowStoreFound"].as_bool() == Some(true)
        && cold["fieldCount"].as_u64() == Some(FIELDS.len() as u64)
        && cold["tabTargetCommandBytes"].as_u64() == Some(2049)
        && FIELDS
            .iter()
            .all(|field| cold["fieldMatches"][*field].as_bool() == Some(true))
}
