# B44 已安装插件键盘交互与 LaunchServices 验证进展

日期：2026-10-19。本文分开记录已完成的 UI 交付与失败的原生 LaunchServices 试验；UI 结果不代表原生输入已通过。

## 已安装插件列表键盘交互

`PluginInventoryPanel` 保持 `role=list` 与原有详情按钮。详情按钮持焦点时，ArrowUp/ArrowDown 在当前最多 30 个渲染条目间移动，Home/End 定位当前页首尾并钳制、不循环；Enter 仍使用按钮原生行为。详情页 Escape 返回原插件行。搜索、行操作、组合键和输入法事件不进入列表导航。过滤、分页、刷新或删除使当前行失效时，仅在列表仍拥有焦点时将焦点恢复到有效搜索框；外部焦点不被夺回。布局变化时通过局部 ResizeObserver 与 nearest 滚动保持焦点行可见，组件销毁时断开观察器。未增加全局监听、轮询、持久状态、目录请求或键盘导航副作用。

最终 UI 源冻结见 `/private/tmp/atools-batch44-root/ui-source-freeze-v3.json`。root 独立验收复核四个 UI 文件未变：全前端 184 文件、1,746 项通过；Svelte 0 error/0 warning；TypeScript exit 0；release build 通过。Initial JS 365,513 / 573,440 bytes，相对 B43 增量 0。组件定向测试 31/31。headless browser v4 为 6 checks、8 screenshots，真实 CDP Enter/Escape 与焦点身份通过；800↔420 viewport resize 后实际矩形断言确认焦点行完整可见。浏览器验收没有使用 OS 输入，不代表 macOS 原生键盘行为。

四次 browser 过程都保留：v1 失败于 CDP helper 没有给 Enter keyDown 回车文本；最小诊断证明需要发送 `\r` 才产生 trusted keypress/native button click。v2 的 Enter/Escape 已通过，失败是全 IPC 计数误把三次既有只读 `feature_catalog` 启动重试算作键盘请求，验收现已限定副作用并报告重试。v3 的脚本检查通过，但截图显示 420px 布局下聚焦行 outline 被裁切，故不视为可见性通过；v4 加入 viewport rect 检查并通过。UI 独立审查 v2/v3/v4 是较早候选的历史审查与更正；review-v4 对应 resize 修复前候选，不能绑定最终 resize 源。最终 resize 源由 root 的 `ui-root-acceptance-v1.json`、`ui-source-freeze-v3.json` 与 browser v4 run `849ef1de-c863-4e6a-9ad7-a0e2bf22a4e5` 的实际 viewport 检查共同复核；历史审查不替代该最终证据。

## Native LaunchServices plain-text v1

Native v1 真实运行失败，不能计为插件兼容或原生输入通过。run `22bdf067-7d67-49f1-b432-811c0cde479a` 记录 23/23 内部 scenario checks，但 7 个 TaskRun 中 6 成功、1 失败且全部终态；runtime drain、临时数据删除与外层清理完成。失败在 `real-node-authorization`：精确 Node capability 权限弹窗到达，批准前 `legacySessions=0`、`pendingRequests=1`；测试流程完成“允许一次”的授权分支后，Plugin iframe 未加载，错误为 `plugin sidecar request timed out after 1500 ms`。没有进入插件 iframe/editor，也没有文本输入或格式化/诊断恢复验收。OS input actions=0、TIS writes=0，ABC input source 前后相同；fixture package、source 与 artifacts 未改。

原 observer 的 `normalExitIdentityVerified=false`，因此该 run 保持 failed。事后独立扫描仅检查本次三个 owned PID，`kill(pid,0)` 均得到 ESRCH；它补充证明这些进程随后不存在，不回溯改变原报告状态。后续修正增加“查询无行 + ESRCH 才判定不存在”的分类。独立 process-identity probe 实测 owned child 21637：运行时 identity 命中、wait 后确认 absent、exit 0、reaped、未 timeout/kill。root Rust 示例测试为 17/17、无 skip；workspace check v3 通过。它们验证进程身份与源码层，不会令 native v1 变成成功。

只读代码调查见随附归档的 `atools-batch44-node-startup-investigation-v1.md/json`。统一 timeout 文案能证明发生 `SidecarError::Timeout`，但不能区分 spawn 的 `wait_until_running` 与 `initialize` JSON-RPC 响应等待；后者较可能但未证实。此前 direct-spawn plain-text run 曾出现 `legacySessions=1`/transport=true，但不是相同条件下只切启动方式的控制实验。LaunchServices target 的请求环境 key 完整、值没有记录，ambient inheritance 仍 unknown。目标应用 stdout FIFO 和 sidecar 子进程 JSON-RPC stdout pipe 相互独立；当前证据不支持把 FIFO 当作 timeout 根因。

下一批先增加 owned Node sidecar 的 monotonic phase 诊断，并在相同 fixture/runtime 下只比较 direct-spawn 与 LaunchServices。记录 runtime version/SHA、spawn/owned PID、Running、initialize request ID 写入、匹配 stdout response、child exit/owned PID existence 与受限 stderr 计数/摘要；不记录环境值、原始 stderr 或无关进程表。1500 ms startup budget 不变，不预设 LaunchServices 是根因；本批不再运行第二次 LS。

## 冻结与证据边界

最终 source freeze v3：`/private/tmp/atools-batch44-root/source-freeze-v3.json`，SHA-256 `14eb6086de66ca97c4e4cc9b197cb85e4432daf22a82d4ba42f8e1125b201925`；1,552 selected sources、23 owned files（10 modified、13 new）、baseline drift 0。归档同时保留 before、after-v1、after-v2 与 after-v3：v1/v2 是历史候选，native v1 的失败不因 v3 的代码修正或静态审查而改写。native independent review v3 检查 18 个 native source hashes，修复后 process/lifecycle 静态审查无 blocker；它不替代 GUI、前台、编辑器或 OS 输入验收。

UI 已完成的键盘可见性修复和 native LaunchServices 失败是不同证据层。当前不作“多数 ZTools 插件兼容”或原生编辑器输入已通过的声明。有限证据归档位于 `output/plugin-input-2026-10-19/batch44-evidence-v1/`。copy list v1 保留为历史；当前复制核对记录为 `/private/tmp/atools-batch44-archive-copy-list-v2.json`。最终交付索引以同级 `batch44-evidence-manifest-v1.json` 与 `batch44-delivery-v1.json` 为准；copy list 仅用于核对明确复制的文件。

## Goal 状态

Goal 仍 active；formal acceptance=false；新增 whole-original-plugin workflow acceptance=0。未执行 Git mutation、commit 或 push。
