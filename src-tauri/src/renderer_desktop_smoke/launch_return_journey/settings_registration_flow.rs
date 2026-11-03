//! Runs the original Main and Settings Child against an owned, initially empty local registry.
use super::{
    protocol::Harness, settings_registration_fixtures as fixtures,
    settings_registration_focus as focus, settings_registration_observe as observe,
    settings_registration_report as report, settings_registration_transport::Transport,
    settings_registration_verify as verify,
};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const ALIAS: &str = "ATools R68 Alias";

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let mut evidence = report::initial(harness.profile());
    evidence["status"] = json!("failed");
    harness.set_registration(evidence.clone());
    let result = run_inner(app, harness, &mut evidence).await;
    if result.is_err() {
        crate::renderer_settings_view::stop(app);
    }
    harness.set_registration(evidence);
    result
}

async fn run_inner(
    app: &AppHandle<Wry>,
    harness: &Harness,
    evidence: &mut Value,
) -> Result<(), &'static str> {
    harness
        .profile()
        .validate_settings_child_fixture()
        .map_err(|_| "settings-registration-fixture-owner-rejected")?;
    harness.wait_probe_ready(Duration::from_secs(20)).await?;
    let main =
        crate::window::main_webview(app).map_err(|_| "settings-registration-main-unavailable")?;
    let paths = fixtures::paths(harness.profile());
    let (initial_rows, initial_revision) = observe::rows(harness)?;
    verify::require(
        initial_rows.is_empty() && initial_revision == 0,
        "settings-registration-initial-state-not-empty",
    )?;
    evidence["initial"] = json!({"rows":initial_rows,"revision":initial_revision});
    let mut transport = Transport::new();
    let initial = observe::main_counters(&mut transport, app, &main, None, None).await?;
    let base_events = initial["deliveredEvents"]
        .as_u64()
        .ok_or("settings-registration-main-counters-invalid")?;
    verify::require(
        initial["openCalls"] == 0 && initial["launchCalls"] == 0,
        "settings-registration-main-counters-invalid",
    )?;
    evidence["mainEvents"] =
        json!({"initial":base_events,"dropped":null,"aliased":null,"cleaned":null});
    evidence["mainCalls"] = json!({"initialOpen":initial["openCalls"],"firstOpen":null,"secondOpen":null,
        "initialLaunch":initial["launchCalls"],"afterAliasSearch":null,"finalLaunch":null});
    record_focus(app, harness, evidence, "baseline").await?;

    let (first, first_id, first_info, first_doc, first_open) =
        open_child(app, &main, &mut transport, 0).await?;
    evidence["mainCalls"]["firstOpen"] = first_open;
    let first_ui = transport
        .call(app, &first, Some(&first_id), "list", json!({"count":0}))
        .await?;
    verify::require(
        first_ui["result"]["ready"] == true && verify::ui_paths(&first_ui["result"], &[]),
        "settings-registration-initial-ui-invalid",
    )?;
    evidence["firstChild"] = first_info;
    let acl = transport
        .call(app, &first, Some(&first_id), "acl", json!({}))
        .await?;
    evidence["acl"] = acl["result"].clone();
    verify::require(
        ["dragEnter", "dragOver", "dragDrop", "dragLeave"]
            .iter()
            .all(|key| evidence["acl"][*key] == "denied")
            && evidence["acl"]["cleanup"] == true,
        "settings-registration-drag-acl-not-denied",
    )?;
    let wrong = transport
        .call(
            app,
            &main,
            None,
            "wrongCaller",
            json!({"sessionId":first_id}),
        )
        .await?;
    let wrong_main = wrong["result"]["rejected"] == true;
    verify::require(wrong_main, "settings-registration-main-caller-not-rejected")?;
    record_focus(app, harness, evidence, "first-open").await?;

    let receipt = crate::renderer_settings_view::inject_owned_fixture_drop(
        app,
        harness.profile(),
        first.label(),
        &paths,
    )
    .map_err(|_| "settings-registration-binding-injection-failed")?;
    let binding_session = receipt.session_id.clone();
    let binding_label = receipt.child_label.clone();
    let binding_revision = receipt.bundle_revision.clone();
    let binding_nonce = receipt.binding_nonce.clone();
    let batch_nonce = receipt.batch_nonce.clone();
    let completion = receipt
        .completion()
        .await
        .map_err(|_| "settings-registration-binding-injection-failed")?;
    verify::require(
        binding_session == first_id
            && binding_label == first.label()
            && evidence["firstChild"]["bundleRevision"].as_str() == Some(binding_revision.as_str())
            && uuid::Uuid::parse_str(&binding_nonce).is_ok_and(|id| id.get_version_num() == 4)
            && uuid::Uuid::parse_str(&batch_nonce).is_ok_and(|id| id.get_version_num() == 4)
            && binding_nonce != batch_nonce
            && completion.added == 4
            && completion.failed == 0
            && completion.result_notice_enqueued,
        "settings-registration-binding-result-invalid",
    )?;
    let dropped = observe::wait_rows(harness, 4, 4).await?;
    verify::require(
        verify::exact_rows(&dropped, &paths, None),
        "settings-registration-dropped-rows-invalid",
    )?;
    let list = transport
        .call(
            app,
            &first,
            Some(&first_id),
            "list",
            json!({"count":4,"feedback":true}),
        )
        .await?;
    verify::require(
        list["result"]["ready"] == true
            && list["result"]["feedback"] == true
            && verify::ui_paths(&list["result"], &paths),
        "settings-registration-drop-ui-invalid",
    )?;
    let counters =
        observe::main_counters(&mut transport, app, &main, Some(base_events + 4), Some(4)).await?;
    evidence["drop"] = json!({"rows":dropped,"revision":4,"uiRows":4,"feedback":true,"mainRevision":counters["latestRevision"],
        "binding":{"sessionId":binding_session,"childLabel":binding_label,"bundleRevision":binding_revision,
            "bindingNonce":binding_nonce,"batchNonce":batch_nonce,"added":completion.added,"failed":completion.failed,"resultNoticeEnqueued":completion.result_notice_enqueued}});
    evidence["mainEvents"]["dropped"] = counters["deliveredEvents"].clone();
    record_focus(app, harness, evidence, "dropped").await?;

    edit_alias(app, &mut transport, &first, &first_id, &paths[0], ALIAS).await?;
    let aliased = observe::wait_rows(harness, 4, 5).await?;
    verify::require(
        verify::exact_rows(&aliased, &paths, Some(ALIAS)),
        "settings-registration-alias-not-stored",
    )?;
    let counters =
        observe::main_counters(&mut transport, app, &main, Some(base_events + 5), Some(5)).await?;
    evidence["alias"] = json!({"value":ALIAS,"rows":aliased,"revision":5});
    evidence["mainEvents"]["aliased"] = counters["deliveredEvents"].clone();
    record_focus(app, harness, evidence, "aliased").await?;

    close_child(app, &mut transport, &first, &first_id).await?;
    evidence["firstClose"] = observe::closed(app).await?;
    record_focus(app, harness, evidence, "first-closed").await?;
    let search = transport
        .call(
            app,
            &main,
            None,
            "search",
            json!({"query":ALIAS,"path":paths[0]}),
        )
        .await?;
    let result = &search["result"];
    verify::require(
        result["matched"] == true
            && result["subtypeCount"] == 1
            && result["before"]["launchCalls"] == 0
            && result["after"]["launchCalls"] == 0,
        "settings-registration-alias-search-invalid",
    )?;
    evidence["aliasSearch"] = json!({"query":ALIAS,"path":paths[0],"subType":"local-shortcut","matched":true,
        "launchCallsBefore":result["before"]["launchCalls"],"launchCallsAfter":result["after"]["launchCalls"]});
    evidence["mainCalls"]["afterAliasSearch"] = result["after"]["launchCalls"].clone();
    record_focus(app, harness, evidence, "alias-search").await?;

    let (second, second_id, second_info, second_doc, second_open) =
        open_child(app, &main, &mut transport, 1).await?;
    evidence["mainCalls"]["secondOpen"] = second_open;
    let reopened = transport
        .call(app, &second, Some(&second_id), "list", json!({"count":4}))
        .await?;
    let persisted = verify::ui_paths(&reopened["result"], &paths)
        && reopened["result"]["rows"].as_array().is_some_and(|rows| {
            rows.iter().any(|row| {
                row["path"].as_str() == paths[0].to_str()
                    && row["name"]
                        .as_str()
                        .is_some_and(|name| name.contains(ALIAS))
            })
        });
    let fresh = first_id != second_id && first_doc != second_doc;
    verify::require(
        persisted
            && fresh
            && evidence["firstChild"]["bundleRevision"] == second_info["bundleRevision"],
        "settings-registration-reopen-invalid",
    )?;
    evidence["secondChild"] = second_info;
    evidence["reopen"] = json!({"aliasPersisted":persisted,"documentChanged":first_doc != second_doc,"sessionChanged":first_id != second_id});
    let old_binding_rejected = crate::renderer_settings_view::fixture_binding_active(app)
        && matches!(crate::renderer_settings_view::inject_owned_fixture_drop(app, harness.profile(), first.label(), &paths),
            Err(error) if error == "Settings fixture drop target is stale or unauthorized");
    verify::require(
        old_binding_rejected,
        "settings-registration-old-binding-not-rejected",
    )?;
    let stale = transport
        .call(
            app,
            &second,
            Some(&second_id),
            "wrongCaller",
            json!({"sessionId":first_id}),
        )
        .await?;
    let old_rejected = stale["result"]["rejected"] == true;
    verify::require(
        old_rejected,
        "settings-registration-old-session-not-rejected",
    )?;
    record_focus(app, harness, evidence, "reopened").await?;

    edit_alias(app, &mut transport, &second, &second_id, &paths[0], "").await?;
    let cleared = observe::wait_rows(harness, 4, 6).await?;
    verify::require(
        verify::exact_rows(&cleared, &paths, None),
        "settings-registration-alias-not-cleared",
    )?;
    observe::main_counters(&mut transport, app, &main, Some(base_events + 6), Some(6)).await?;
    delete_row(
        app,
        &mut transport,
        &second,
        &second_id,
        &paths[2],
        "owned-file.txt",
    )
    .await?;
    observe::wait_rows(harness, 3, 7).await?;
    observe::main_counters(&mut transport, app, &main, Some(base_events + 7), Some(7)).await?;
    delete_row(
        app,
        &mut transport,
        &second,
        &second_id,
        &paths[3],
        "owned-folder",
    )
    .await?;
    let final_rows = observe::wait_rows(harness, 2, 8).await?;
    verify::require(
        verify::exact_rows(&final_rows, &paths[..2], None),
        "settings-registration-final-rows-invalid",
    )?;
    let counters =
        observe::main_counters(&mut transport, app, &main, Some(base_events + 8), Some(8)).await?;
    evidence["cleanup"] = json!({"rows":final_rows,"revision":8,"aliasCleared":true,"fileDeleted":true,"folderDeleted":true});
    evidence["mainEvents"]["cleaned"] = counters["deliveredEvents"].clone();
    record_focus(app, harness, evidence, "cleaned").await?;

    close_child(app, &mut transport, &second, &second_id).await?;
    evidence["finalClose"] = observe::closed(app).await?;
    let final_main =
        observe::main_counters(&mut transport, app, &main, Some(base_events + 8), Some(8)).await?;
    evidence["mainCalls"]["finalLaunch"] = final_main["launchCalls"].clone();
    record_focus(app, harness, evidence, "final-closed").await?;
    let nonce_bound = transport.nonce_bound();
    let child_role_bound = transport.child_role_bound();
    verify::require(
        nonce_bound && child_role_bound,
        "settings-registration-probe-identity-invalid",
    )?;
    evidence["identity"] = json!({"wrongMainRejected":wrong_main,"oldSessionRejected":old_rejected,
        "oldBindingRejected":old_binding_rejected,"nonceBound":nonce_bound,"childRoleBound":child_role_bound});
    evidence["status"] = json!("passed");
    Ok(())
}

