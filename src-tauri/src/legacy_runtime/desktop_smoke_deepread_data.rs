//! Bounded, path-free read-only projection of DeepRead's two pinned dbStorage keys.
use atools_core::{task_run::TaskRunStatus, Database};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CASE_ID: &str = "converted-deepread-source";
const PLUGIN_ID: &str = "deepread";
const BOOK_TITLE: &str = "ATools DeepRead Reader Fixture";
const LIBRARY_KEY: &str = "deepread.library.v1";
const LAST_BOOK_KEY: &str = "deepread.lastBookId.v1";
const MAX_BYTES: usize = 256 * 1024;

fn approved(profile: &Value) -> Result<(), String> {
    if profile["caseId"] == CASE_ID
        && profile["id"] == PLUGIN_ID
        && profile["sourceKind"] == "converted_handoff_directory"
        && profile["dataAccess"] == true
        && profile["verifyDataPersistence"] == true
    {
        Ok(())
    } else {
        Err("No DeepRead storage projection is approved for this fixture".into())
    }
}

fn bounded_value(db: &Database, key: &str) -> Result<Value, String> {
    let value = db
        .plugin_storage_get(PLUGIN_ID, key)
        .map_err(|_| "DeepRead storage is unavailable".to_owned())?;
    let bytes =
        serde_json::to_vec(&value).map_err(|_| "DeepRead storage value is invalid".to_owned())?;
    if bytes.len() > MAX_BYTES {
        return Err("DeepRead storage value exceeded its evidence budget".into());
    }
    if let Some(text) = value.as_str() {
        if text.len() > MAX_BYTES {
            return Err("DeepRead storage value exceeded its evidence budget".into());
        }
        if key == LIBRARY_KEY {
            // Match the original storage.get fallback: JSON-encoded arrays decode, while
            // a non-JSON string remains a string and is rejected by the library shape check.
            return Ok(
                serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned()))
            );
        }
        if key == LAST_BOOK_KEY {
            if text.is_empty() {
                return Ok(Value::Null);
            }
            return match serde_json::from_str::<Value>(text) {
                Ok(Value::String(decoded)) => Ok(Value::String(decoded)),
                Ok(Value::Null) => Ok(Value::Null),
                Ok(_) => Err("DeepRead selected-book storage has an invalid shape".into()),
                Err(_) => Ok(Value::String(text.to_owned())),
            };
        }
    }
    if key == LAST_BOOK_KEY && !value.is_null() {
        return Err("DeepRead selected-book storage has an invalid shape".into());
    }
    Ok(value)
}

fn library_projection(db: &Database) -> Result<Value, String> {
    let library = bounded_value(db, LIBRARY_KEY)?;
    let empty_books = Vec::new();
    let books = match &library {
        Value::Null => &empty_books,
        Value::Array(books) => books,
        _ => return Err("DeepRead library must be an array or absent".into()),
    };
    if books.len() > 50 {
        return Err("DeepRead library exceeds the fixture evidence cap".into());
    }
    let book = books
        .iter()
        .find(|book| book["title"] == BOOK_TITLE && book["kind"] == "local");
    let last_book = bounded_value(db, LAST_BOOK_KEY)?;
    let selected = book.is_some_and(|book| {
        book["id"]
            .as_str()
            .is_some_and(|id| last_book.as_str() == Some(id))
    });
    let progress = book.and_then(|book| book["progressIndex"].as_u64());
    let content = book.and_then(|book| book["content"].as_str());
    let content_bytes = content.map(|value| value.as_bytes().len());
    let content_sha256 = content.map(|value| format!("{:x}", Sha256::digest(value.as_bytes())));
    Ok(
        json!({"pluginId":PLUGIN_ID,"bookCount":books.len(),"fixtureBookPresent":book.is_some(),
        "lastBookSelected":selected,"progressIndex":progress,"progressAdvanced":progress.is_some_and(|value| value > 0),
        "contentBytes":content_bytes,"contentSha256":content_sha256,
        "pathStored":book.is_some_and(|item| item["path"].as_str().is_some_and(|path| !path.is_empty())),
        "storageKeys":[LIBRARY_KEY,LAST_BOOK_KEY],"source":"isolated SQLite plugin dbStorage projection","readOnly":true}),
    )
}

pub(super) fn snapshot(db: &Database, profile: &Value) -> Result<Value, String> {
    approved(profile)?;
    library_projection(db)
}

