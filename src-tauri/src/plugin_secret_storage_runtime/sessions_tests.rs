use super::{
    crypto,
    sessions::Sessions,
    types::{Binding, Owner, Session},
};
use serde_json::json;
use std::sync::{Arc, Barrier};

fn owner(window: &str, n: u128) -> Owner {
    Owner::new(
        window,
        "fixture-plugin",
        &uuid::Uuid::from_u128(n).to_string(),
    )
    .unwrap()
}

#[test]
fn preparation_capacity_is_bounded_and_does_not_start_transport() {
    let runtime = Arc::new(Sessions::default());
    let _a = runtime.begin(owner("main", 1), None).unwrap();
    let _b = runtime.begin(owner("main", 2), None).unwrap();
    let _c = runtime.begin(owner("main", 3), None).unwrap();
    let _d = runtime.begin(owner("main", 4), None).unwrap();
    assert!(runtime.begin(owner("main", 5), None).is_err());
    assert!(runtime.server.try_lock().unwrap().is_none());
    assert_eq!(runtime.store.lock().preparations.len(), 4);
}

#[test]
fn preparations_are_isolated_by_window_and_duplicate_owner() {
    let runtime = Arc::new(Sessions::default());
    let main_owner = owner("main", 10);
    let _first = runtime.begin(main_owner.clone(), None).unwrap();
    assert!(runtime.begin(main_owner, None).is_err());
    assert!(runtime.begin(owner("other", 11), None).is_ok());
}

#[test]
fn document_close_cancels_pending_approval_and_fences_preparation_reuse() {
    let runtime = Arc::new(Sessions::default());
    let (document, _) = crate::plugin_page_runtime::test_binding();
    let document_id = document.id().to_owned();
    let binding = Binding {
        path: "/fixture/plugin".into(),
        version: "1".into(),
        revision: None,
    };
    let owner_a = owner("main", 20);
    let prep_a = runtime
        .begin(owner_a.clone(), Some(document_id.clone()))
        .unwrap();
    let intent = runtime
        .intent(prep_a, binding.clone(), Some(document.clone()))
        .unwrap();
    assert!(runtime.bind_run(&intent, "pending-approval"));
    let prep_b = runtime
        .begin(owner("main", 21), Some(document_id.clone()))
        .unwrap();

    let cancelled = runtime.close_document(&document_id);
    assert_eq!(cancelled, vec!["pending-approval".to_owned()]);
    assert!(!runtime.store.lock().intents.contains_key(&intent));
    assert!(runtime
        .intent(prep_b, binding.clone(), Some(document))
        .is_err());
    assert!(runtime
        .open(&intent, &binding, crypto::new_key(), None)
        .is_err());

    let (replacement, _) = crate::plugin_page_runtime::test_binding();
    let replacement_id = replacement.id().to_owned();
    let prep = runtime.begin(owner_a, Some(replacement_id)).unwrap();
    assert!(runtime.intent(prep, binding, Some(replacement)).is_ok());
}

#[test]
fn close_and_crypto_completion_have_a_single_linearization_order() {
    fn opened() -> (
        Arc<Sessions>,
        Arc<Session>,
        Arc<super::types::Invocation>,
        Owner,
    ) {
        let runtime = Arc::new(Sessions::default());
        let owner = owner("main", 30);
        let binding = Binding {
            path: "/fixture/plugin".into(),
            version: "1".into(),
            revision: None,
        };
        let preparation = runtime.begin(owner.clone(), None).unwrap();
        let intent = runtime.intent(preparation, binding.clone(), None).unwrap();
        let session = runtime
            .open(&intent, &binding, crypto::new_key(), None)
            .unwrap();
        let (ticket, invocation) = runtime
            .invoke(&session, json!({"method":"decrypt"}))
            .unwrap();
        assert!(runtime.bind_invocation(&ticket, "crypto-run"));
        (runtime, session, invocation, owner)
    }

    let (runtime, session, invocation, owner) = opened();
    let committed = runtime.finish_operation(&session, &invocation, Ok(json!({"text":"done"})));
    assert_eq!(committed.unwrap(), json!({"text":"done"}));
    assert!(runtime.close(Some(&owner), None, None, false).is_empty());
    assert_eq!(
        invocation.result.lock().as_ref().unwrap().as_ref().unwrap(),
        &json!({"text":"done"})
    );

    let (runtime, session, invocation, owner) = opened();
    assert_eq!(
        runtime.close(Some(&owner), None, None, false),
        vec!["crypto-run".to_owned()]
    );
    let rejected =
        runtime.finish_operation(&session, &invocation, Ok(json!({"text":"must not commit"})));
    assert_eq!(rejected.unwrap_err(), "SESSION_UNAVAILABLE");
    assert_eq!(
        invocation
            .result
            .lock()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap_err(),
        "SESSION_UNAVAILABLE"
    );
}