async fn record_focus(
    app: &AppHandle<Wry>,
    harness: &Harness,
    evidence: &mut Value,
    stage: &str,
) -> Result<(), &'static str> {
    let observed = focus::observe(app, harness, stage).await?;
    evidence["focus"]
        .as_array_mut()
        .ok_or("settings-registration-report-invalid")?
        .push(observed.clone());
    harness.set_registration(evidence.clone());
    verify::require(
        focus::hidden(&observed),
        "settings-registration-foreground-observed",
    )
}

async fn open_child(
    app: &AppHandle<Wry>,
    main: &Webview<Wry>,
    transport: &mut Transport,
    expected_before: u64,
) -> Result<(Webview<Wry>, String, Value, String, Value), &'static str> {
    let open = transport.call(app, main, None, "open", json!({})).await?;
    verify::require(
        open["result"]["clicked"] == true
            && open["result"]["before"]["openCalls"] == expected_before
            && open["result"]["after"]["openCalls"] == expected_before + 1,
        "settings-registration-main-open-invalid",
    )?;
    let (child, id) = observe::child(app).await?;
    let navigate = transport
        .call(app, &child, Some(&id), "navigate", json!({}))
        .await?;
    verify::require(
        navigate["result"]["ready"] == true,
        "settings-registration-local-page-not-ready",
    )?;
    let inspect = transport
        .call(app, &child, Some(&id), "inspect", json!({}))
        .await?;
    let info = verify::child_info(app, &child, &id, &inspect)?;
    let document = inspect["documentId"]
        .as_str()
        .ok_or("settings-registration-document-invalid")?
        .to_owned();
    Ok((
        child,
        id,
        info,
        document,
        open["result"]["after"]["openCalls"].clone(),
    ))
}