pub(super) fn audit(db: &Database, profile: &Value) -> Result<Value, String> {
    approved(profile)?;
    let capability = crate::plugin_data_runtime::registry::tool_name(PLUGIN_ID);
    let runs = db
        .list_task_runs(1000)
        .map_err(|_| "Unable to inspect DeepRead data TaskRuns")?;
    let selected = runs
        .iter()
        .filter(|run| run.capability_id == capability)
        .collect::<Vec<_>>();
    // The audit covers the full selected capability lifecycle, not just the successful
    // writes. Missing and foreign callers are failures rather than silently skipped runs.
    if selected
        .iter()
        .any(|run| run.initiator.client_id.as_deref() != Some("atools-ui"))
    {
        return Err("DeepRead data TaskRuns included an unowned caller".into());
    }
    let methods = selected
        .iter()
        .filter_map(|run| run.input["method"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let methods_exact = selected.iter().all(|run| {
        match run.input["method"].as_str() {
            Some(method) => matches!(
                method,
                "dbStorage.getItem" | "dbStorage.setItem" | "webStorage.getItem"
            ),
            // The source-backed session setup is operation=open with its bound intent, not a storage method.
            None => {
                run.input["method"].is_null()
                    && run
                        .input
                        .as_object()
                        .is_some_and(|fields| fields.len() == 2)
                    && run.input["operation"] == "open"
                    && run.input["intentId"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty())
            }
        }
    });
    let content_marker = "ATools DeepRead fixed reading line";
    let private_markers_absent = runs.iter().all(|run| {
        serde_json::to_string(run).is_ok_and(|text| {
            !text.contains(content_marker)
                && !text.contains("ATools-DeepRead-Reader-Fixture.txt")
                && !text.contains("/private/tmp/atools-fixture-environment-")
        })
    });
    let projection = library_projection(db)?;
    let required = ["dbStorage.getItem", "dbStorage.setItem"];
    let verified = required.iter().all(|method| methods.contains(method))
        && selected
            .iter()
            .all(|run| run.status == TaskRunStatus::Succeeded);
    Ok(
        json!({"count":selected.len(),"methods":methods,"allTerminal":selected.iter().all(|run|run.status.is_terminal()),
        "allSucceeded":selected.iter().all(|run|run.status==TaskRunStatus::Succeeded),
        "methodsWithinAllowlist":methods_exact,"requiredMethodsObserved":verified,
        "fixtureBookPersisted":projection["fixtureBookPresent"],"lastBookSelected":projection["lastBookSelected"],
        "progressAdvanced":projection["progressAdvanced"],"privateMarkersAbsent":private_markers_absent,
        "source":"isolated SQLite TaskRun method projection plus two dbStorage values; read-only"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn register_plugin(db: &Database, id: &str) {
        db.save_plugin(&serde_json::from_value(json!({"id":id,"name":id,"version":"1.0.0","path":"/inert",
            "enabled":true,"manifest":{"name":id,"version":"1.0.0"},"created_at":"now","updated_at":"now"})).unwrap()).unwrap();
    }

    #[test]
    fn absent_library_matches_original_empty_default_and_malformed_nonnull_is_rejected() {
        let db = Database::in_memory().unwrap();
        let profile = json!({"caseId":CASE_ID,"id":PLUGIN_ID,"sourceKind":"converted_handoff_directory",
            "dataAccess":true,"verifyDataPersistence":true});
        let empty = snapshot(&db, &profile).unwrap();
        assert_eq!(empty["bookCount"], 0);
        assert_eq!(empty["fixtureBookPresent"], false);
        assert_eq!(empty["lastBookSelected"], false);
        register_plugin(&db, PLUGIN_ID);
        db.plugin_storage_set(PLUGIN_ID, LIBRARY_KEY, &json!({"unexpected":"shape"}))
            .unwrap();
        assert!(snapshot(&db, &profile).is_err());
        db.plugin_storage_set(PLUGIN_ID, LIBRARY_KEY, &json!("not-json"))
            .unwrap();
        assert!(snapshot(&db, &profile).is_err());
    }

    #[test]
    fn storage_decoding_accepts_raw_book_ids_and_json_encoded_library_values() {
        let db = Database::in_memory().unwrap();
        register_plugin(&db, PLUGIN_ID);
        let encoded_library = serde_json::to_string(&json!([{"id":"book-123","kind":"local",
            "title":BOOK_TITLE,"content":"reader content","progressIndex":0}]))
        .unwrap();
        db.plugin_storage_set(PLUGIN_ID, LIBRARY_KEY, &json!(encoded_library))
            .unwrap();
        db.plugin_storage_set(PLUGIN_ID, LAST_BOOK_KEY, &json!("book-123"))
            .unwrap();
        let profile = json!({"caseId":CASE_ID,"id":PLUGIN_ID,"sourceKind":"converted_handoff_directory",
            "dataAccess":true,"verifyDataPersistence":true});
        let stored_snapshot = snapshot(&db, &profile).unwrap();
        assert_eq!(stored_snapshot["bookCount"], 1);
        assert_eq!(stored_snapshot["lastBookSelected"], true);
        assert_eq!(stored_snapshot["progressIndex"], 0);

        db.plugin_storage_set(PLUGIN_ID, LAST_BOOK_KEY, &json!("\"book-123\""))
            .unwrap();
        assert_eq!(snapshot(&db, &profile).unwrap()["lastBookSelected"], true);
    }

    #[test]
    fn selected_book_storage_rejects_non_string_non_null_shapes() {
        let db = Database::in_memory().unwrap();
        register_plugin(&db, PLUGIN_ID);
        let profile = json!({"caseId":CASE_ID,"id":PLUGIN_ID,"sourceKind":"converted_handoff_directory",
            "dataAccess":true,"verifyDataPersistence":true});
        db.plugin_storage_set(PLUGIN_ID, LAST_BOOK_KEY, &json!(123))
            .unwrap();
        assert!(snapshot(&db, &profile).is_err());
        db.plugin_storage_set(PLUGIN_ID, LAST_BOOK_KEY, &json!("123"))
            .unwrap();
        assert!(snapshot(&db, &profile).is_err());
        db.plugin_storage_set(PLUGIN_ID, LAST_BOOK_KEY, &json!({"id":"book-123"}))
            .unwrap();
        assert!(snapshot(&db, &profile).is_err());
    }

    #[test]
    fn projection_only_reads_exact_pinned_plugin_storage_keys_and_hides_book_contents() {
        let db = Database::in_memory().unwrap();
        register_plugin(&db, PLUGIN_ID);
        register_plugin(&db, "other-plugin");
        db.plugin_storage_set(
            PLUGIN_ID,
            LIBRARY_KEY,
            &json!([{"id":"book-private-id","kind":"local",
            "title":BOOK_TITLE,"path":"/private/fixture/book.txt","content":"private book contents",
            "progressIndex":128}]),
        )
        .unwrap();
        db.plugin_storage_set(PLUGIN_ID, LAST_BOOK_KEY, &json!("book-private-id"))
            .unwrap();
        db.plugin_storage_set("other-plugin", LIBRARY_KEY, &json!([{"title":BOOK_TITLE}]))
            .unwrap();
        let result = snapshot(&db, &json!({"caseId":CASE_ID,"id":PLUGIN_ID,
            "sourceKind":"converted_handoff_directory","dataAccess":true,"verifyDataPersistence":true})).unwrap();
        assert_eq!(result["fixtureBookPresent"], true);
        assert_eq!(result["lastBookSelected"], true);
        assert_eq!(result["progressIndex"], 128);
        assert_eq!(result["contentBytes"], 21);
        assert_eq!(
            result["contentSha256"],
            format!("{:x}", Sha256::digest(b"private book contents"))
        );
        assert!(!result.to_string().contains("private book contents"));
        assert!(!result.to_string().contains("/private/fixture/book.txt"));
        assert!(!result.to_string().contains("book-private-id"));
    }

    #[test]
    fn audit_requires_database_storage_methods_and_rejects_other_or_nonterminal_activity() {
        let db = Database::in_memory().unwrap();
        let profile = json!({"caseId":CASE_ID,"id":PLUGIN_ID,"sourceKind":"converted_handoff_directory",
            "dataAccess":true,"verifyDataPersistence":true});
        let result = audit(&db, &profile).unwrap();
        assert_eq!(result["count"], 0);
        assert_eq!(result["requiredMethodsObserved"], false);
        assert_eq!(result["fixtureBookPersisted"], false);
        assert!(result["allTerminal"].as_bool().unwrap());
        assert!(snapshot(&db, &json!({"caseId":CASE_ID,"id":PLUGIN_ID})).is_err());
    }

    fn record_data_method(db: &Database, id: &str, method: Option<&str>) {
        record_data_method_for_client(db, id, method, Some("atools-ui"));
    }

    fn record_data_method_for_client(
        db: &Database,
        id: &str,
        method: Option<&str>,
        client_id: Option<&str>,
    ) {
        use atools_core::task_run::TaskRunInitiator;
        let mut input = if method.is_some() {
            json!({"operation":"request"})
        } else {
            json!({"operation":"open","intentId":"fixture-intent"})
        };
        if let Some(method) = method {
            input["method"] = json!(method);
        }
        let mut run = atools_core::task_run::TaskRun::new(
            crate::plugin_data_runtime::registry::tool_name(PLUGIN_ID),
            TaskRunInitiator::human(client_id.map(str::to_owned)),
            input,
        );
        run.id = id.to_owned();
        run.status = TaskRunStatus::Succeeded;
        db.upsert_task_run(&run).unwrap();
    }

    #[test]
    fn audit_rejects_same_capability_success_from_foreign_client_after_valid_lifecycle() {
        let db = Database::in_memory().unwrap();
        register_plugin(&db, PLUGIN_ID);
        let profile = json!({"caseId":CASE_ID,"id":PLUGIN_ID,"sourceKind":"converted_handoff_directory",
            "dataAccess":true,"verifyDataPersistence":true});
        record_data_method(&db, "owned-open", None);
        record_data_method(&db, "owned-read", Some("dbStorage.getItem"));
        record_data_method(&db, "owned-write", Some("dbStorage.setItem"));
        assert_eq!(
            audit(&db, &profile).unwrap()["requiredMethodsObserved"],
            true
        );

        record_data_method_for_client(
            &db,
            "foreign-read",
            Some("dbStorage.getItem"),
            Some("other-client"),
        );
        assert_eq!(
            audit(&db, &profile).unwrap_err(),
            "DeepRead data TaskRuns included an unowned caller"
        );
    }

    #[test]
    fn audit_rejects_same_capability_success_with_missing_client() {
        let db = Database::in_memory().unwrap();
        register_plugin(&db, PLUGIN_ID);
        let profile = json!({"caseId":CASE_ID,"id":PLUGIN_ID,"sourceKind":"converted_handoff_directory",
            "dataAccess":true,"verifyDataPersistence":true});
        record_data_method(&db, "owned-open", None);
        record_data_method(&db, "owned-read", Some("dbStorage.getItem"));
        record_data_method(&db, "owned-write", Some("dbStorage.setItem"));
        assert_eq!(
            audit(&db, &profile).unwrap()["requiredMethodsObserved"],
            true
        );

        record_data_method_for_client(&db, "missing-client-read", Some("dbStorage.getItem"), None);
        assert_eq!(
            audit(&db, &profile).unwrap_err(),
            "DeepRead data TaskRuns included an unowned caller"
        );
    }

    #[test]
    fn audit_allows_source_read_fallback_but_rejects_mutating_or_unknown_web_methods() {
        let db = Database::in_memory().unwrap();
        register_plugin(&db, PLUGIN_ID);
        let profile = json!({"caseId":CASE_ID,"id":PLUGIN_ID,"sourceKind":"converted_handoff_directory",
            "dataAccess":true,"verifyDataPersistence":true});
        record_data_method(&db, "open-session", None);
        for (id, method) in [
            ("db-read", "dbStorage.getItem"),
            ("db-write", "dbStorage.setItem"),
            ("web-read", "webStorage.getItem"),
        ] {
            record_data_method(&db, id, Some(method));
        }
        let read_only_audit = audit(&db, &profile).unwrap();
        assert_eq!(read_only_audit["methodsWithinAllowlist"], true);
        assert_eq!(read_only_audit["requiredMethodsObserved"], true);
        assert!(read_only_audit["methods"]
            .as_array()
            .unwrap()
            .iter()
            .any(|method| method.as_str() == Some("webStorage.getItem")));

        record_data_method(&db, "web-write", Some("webStorage.setItem"));
        assert_eq!(
            audit(&db, &profile).unwrap()["methodsWithinAllowlist"],
            false
        );
        record_data_method(&db, "unknown", Some("webStorage.clear"));
        assert_eq!(
            audit(&db, &profile).unwrap()["methodsWithinAllowlist"],
            false
        );

        let db = Database::in_memory().unwrap();
        register_plugin(&db, PLUGIN_ID);
        record_data_method(&db, "malformed-no-method", None);
        let mut malformed = db.get_task_run("malformed-no-method").unwrap().unwrap();
        malformed.input = json!({"operation":"request","intentId":"fixture-intent","method":7});
        db.upsert_task_run(&malformed).unwrap();
        assert_eq!(
            audit(&db, &profile).unwrap()["methodsWithinAllowlist"],
            false
        );
    }
}