#[test]
fn oversized_serialized_response_is_committed_as_an_audited_error() {
    let runtime = Arc::new(Sessions::default());
    let owner = owner("main", 31);
    let binding = Binding {
        path: "/fixture/plugin".into(),
        version: "1".into(),
        revision: None,
    };
    let preparation = runtime.begin(owner, None).unwrap();
    let intent = runtime.intent(preparation, binding.clone(), None).unwrap();
    let session = runtime
        .open(&intent, &binding, crypto::new_key(), None)
        .unwrap();
    let (_, invocation) = runtime
        .invoke(&session, json!({"method":"decrypt"}))
        .unwrap();
    let expanded =
        json!({"text":"\0".repeat(crate::plugin_secret_storage_runtime::registry::MAX_TEXT_BYTES)});
    let result = super::transport::validate_response_size(&expanded).map(|()| expanded);
    assert_eq!(result.as_ref().unwrap_err(), "RESPONSE_TOO_LARGE");
    let committed = runtime.finish_operation(&session, &invocation, result);
    assert_eq!(committed.unwrap_err(), "RESPONSE_TOO_LARGE");
    assert_eq!(
        invocation
            .result
            .lock()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap_err(),
        "RESPONSE_TOO_LARGE"
    );
}

#[test]
fn concurrent_close_and_crypto_commit_never_cancel_a_committed_success() {
    for sequence in 40..72 {
        let runtime = Arc::new(Sessions::default());
        let owner = owner("main", sequence);
        let binding = Binding {
            path: "/fixture/plugin".into(),
            version: "1".into(),
            revision: None,
        };
        let preparation = runtime.begin(owner.clone(), None).unwrap();
        let intent = runtime.intent(preparation, binding.clone(), None).unwrap();
        let session = runtime
            .open(&intent, &binding, crypto::new_key(), None)
            .unwrap();
        let (ticket, invocation) = runtime
            .invoke(&session, json!({"method":"decrypt"}))
            .unwrap();
        let run = format!("crypto-run-{sequence}");
        assert!(runtime.bind_invocation(&ticket, &run));

        let start = Arc::new(Barrier::new(3));
        let close_runtime = runtime.clone();
        let close_owner = owner.clone();
        let close_start = start.clone();
        let closer = std::thread::spawn(move || {
            close_start.wait();
            close_runtime.close(Some(&close_owner), None, None, false)
        });
        let finish_runtime = runtime.clone();
        let finish_session = session.clone();
        let finish_invocation = invocation.clone();
        let finish_start = start.clone();
        let finisher = std::thread::spawn(move || {
            finish_start.wait();
            finish_runtime.finish_operation(
                &finish_session,
                &finish_invocation,
                Ok(json!({"text":"complete"})),
            )
        });
        start.wait();
        let cancelled = closer.join().unwrap();
        let completion = finisher.join().unwrap();
        let recorded = invocation.result.lock().clone().unwrap();
        match recorded {
            Ok(value) => {
                assert_eq!(value, json!({"text":"complete"}));
                assert!(completion.is_ok());
                assert!(cancelled.is_empty(), "committed run must not be cancelled");
            }
            Err(error) => {
                assert_eq!(error, "SESSION_UNAVAILABLE");
                assert_eq!(completion.unwrap_err(), "SESSION_UNAVAILABLE");
                assert_eq!(cancelled, vec![run], "close-first run must be cancelled");
            }
        }
    }
}
