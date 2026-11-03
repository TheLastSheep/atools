use serde_json::{json, Value};

pub fn validate(browser: Value, frames: &[Value], transport: &Value, protocol: &Value) -> Value {
    let mut errors = Vec::<String>::new();
    let checks = [
        "bootstrapHandoff",
        "payloadOriginPreserved",
        "syncHttpWorks",
        "asyncPreflightWorks",
        "foreignHttpDenied",
        "opaqueOriginDenied",
        "replayTicketDenied",
        "navigationIdentityInvalidated",
        "revocationAcknowledged",
        "noUnexpectedPayloadDelivery",
    ];
    if browser["status"] != "complete"
        || browser["errors"]
            .as_array()
            .is_none_or(|rows| !rows.is_empty())
    {
        errors.push("Browser experiment did not complete without errors".into());
    }
    if browser["checks"]
        .as_object()
        .is_none_or(|rows| rows.len() != checks.len())
    {
        errors.push("Incomplete browser invariant schema".into());
    }
    for key in checks {
        if browser["checks"][key] != true {
            errors.push(format!("Browser invariant failed: {key}"));
        }
    }
    let children = browser["children"].as_array();
    if children.is_none_or(|rows| rows.len() != 2) {
        errors.push("Expected exactly two independently delivered plugin documents".into());
    }
    for frame in frames {
        let id = frame["id"].as_str().unwrap();
        let child = children.and_then(|rows| rows.iter().find(|row| row["id"] == id));
        if child.is_none_or(|row| {
            row["origin"] != frame["expectedOrigin"]
                || row["noTauri"] != true
                || row["markerReceived"] != true
                || row["syncOk"] != true
                || row["asyncOk"] != true
                || row["foreignDenied"] != true
                || row["bindingReplayRejected"] != true
                || row["bindingRejectionCount"] != 2
                || row["payloadAttemptCount"] != 3
                || row["bindingRejectionKinds"].as_array().is_none_or(|kinds| {
                    kinds.len() != 2
                        || !kinds.contains(&json!("docNonce"))
                        || !kinds.contains(&json!("generation"))
                })
                || row["errorCodes"]
                    .as_array()
                    .is_none_or(|codes| !codes.is_empty())
        }) {
            errors.push(format!(
                "Actual document/transport evidence incomplete: {id}"
            ));
        }
        if browser["deliveryCount"][id] != 1 {
            errors.push(format!("Unexpected HTML delivery count: {id}"));
        }
    }
    for key in [
        "noTauri",
        "parentDomDenied",
        "siblingDomDenied",
        "beforeRevocationDenied",
        "afterRevocationDenied",
    ] {
        if browser["opaque"][key] != true {
            errors.push(format!("Opaque document evidence incomplete: {key}"));
        }
    }
    if browser["opaque"]["eventOrigin"] != "null" {
        errors.push("Raw executable HTML did not remain opaque".into());
    }
    if browser["navigation"]["windowProxyUnchanged"] != true
        || browser["navigation"]["oldGenerationInvalidated"] != true
        || browser["revoked"]["ack"] != true
    {
        errors.push("Navigation/revocation evidence incomplete".into());
    }
    let entries = transport["entered"].as_array();
    if entries.is_none_or(|rows| rows.len() != 4) {
        errors.push("Expected exactly four native handler entries".into());
    }
    for id in ["a", "b"] {
        for phase in ["sync", "async"] {
            if entries.is_none_or(|rows| {
                rows.iter()
                    .filter(|row| row["session"] == id && row["id"] == id && row["phase"] == phase)
                    .count()
                    != 1
            }) {
                errors.push(format!(
                    "Native handler identity/count mismatch: {id}/{phase}"
                ));
            }
        }
    }
    if transport["revokedRequestCount"].as_u64().unwrap_or(0) == 0 {
        errors.push("No native rejection of an actual revoked-token request".into());
    }
    if transport["preflightAccepted"].as_u64().unwrap_or(0) < 2 {
        errors.push(
            "Actual successful preflight requests were not observed for both JSON calls".into(),
        );
    }
    if transport["originRejected"].as_u64().unwrap_or(0) < 3 {
        errors.push("Native foreign/null Origin rejection evidence is incomplete".into());
    }
    if transport["authenticationRejected"].as_u64().unwrap_or(0) == 0 {
        errors.push("Native authentication rejection was not observed".into());
    }
    if protocol["truncated"] != false {
        errors.push("Protocol observation exceeded its budget".into());
    }
    let requests = protocol["entries"].as_array();
    if requests.is_none_or(|rows| {
        !rows.iter().any(|row| {
            row["id"] == "b"
                && row["kind"] == "bootstrap"
                && row["status"] == 410
                && row["scriptlessError"] == true
        })
    }) {
        errors.push("Native server did not reject the consumed foreign bootstrap ticket".into());
    }
    json!({"status":if errors.is_empty(){"pass"}else{"failed"},"productionReady":false,"errors":errors,
        "scope":"Synthetic single-use bootstrap/MessageChannel document handoff and real shared HTTP transport. No original plugin, production host, system permission or database is loaded.",
        "browser":browser,"transport":transport,"protocol":protocol,
        "remaining":["Production trusted-parent preparation and lifecycle integration","Permission/result cancellation and all four runtime owners","BrowserWindow children and storage/worker limits","Original file-tree save/PNG and production process performance"]})
}
