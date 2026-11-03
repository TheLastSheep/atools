use serde_json::Value;
pub(super) fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k)))
}
fn nullable_bool(v: &Value) -> bool {
    v.is_null() || v.is_boolean()
}
fn text(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() <= max && !s.contains('\0'))
}
fn nullable_text(v: &Value, max: usize) -> bool {
    v.is_null() || text(v, max)
}
fn hex(v: &Value, len: usize) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(super) fn parse(value: Value) -> Result<(Value, Value), String> {
    if serde_json::to_vec(&value).map_or(true, |b| b.len() > 8192)
        || !exact(&value, &["dom", "receipt"])
    {
        return Err("about-receipt-invalid".into());
    }
    let d = &value["dom"];
    if !exact(
        d,
        &[
            "ready",
            "title",
            "text",
            "appVersion",
            "autoChecked",
            "checkDisabled",
            "bridgePresent",
            "disposed",
            "bundleRevision",
        ],
    ) || !d["ready"].is_boolean()
        || !text(&d["title"], 256)
        || !text(&d["text"], 2048)
        || !nullable_text(&d["appVersion"], 128)
        || !nullable_bool(&d["autoChecked"])
        || !nullable_bool(&d["checkDisabled"])
        || !d["bridgePresent"].is_boolean()
        || !nullable_bool(&d["disposed"])
        || !(d["bundleRevision"].is_null() || hex(&d["bundleRevision"], 64))
    {
        return Err("about-dom-invalid".into());
    }
    let r = &value["receipt"];
    if !r.is_null() {
        if !exact(r, &["version", "manual", "auto", "apiCalls", "negative"])
            || !nullable_text(&r["version"], 128)
        {
            return Err("about-receipt-invalid".into());
        }
        let m = &r["manual"];
        if !m.is_null()
            && (!exact(m, &["success", "hasUpdate", "status", "version"])
                || m["success"] != true
                || m["hasUpdate"] != true
                || m["version"] != "99.78.0"
                || m["status"] != "available")
        {
            return Err("about-manual-receipt-invalid".into());
        }
        let a = &r["auto"];
        if !a.is_null() {
            if !exact(
                a,
                &[
                    "revision",
                    "autoValue",
                    "notificationDelivered",
                    "runtimeApplied",
                    "runtimeError",
                ],
            ) || !hex(&a["revision"], 32)
                || !["autoValue", "notificationDelivered", "runtimeApplied"]
                    .iter()
                    .all(|k| a[*k].is_boolean())
            {
                return Err("about-auto-receipt-invalid".into());
            }
            let e = &a["runtimeError"];
            if a["runtimeApplied"] == true && !e.is_null()
                || a["runtimeApplied"] == false
                    && (!exact(e, &["code", "message"])
                        || !text(&e["message"], 2048)
                        || !e["code"].as_str().is_some_and(|s| {
                            matches!(
                                s,
                                "SETTINGS_UPDATER_RUNTIME_UNAVAILABLE"
                                    | "SETTINGS_UPDATER_PROVIDER_DISABLED"
                                    | "SETTINGS_UPDATER_PROVIDER_UNAVAILABLE"
                                    | "SETTINGS_UPDATER_RUNTIME_STOPPED"
                            )
                        }))
            {
                return Err("about-auto-receipt-invalid".into());
            }
        }
        let c = &r["apiCalls"];
        if !c.is_null()
            && (!exact(c, &["version", "manual", "auto"])
                || !["version", "manual", "auto"]
                    .iter()
                    .all(|k| c[*k].as_u64().is_some_and(|n| n <= 2)))
        {
            return Err("about-call-count-invalid".into());
        }
        let n = &r["negative"];
        if !n.is_null()
            && (!exact(n, &["badToken", "wrongFrame"])
                || !n["badToken"].is_boolean()
                || !n["wrongFrame"].is_boolean())
        {
            return Err("about-negative-receipt-invalid".into());
        }
    }
    Ok((d.clone(), r.clone()))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bounds_and_unknown_receipts_fail() {
        assert!(parse(json!({})).is_err());
        assert!(parse(json!({"dom":null,"receipt":null,"extra":1})).is_err());
        assert!(parse(json!({"dom":{"text":"x".repeat(8193)},"receipt":null})).is_err());
    }
}
