# 05: 主窗多视图承载与隔离验收

**What to build:** 主窗可承载独立设置子视图，仍可正常唤起、聚焦、调整尺寸和返回搜索；嵌入内容只获得对应设置能力，关闭后旧身份失效。

**Dependencies:** 01 主窗真实往返、04 General 写协调和完整设置包 strict 构建前置均已满足；保留固定页面与正式设置两条独立验收。

**Status:** complete for the scoped host — 主窗角色迁移、固定页和正式设置同窗资源、窄接口及 General 交互均已本地验收；完整产品还原继续进行。

- [x] 分离主 Window 与主 Webview 的职责，双视图情况下原有显示/隐藏/尺寸/焦点路径仍工作；不得继续依赖失效的独立窗口包装类型。
- [x] 通过可选 feature 显式启用平台能力，在同一原生 Window 中创建固定页面 child，真实验证父窗和两个 Webview 的身份。
- [x] 实际 caller/parent、fixture nonce/generation 与文档往返检查；主视图同命令成功，child 的 app/core/fs 调用拒绝。
- [x] 固定页面初次与重开均实测，最终 child 数与共享布局注册数为零；纯函数、VM 与实机证据分开记录。
- [x] 正式设置包/文档会话绑定及窄接口逐项授权、撤销和迟到回执防护；以真实 General 页验收，另保留固定页面回归。
- [x] 保留默认 Svelte 回退；完整主程序切换另行验收。

本批纠正原版页面启动后仅保留搜索栏的视口前置，并实测发现自动比例缩放会把 64 logical px 的顶部预留缩为 45。生产共享布局现按父窗实际尺寸和 scale 保留固定顶部，单 slot + RAII 清理，无新增每次挂载 listener。证据见 `output/renderer-multiwebview-2026-10-27/verification.md`；跨显示器 DPI、真实设置 DOM 与完整插件生命周期不在本批通过范围。

主 Agent 决策与源码证据见 `docs/contracts/ztools-settings-child-webview-boundary-2026-10-27.md`。这是原版设置入口的必要前置，不是对完整目标的缩减。

R15 证据：`output/renderer-settings-entry-2026-10-27/verification.md/json`。正式 setting 页顶部按原版常量为 58 logical px，generic probe 的64配置保持；唯一 origin/session、一次性文档、只读资源集合及五字段 CAS 接通。普通 app/Core 命令、旧 session 和未列资源实际拒绝，普通退出以 child absence 才释放 session。真实设置与通用双视图两种偏好共36阶段通过；默认 Svelte 继续保留，完整设置、物理视觉/输入与跨平台仍待验。
