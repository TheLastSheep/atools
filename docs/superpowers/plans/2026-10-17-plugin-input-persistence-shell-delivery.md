# 原版输入、持久化与 Shell 适配交付记录

日期：2026-10-17。目标继续有效：补齐 ATools 与 ZTools/uTools 的界面交互差距，让大部分原版插件可直接使用，同时遵守性能预算。本批交付不代表该目标完成。

## 已完成的产品改动

- 插件清单详情中的普通 Escape 先返回清单，保留筛选条件与页码，并恢复对应插件行的焦点。测试经过真实 App 键盘处理，覆盖输入法组合态、keyCode 229、组合态标记、带修饰键与嵌套对话框。未证明精确 scrollTop 恢复。
- Electron shell 新增 showItemInFolder 与 trashItem 适配，走既有宿主权限与调用链。宿主在操作系统边界再次验证绝对路径，拒绝相对路径、NUL 与超长参数，保留合法 Unicode 与尾部空白。拒绝后不会自动重放；需要新的显式调用。showItemInFolder 保持 void，trashItem 保持 Promise<void> 并保留原始错误。
- 独立模块承担适配、路径验证、原版案例注册和验收。既有大型 PluginPanel.svelte 仅替换一处导入、两处现有参数验证调用，共三行；没有向其中追加独立职责。

Shell 通过序列化适配器、真实生产桥与抽取的生产宿主处理函数验证，操作系统执行器为惰性替身。本批没有执行真实文件定位或回收站操作，不能声称这些原版业务已经验收。未执行 AppleScript。

## 两个原版插件的实际执行

两个插件均从完整原目录导入，经实际 Rust 导入器、启停、功能目录和搜索进入隔离 Tauri/WebView。源码未改写；每个目录均有 12 个文件并锁定完整树指纹，缺失或改动会硬失败。

| 原版 | 已验证行为 | 最终记录 |
| --- | --- | --- |
| UUID 百宝箱 1.0.0 | 宿主真实子输入回调进入原版；固定 UUIDv5 DNS 值与六种编码、无效输入报错和恢复；Web preload，不启动 Node | [native v2](../../../output/legacy-node-2026-10-17/original-uuid-kit-native-v2.json)，31 项检查，4 条终态 TaskRun |
| ASCII Tree 1.0.0 | 原版双向文本转换；通过真实 SQLite 写入；完整关闭、重新授权后以新 iframe 恢复原文 | [native v2](../../../output/legacy-node-2026-10-17/original-ascii-tree-native-v2.json)，52 项检查，26 条终态 TaskRun |

ASCII Tree 的原 preload 声明了保存功能，因此启动 preflight 会申请保存权限。案例显式登记 dialogAccess=save，首次打开及重开均依次给予全新的 data、save、Node 一次授权；保存权限只建立空闲会话。整个案例 nativeDialogs、dialogInvocations、dialogIntents、dialogPreparations 均为零，没有打开系统面板或导出文件。9 次数据操作仅涉及 getItem/setItem；TaskRun 隐私检查没有暴露原文、键或 bearer URL。真实数据库快照以限定插件/键的只读投影返回。

两个案例均记录 documentHidden=true / visibilityState=hidden。输入通过程序化 DOM 事件驱动，证明原版事件处理与持久化，不能作为可见界面、物理键鼠、编辑器真实打字或绘制延迟验收。运行前后源码、插件原目录与构建产物一致；所有 TaskRun 终态，运行资源释放，临时环境清理完成。

## 最终验证与性能

- 前端 110 个测试文件、1019 项通过；Svelte/TypeScript 零错误、零警告。
- 桌面宿主默认测试 442 项通过、1 项既有忽略；显式 legacy-node-smoke 原版验收测试 22 项通过；工作区编译通过。
- 严格注册表 7 项、目录夹具 12 项、原版参数 2 项与运行收尾 8 项通过；既有发布配置与生产 Shell 边界脚本通过。
- 默认生产首屏 JavaScript 静态依赖图 319833 字节（312.3 KiB），低于 573440 字节（560 KiB）；插件面板与拼音分块仍延迟加载。构建临时目录已删除。
- 1200 多条功能的串行匹配测量保留全部 20 个样本，最慢 0.813291 ms，预算 25 ms。排除索引构建、冷进程、IPC 和 DOM。
- 同机 5 个独立临时桌面进程，以 1200 条合成功能 metadata 加原版 typed matches 为数据集，100 个热搜索样本 P95 31 ms，返回按钮程序化焦点恢复 P95 28 ms，iframe Escape probe 后程序化焦点恢复 P95 26 ms。自有进程组 RSS 最大 140247040 字节。窗口为 observe；样本仅为描述统计，未应用前台体验发布门槛。RSS 不含无法归属的 WebKit/XPC 进程，也不是整应用物理内存。

[最终代码验证](../../../output/plugin-input-2026-10-17/plugin-inputs-code-validation-v1-final.json)、[包预算](../../../output/plugin-input-2026-10-17/plugin-inputs-bundle-budget-v1-final.json)、[匹配预算](../../../output/plugin-input-2026-10-17/plugin-inputs-matcher-budget-v1-final.json)、[桌面性能原始记录](../../../output/plugin-input-2026-10-17/plugin-inputs-native-performance-v1-final.json)。总回执包含代码指纹、运行绑定、日志和修改前完整字节备份。

## 独立复核与保留记录

清单 Escape 的输入法遗漏及 Shell 直达宿主的路径验证遗漏曾被独立复核发现，修正后复核无剩余 P1/P2。保存权限与 ASCII 数据恢复的独立窄审查也未发现 P1/P2，保留隐藏窗口验收边界。隐私测试已覆盖 JSON 转义换行标记；/dialog/ bearer 条件有实现，但尚无专门字面量断言。

ASCII native v1 在保存权限 preflight 处失败，不能算通过；显式补充案例元数据与权限顺序后，v2 才通过。保留该失败、早期 Rust 测试编译/隐私断言失败及修正前审查快照，最终回执明确区分。UUID v1 为较早来源绑定，当前以 v2 为准。

## 后续验收缺口

- 仍需可见前台窗口、真实键鼠输入与 ZTools/uTools 同机对比，尤其 JSON 编辑器焦点、输入、格式化和诊断恢复。
- 多数原版插件的直接可用率尚未建立。不能把清单/资源就绪率或少数业务案例作为多数插件验收。
- 优先补齐同插件 hosted IPC 的 sendTo/getWebContentsId，以及 nativeImage/剪贴板图像；继续扩展真实原版业务案例。
- 文件定位/回收站真实操作、完整应用 WebKit/XPC 资源归属、常规启动与空闲、跨平台及发布包验收仍待完成。
- 四类原版注册表目前无重复 caseId；跨四表的全局重复拒绝尚未补齐，两个目录注册表合并已严格拒绝重复。

保留既有脏文件与无关改动；本批没有暂存、提交或推送。
