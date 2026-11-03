use serde_json::{json, Value};

const POLICIES: &[&str] = &["none", "suspend", "throttle", "unsupported"];

pub(super) fn empty_diagnostics() -> Value {
    json!({"light": Value::Null, "dark": Value::Null})
}

pub(super) fn set_diagnostic(report: &mut Value, theme: &str, record: Option<Value>) {
    if !matches!(theme, "light" | "dark") {
        return;
    }
    let record = record.filter(valid_record).unwrap_or(Value::Null);
    report["paintDiagnostics"][theme] = record;
}

fn valid_record(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == 2
        && object.contains_key("nativeSchedulingPolicy")
        && object.contains_key("observations")
        && value["nativeSchedulingPolicy"]
            .as_str()
            .is_some_and(|policy| POLICIES.contains(&policy))
        && super::paint_schema::validate_evidence(&value["observations"]).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{empty_diagnostics, set_diagnostic};
    use serde_json::{json, Value};

    fn observations() -> Value {
        json!({
            "documentHidden": true,
            "before": {
                "sidebar": {
                    "generalUnique": false,
                    "generalActive": false,
                    "generalColorComparable": false,
                    "generalColorUsesPrimary": false,
                    "shortcutUnique": false,
                    "shortcutInactive": false,
                    "shortcutColorComparable": false,
                    "shortcutColorUsesText": false
                },
                "menus": {
                    "total": 0,
                    "body": 0,
                    "theme": 0,
                    "leave": 0,
                    "enter": 0,
                    "ownersOpen": 0,
                    "visible": 0
                }
            },
            "after": {
                "sidebar": {
                    "generalUnique": false,
                    "generalActive": false,
                    "generalColorComparable": false,
                    "generalColorUsesPrimary": false,
                    "shortcutUnique": false,
                    "shortcutInactive": false,
                    "shortcutColorComparable": false,
                    "shortcutColorUsesText": false
                },
                "menus": {
                    "total": 0,
                    "body": 0,
                    "theme": 0,
                    "leave": 0,
                    "enter": 0,
                    "ownersOpen": 0,
                    "visible": 0
                }
            },
            "rafCallbacks": 0,
            "elapsedMs": 1000,
            "timedOut": true
        })
    }

    #[test]
    fn defaults_to_null_and_records_only_valid_diagnostics() {
        let mut report = json!({"paintDiagnostics": empty_diagnostics()});
        assert_eq!(report["paintDiagnostics"]["light"], Value::Null);
        set_diagnostic(
            &mut report,
            "light",
            Some(json!({
                "nativeSchedulingPolicy": "suspend",
                "observations": observations()
            })),
        );
        assert_eq!(
            report["paintDiagnostics"]["light"]["nativeSchedulingPolicy"],
            "suspend"
        );
        set_diagnostic(
            &mut report,
            "dark",
            Some(json!({
                "nativeSchedulingPolicy": "unknown",
                "observations": observations()
            })),
        );
        assert_eq!(report["paintDiagnostics"]["dark"], Value::Null);
    }
}
