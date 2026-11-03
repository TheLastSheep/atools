# 03: 同窗原版设置入口与真实保存

**What to build:** Cmd+,和设置按钮进入主窗内原版设置插件视图，默认General页可读写设置并退出回搜索，保持上游的同窗语义。

**Dependencies:** 01 主窗往返、04 General 写协调及原版设置包 strict 构建前置均已完成本切片要求；其余设置 API 仍在整体目标内继续。

**Status:** complete for the General slice — 原版同窗入口、真实读取/保存/通知/重开/退出均已本地验收；完整设置能力继续在主目标中推进。

- [x] 只读固定上游构建设置包，接通原版插件生命周期和受限文档身份、权限、资源边界。
- [x] 两个原版入口进入同窗插件视图，不以独立settings窗口或空白placeholder代替。
- [x] General页实际DOM挂载，真实读取并保存一项设置，重开后可读回且主界面收到变化。
- [x] 退出恢复搜索，重复进入后实际视图和布局记录归零；未接API明确报 unsupported。
- [x] 明确全设置标签和插件兼容仍按完整目标继续验收，本切片不等同整体完成。

准备进度见 `output/renderer-settings-2026-10-27/verification.md`：隔离依赖已恢复；完整原版setting产生review-only候选，原12处类型错误仍使正式构建失败。Core事务CAS、main-only native命令和有界客户端已实现并定向/回归检查。`openSettings`、frame资源与身份绑定、原版生命周期及真实General保存回传仍须接入；上述验收项保持未勾选。

2026-10-27 后续：`output/renderer-settings-view-2026-10-27/verification.md/json` 已将 12 项类型错误清零，完整正式设置包通过两套原严格检查和 Vite 构建。五个只作用于自有暂存副本的可追溯补丁保留上游只读、模板/style 块不变；四个类型修正擦除输出等价，验证码异步竞态有真实组件回归。资源预算 749,163 字节（比原候选 +57），超限构建实际拒绝且保留正式 dist。主窗 ChildWebview 的类型/权限依赖见 ticket05 和 `docs/contracts/ztools-settings-child-webview-boundary-2026-10-27.md`；当前只实现拒绝 child 命令的前置，尚无设置 child，因此不勾选运行时验收。

R15 最终证据：`output/renderer-settings-entry-2026-10-27/verification.md/json`。真实 Native 设置运行 `178ddde8-3ca2-44df-afc3-6edf24b4608a` 在两种偏好下通过头像/Cmd+,、General DOM 提示文字保存、SQLite/未知字段保留、主界面通知、返回按钮/Escape、重开新文档与读回；session/child/layout/pending 均零。仅五项 General 字段可写，完整设置和默认入口切换保持开放。
