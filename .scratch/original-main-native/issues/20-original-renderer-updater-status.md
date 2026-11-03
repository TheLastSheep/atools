# 20: 原主界面的更新状态接线

**What to build:** 原主界面启动时读取真实的本地更新状态，使用现有ATools更新能力与离线启动规则，消除当前明确未支持的状态读取错误。

**Blocked by:** None（只读调用链可先核对）；新接口及真实状态语义需独立冻结，不能伪造未下载或把错误吞成空状态。

**Status:** verified for the read-only status slice — R29单元/浏览器及R30真实Tauri Main→handler接线通过。`run-7d5822132e554e2dad673ae208eb4ea4` 实测启动1次、显式复核后2次；Native idle/unchecked、无update/error，未伪造hasDownloaded。完整更新窗口、真实下载/安装/重启不在已验范围。证据：`output/renderer-updater-status-2026-10-27/verification.md/json` 与 `output/renderer-native-input-2026-10-27/verification.md/json`。

- [x] 对照原getter的参数、状态、返回与UI消费，再核对ATools现有coordinator/install/progress；记录无法等价的状态。
- [x] 状态读取不触发网络检查、下载、安装或重启，不使核心离线启动依赖更新服务。
- [x] 真实状态读取不能等待覆盖完整网络操作的长期锁；所有快照与失败有界且可验证。Native deferred backend和取消/边界测试通过，运行时仍待19。
- [x] Main typed adapter与Native真实接线，权限与调用方明确；计入IPC及体积预算。
- [x] 保留原始错误和现有分类记录，真实实现后以新版证据解除缺口，不扩大错误豁免。

观察：`output/playwright/ztools-settings-input-browser/8b9e0f50-9cd7-439a-b844-3a0645fb47fb/report.json`。本票没有授权自动安装更新或重启应用。
