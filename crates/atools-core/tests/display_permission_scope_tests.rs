use atools_core::agent::{PermissionDecision, PermissionMode, PermissionPolicy, PermissionRequest, PermissionScope};

#[test]
fn display_metadata_can_be_denied_without_granting_or_denying_pixel_or_clipboard_access() {
    assert_eq!(serde_json::to_string(&PermissionScope::DisplayRead).unwrap(), "\"display_read\"");
    assert_eq!(serde_json::from_str::<PermissionScope>("\"display_read\"").unwrap(), PermissionScope::DisplayRead);
    let mut policy = PermissionPolicy::new(PermissionMode::Developer);
    policy.denied_scopes.insert(PermissionScope::DisplayRead);
    let mut request = PermissionRequest { client_id: "fixture".into(), tool_name: "display-fixture".into(), scopes: vec![PermissionScope::DisplayRead], mutates: false };
    assert_eq!(policy.evaluate(&request), PermissionDecision::Deny);
    for scope in [PermissionScope::Screenshot, PermissionScope::ClipboardRead, PermissionScope::SystemSettings] {
        request.scopes = vec![scope];
        assert_eq!(policy.evaluate(&request), PermissionDecision::Allow);
    }
    let mut separate = PermissionPolicy::new(PermissionMode::PerTool);
    separate.grant_tool("fixture", "screenshot-fixture");
    request.scopes = vec![PermissionScope::DisplayRead];
    assert_eq!(separate.evaluate(&request), PermissionDecision::Confirm);
}
