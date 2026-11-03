# 04: General 设置各写入口的并发一致性

**What to build:** 主窗、旧设置面板、剪贴板独立设置窗口及采集开关同时使用 General 数据时，任何旧快照都不能覆盖另一入口刚保存的字段；失败和结果未知要能重读协调。

**Blocked by:** None (can start immediately). Must finish before ticket 03 connects the new writable settings UI.

**Status:** complete-local-verification — 指定入口的代码与隔离回归完成；真实 OS 副作用与完整原版设置 UI 的验收不包含在此结论中。

## 冻结的入口与边界

| 入口 | 统一后的路径 |
| --- | --- |
| 旧 `set_setting` | General key 明确拒绝；其他键保持原保存路径 |
| Svelte 设置编辑器 | 本次编辑会话绑定的 writer → `save_general_settings`，一次请求包含 Native 效果与 CAS 提交 |
| 普通 `saveAToolsSettings` | 共享 helper 的有界快照与 patch；不再直接写整键 |
| `PasteboardDialog` | 打开时 raw + 五个剪贴板字段 patch；不重放系统设置 |
| capture pause | 同一 coordinator 下对最新值原子 patch 单字段 |
| 原版 renderer General mutation | 原有严格五字段契约，同一 coordinator |
| 原版/旧设置的 General 读取 | 窗口身份校验后等待同一 coordinator |

六个旧系统设置 setter IPC 已撤下；内部启动和测试 fixture 的 Rust helper 不作为交互写入口。AI/Published 原生 fixture 的运行期设置写入已迁到新命令，启动前临时 DB 种子保留。数据库导入/恢复及完整应用退出时的跨系统原子性不在此票验收范围。

- [x] 冻结全部生产写入口清单：`settings_write::set_setting_ai/set`、`settingsStorage/writeStoredSettings`、`PasteboardDialog`、`pasteboard_set_capture_paused`，以及新 General CAS；不以新增CAS单测证明旧写入口已受保护。
- [x] 统一原子字段patch或显式expected快照契约；保留原有AI配置变更取消语义、未知字段与凭据；不通过禁掉旧界面保存规避迁移。
- [x] 真实两个SQLite连接重现“旧dialog快照→主窗新值→旧dialog保存”，断言新字段不丢；覆盖采集开关与原版设置并行。
- [x] 旧设置编辑/补偿/预览调用方同步适配；冲突或提交结果未知时不误报成功、不自动覆盖重试。
- [x] 命令调用者身份、请求/响应字节及待处理队列有界，页面退出清理；相关Svelte/TS与Rust回归检查通过。

来源：`output/renderer-settings-2026-10-27/general-settings-independent-review.md` 的 P1。前批新增CAS仅保证专用调用；本票完成上述生产入口迁移，不将其扩展为数据库导入/恢复或跨系统原子性的保证。原版设置客户端仍待接生产 UI。

最终证据：`output/renderer-settings-coordination-2026-10-27/verification.md/json`。Core 310 passed（3 ignored）、Native General 23 passed、前端相关回归 24 files / 194 passed；Node 保存脚本、Svelte/strict TS、默认构建、预算、workspace 和 fixture feature 编译均通过。独立复核发现的销毁 fresh-read 覆盖和 preview quota 伪成功均已修正；Native/preview 的真实组件卸载冲突回归已通过。浏览器 strict mock Tauri 检查通过并回收全部自有资源，不能替代实机 OS 验收。