async fn edit_alias(
    app: &AppHandle<Wry>,
    transport: &mut Transport,
    child: &Webview<Wry>,
    id: &str,
    path: &std::path::Path,
    alias: &str,
) -> Result<(), &'static str> {
    let reply = transport
        .call(
            app,
            child,
            Some(id),
            "alias",
            json!({"path":path,"name":"AToolsOwnedProbeFirst.app","value":alias}),
        )
        .await?;
    verify::require(
        reply["result"]["saved"] == true,
        "settings-registration-alias-ui-invalid",
    )
}

async fn delete_row(
    app: &AppHandle<Wry>,
    transport: &mut Transport,
    child: &Webview<Wry>,
    id: &str,
    path: &std::path::Path,
    name: &str,
) -> Result<(), &'static str> {
    let reply = transport
        .call(
            app,
            child,
            Some(id),
            "delete",
            json!({"path":path,"name":name}),
        )
        .await?;
    verify::require(
        reply["result"]["deleted"] == true,
        "settings-registration-delete-ui-invalid",
    )
}

async fn close_child(
    app: &AppHandle<Wry>,
    transport: &mut Transport,
    child: &Webview<Wry>,
    id: &str,
) -> Result<(), &'static str> {
    let reply = transport
        .call(app, child, Some(id), "close", json!({}))
        .await?;
    verify::require(
        reply["result"]["requested"] == true,
        "settings-registration-close-ui-invalid",
    )
}
