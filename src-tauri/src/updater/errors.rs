//! No remote/provider detail crosses into retained state or popup messages.
use super::UpdateCommandError;
pub(super) const MAX_ENCODED_ERROR: usize = 2 * 1024;
pub(super) const CODES: &[&str] = &[
    "busy",
    "stale_candidate",
    "version_mismatch",
    "no_update",
    "not_downloaded",
    "install_unknown",
    "restart_pending",
    "forbidden_window",
    "network",
    "invalid_manifest",
    "missing_architecture",
    "invalid_signature",
    "download_failed",
    "archive_integrity",
    "archive_too_large",
    "provider_disabled",
    "provider_unavailable",
    "state_unavailable",
    "operation_interrupted",
    "state_response_too_large",
    "internal",
];
pub(super) fn fixed(code: &str) -> UpdateCommandError {
    let code = if CODES.contains(&code) {
        code
    } else {
        "internal"
    };
    let message = match code {
        "busy" => "更新操作正在进行",
        "stale_candidate" | "version_mismatch" => "更新候选已变化，请重新确认",
        "no_update" => "没有可安装的更新",
        "not_downloaded" => "更新包尚未下载完成",
        "install_unknown" => "安装结果未知，当前版本可能已改变；请确认后重试",
        "restart_pending" => "更新已安装，请确认后仅重启应用",
        "forbidden_window" => "当前窗口无权管理应用更新",
        "network" => "无法连接更新服务，请稍后重试",
        "invalid_manifest" => "更新信息无效，请稍后重试",
        "missing_architecture" => "当前架构没有可用更新",
        "invalid_signature" => "更新签名无效，已停止安装",
        "download_failed" => "更新下载失败，请稍后重试",
        "archive_integrity" => "更新包校验失败，请重新下载",
        "archive_too_large" => "更新包超出保留大小限制",
        "provider_unavailable" => "更新服务当前不可用",
        "provider_disabled" => "隔离实例未启用更新网络提供方",
        "state_unavailable" => "更新状态当前不可读取",
        "operation_interrupted" => "更新检查已中断，请重新检查",
        "state_response_too_large" => "更新状态超出响应大小限制",
        _ => "更新操作失败",
    };
    UpdateCommandError::new(code, message)
}
pub(super) fn normalize(error: UpdateCommandError) -> UpdateCommandError {
    let fixed = fixed(&error.code);
    if serde_json::to_vec(&fixed).is_ok_and(|b| b.len() <= MAX_ENCODED_ERROR) {
        fixed
    } else {
        fixed_internal()
    }
}
fn fixed_internal() -> UpdateCommandError {
    UpdateCommandError::new("internal", "更新操作失败")
}
