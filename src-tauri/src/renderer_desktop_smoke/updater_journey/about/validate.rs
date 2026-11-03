use super::*;
use serde_json::Value;
pub(super) fn row(h: &Harness, stage: &str, row: &Value, version: &str) -> Result<(), String> {
    let d = &row["dom"];
    let r = &row["receipt"];
    let n = &row["native"];
    let s = &n["settings"];
    let u = &n["updater"];
    let g = &n["general"];
    let runtime = &n["runtime"];
    if row["sourceKind"] != "native" && d["ready"] != true {
        return Err(format!("about-{stage}-dom-rejected"));
    }
    if g["sentinelMatches"] != true {
        return Err("about-general-sentinel-changed".into());
    }
    let child = matches!(
        stage,
        "about-ready" | "about-manual" | "auto-on" | "auto-off" | "about-reopened"
    );
    if child
        && (s["sessionCount"] != 1
            || s["childCount"] != 1
            || s["ready"] != true
            || s["revoked"] != false
            || s["documentAuthorized"] != true)
    {
        return Err("about-child-facts-rejected".into());
    }
    if matches!(stage, "about-ready" | "about-reopened")
        && (d["appVersion"] != format!("v{version}")
            || r["version"] != version
            || d["autoChecked"] != false
            || g["autoCheckUpdate"] != false
            || d["bundleRevision"] != s["compiledBundleRevision"])
    {
        return Err("about-version-or-persistence-rejected".into());
    }
    let expected_calls = match stage {
        "about-ready" | "about-reopened" => Some((1, 0, 0)),
        "about-manual" => Some((1, 1, 0)),
        "auto-on" => Some((1, 1, 1)),
        "auto-off" => Some((1, 1, 2)),
        _ => None,
    };
    if let Some((version, manual, auto)) = expected_calls {
        if r["apiCalls"]["version"] != version
            || r["apiCalls"]["manual"] != manual
            || r["apiCalls"]["auto"] != auto
        {
            return Err("about-api-call-count-rejected".into());
        }
    }
    let valid = match stage {
        "main-ready" => {
            r["negative"]["badToken"] == true
                && r["negative"]["wrongFrame"] == true
                && u["windowCount"] == 0
                && g["autoCheckUpdate"] == false
        }
        "about-ready" => true,
        "about-manual" => {
            r["manual"]["success"] == true
                && r["manual"]["hasUpdate"] == true
                && r["manual"]["version"] == "99.78.0"
                && u["candidateId"].as_str().is_some_and(auth::valid_id)
        }
        "popup-ready" => {
            u["ready"] == true
                && u["alive"] == true
                && u["closing"] == false
                && u["windowCount"] == 1
                && u["opening"] == false
                && u["busy"] == false
                && d["bridgePresent"] == true
                && d["title"].as_str().is_some_and(|s| s.contains("99.78.0"))
        }
        "auto-on" | "auto-off" => {
            let enabled = stage == "auto-on";
            r["auto"]["autoValue"] == enabled
                && r["auto"]["runtimeApplied"] == true
                && r["auto"]["runtimeError"].is_null()
                && r["auto"]["notificationDelivered"] == true
                && d["autoChecked"] == enabled
                && g["autoCheckUpdate"] == enabled
                && g["onlyAutoFieldChanged"] == true
                && runtime["scheduler"]["enabled"] == enabled
        }
        "settings-closed" | "settings-final-closed" => {
            settings_empty(s) && u["windowCount"] == 1 && u["alive"] == true
        }
        "about-reopened" => state(h)?
            .rows()
            .iter()
            .find(|r| r["stage"] == "about-ready")
            .is_some_and(|first| first["sessionId"] != row["sessionId"]),
        "popup-disposed" => d["bridgePresent"] == false && d["disposed"] == true,
        "main-disposed" => {
            d["disposed"] == true
                && d["bridgePresent"] == false
                && resources_empty(n)
                && runtime["scheduler"]["stopped"] == true
                && runtime["scheduler"]["enabled"] == false
        }
        _ => false,
    };
    if !valid {
        return Err(format!("about-{stage}-facts-rejected"));
    }
    if matches!(
        stage,
        "popup-ready"
            | "auto-on"
            | "auto-off"
            | "settings-closed"
            | "about-reopened"
            | "settings-final-closed"
    ) {
        let manual = state(h)?
            .get("about-manual")
            .ok_or("about-manual-not-observed")?;
        if u["candidateId"] != manual["native"]["updater"]["candidateId"]
            || u["sessionCandidateId"] != u["candidateId"]
        {
            return Err("about-candidate-changed".into());
        }
        if stage != "popup-ready" {
            let popup = state(h)?
                .get("popup-ready")
                .ok_or("about-popup-not-observed")?;
            if u["sessionId"] != popup["native"]["updater"]["sessionId"] {
                return Err("about-popup-generation-changed".into());
            }
        }
    }
    if stage == "auto-off" {
        let first = state(h)?
            .get("about-ready")
            .ok_or("about-baseline-missing")?;
        let on = state(h)?.get("auto-on").ok_or("about-auto-on-missing")?;
        if g["rawSha256"] != first["native"]["general"]["rawSha256"]
            || r["auto"]["revision"] == on["receipt"]["auto"]["revision"]
        {
            return Err("about-cas-baseline-rejected".into());
        }
    }
    Ok(())
}
pub(super) fn settings_empty(s: &Value) -> bool {
    s["sessionCount"] == 0
        && s["childCount"] == 0
        && s["pendingCalls"] == 0
        && s["pendingWrites"] == 0
}
pub(super) fn resources_empty(n: &Value) -> bool {
    settings_empty(&n["settings"])
        && n["updater"]["windowCount"] == 0
        && n["updater"]["sessionId"].is_null()
        && n["updater"]["opening"] == false
        && n["updater"]["busy"] == false
        && n["runtime"]["manualSlotCount"] == 0
        && n["runtime"]["scheduler"]["workerActive"] == false
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn missing_or_unfinished_resources_never_pass() {
        assert!(!resources_empty(&json!({})));
        assert!(!settings_empty(
            &json!({"sessionCount":0,"childCount":1,"pendingCalls":0,"pendingWrites":0})
        ));
    }
}
