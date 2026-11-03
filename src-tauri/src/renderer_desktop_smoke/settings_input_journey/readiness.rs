use serde_json::Value;

pub(super) fn main_search_input_is_ready(native: &Value, main: &Value) -> bool {
    let sub_input = &native["subInput"];
    native["sessionCount"].as_u64() == Some(1)
        && native["pendingCalls"].as_u64() == Some(0)
        && native["pendingWrites"].as_u64() == Some(0)
        && sub_input["visible"].as_bool() == Some(true)
        && sub_input["generation"]
            .as_u64()
            .is_some_and(|value| value > 0)
        && sub_input["valueBytes"].as_u64() == Some(0)
        && main["inputFound"].as_bool() == Some(true)
        && main["inputEmpty"].as_bool() == Some(true)
}

#[cfg(test)]
mod tests {
    use super::main_search_input_is_ready;
    use serde_json::json;

    fn evidence() -> (serde_json::Value, serde_json::Value) {
        (
            json!({
                "sessionCount": 1,
                "pendingCalls": 0,
                "pendingWrites": 0,
                "subInput": {
                    "visible": true,
                    "generation": 2,
                    "valueBytes": 0
                }
            }),
            json!({"inputFound": true, "inputEmpty": true}),
        )
    }

    #[test]
    fn accepts_only_an_active_empty_main_search_input_with_drained_native_work() {
        let (native, main) = evidence();
        assert!(main_search_input_is_ready(&native, &main));
    }

    #[test]
    fn rejects_invisible_input_and_nonzero_pending_work() {
        let (mut native, main) = evidence();
        native["subInput"]["visible"] = json!(false);
        assert!(!main_search_input_is_ready(&native, &main));

        let (mut native, main) = evidence();
        native["pendingCalls"] = json!(1);
        assert!(!main_search_input_is_ready(&native, &main));

        let (mut native, main) = evidence();
        native["pendingWrites"] = json!(1);
        assert!(!main_search_input_is_ready(&native, &main));
    }

    #[test]
    fn rejects_unknown_owner_or_nonempty_or_missing_main_input() {
        let (mut native, main) = evidence();
        native["subInput"]["generation"] = json!(0);
        assert!(!main_search_input_is_ready(&native, &main));

        let (mut native, main) = evidence();
        native["subInput"]["generation"] = json!(null);
        assert!(!main_search_input_is_ready(&native, &main));

        let (native, mut main) = evidence();
        main["inputEmpty"] = json!(false);
        assert!(!main_search_input_is_ready(&native, &main));

        let (native, mut main) = evidence();
        main["inputFound"] = json!(false);
        assert!(!main_search_input_is_ready(&native, &main));
    }
}
