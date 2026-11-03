//! Read-only identity projection for the selected published fixture.
use super::*;

#[tauri::command]
pub(super) fn native_published_fixture(app: tauri::AppHandle) -> Value {
    let fixture = app.state::<PublishedFixture>();
    let mut result = if let Some(handoff) = &fixture.converted_handoff {
        json!({"token":fixture.token,"runId":fixture.run_id,
            "packageSha256":profile_digest(&fixture.profile),"profile":fixture.profile,
            "workerContractOnly":fixture.worker_contract_only,"nativeUiInput":fixture.native_ui_input,
            "convertedHandoff":converted_handoff_metadata(handoff)})
    } else {
        json!({"token":fixture.token,"pluginRoot":fixture.plugin_root.to_string_lossy(),"packageImportPath":fixture.package_import_path.to_string_lossy(),
            "assetProbePath":fixture.asset_probe_path.to_string_lossy(),"runId":fixture.run_id,
            "packageSha256":profile_digest(&fixture.profile),"profile":fixture.profile,"workerContractOnly":fixture.worker_contract_only,"nativeUiInput":fixture.native_ui_input})
    };
    if fixture.require_foreground {
        result["requireForeground"] = json!(true);
    }
    if fixture.deepread_text_encoding == deepread_fixture::TextEncoding::Utf8Bom {
        result["deepReadTextEncoding"] = json!("utf8-bom");
    }
    result
}
