# 02: Live Markdown 编辑与重开

**What to build:** 用户通过 ATools 打开未修改的 Live Markdown 0.1.0 原包，编辑固定 Markdown、切换预览/源码、保存后关闭并重开，内容仍正确。

**Dependency:** 01 的原生启动超时按用户指令暂缓，不阻止本票继续开发和独立验证；原生 UI 仍须记录真实结果，不能用跳过表示通过。

**Status:** in-progress（完整 preload 与固定文件入口的独立检查已通过；原生 UI 业务待验）

2026-10-24 补充：[Task16 原版浏览器流程](./16-live-markdown-original-browser.md) 已由主 Agent 实跑。原菜单打开固定文件，原编辑器输入/切换视图、保存、可见冲突保护、另存恢复及新 Node 会话读回通过；最终路线1项与27项既有回归均通过。它使用真实产品 Node 及生产 JS 桥，DB/选择器/权限为受控端口，不是 Tauri/Rust 原生业务验收。

原 `files` 激活路线在首次源码切换时两次卡住；已记录同一输入文件重复读取和原 preload 重放订阅回路，原包保持不变。菜单路线的成功不覆盖此失败；重开后切视图/查看设置仍出现“未保存”标记，原因未确认。详见 `output/playwright/live-markdown-original/verification.md`，本票不完成。

- [x] 原包 `preload/services.cjs` 的完整相对 CJS 图通过生产 `preparePluginPreload` 加载；真实临时文件的同步保存、异步原子保存、冲突不覆盖、恢复后重开，以及文件入口订阅/取消已独立复验。
- [x] 固定 Node 22.23.3 下，新旧相关用例合计 7 项通过，前端检查 0 errors / 0 warnings；实际加载的原包源码 SHA256 前后相同。证据见 `output/harris-plugin-first-2026-10-23/p0-node-startup/harris-preload-final.log`。
- 上述为借用 Node host 的模块合同：临时文件真实读写，可选网络/子进程操作被拒绝；未执行真实 sidecar transport、WebView 编辑、预览/源码切换或完整权限/TaskRun UI，不解除原生验收依赖。

- [x] 接通原 manifest 的 files 命令到生产 `activate_file_content_feature`：生成固定 `input.md` 的单包计划，校验描述并经原有 owner/media gate/TaskRun 激活入口，真实文件 payload 不夹带计划元数据。Svelte `$state` 代理的外部样本分类回归通过。此为入口接线和接口证据，不表示下列原生业务已执行。
- [x] 本切片63项前端、39项Rust用例和新旧JS计划脚本通过，前端检查/工作区编译与560KiB初始JS预算通过；旧队列脚本仍失败于App内联结构断言，未改写为通过。证据见 `output/harris-plugin-first-2026-10-23/live-markdown-file-entry/README.md`。

- [ ] 使用固定文档和原包，在完整 Tauri WebView 流程中打开并编辑 Markdown。
- [ ] 验证预览/源码切换、保存、关闭重开和持久化后的正文一致。
- [ ] 验证一次可恢复失败后用户能继续编辑或明确退出；记录实际权限、TaskRun 和运行时分派证据。
- [ ] 区分局部文件 API / 契约测试与完整原包 UI 验收；后者通过才完成本票。
