# ATools 启动器交互与原版插件阶段交付

本阶段完成了 Home 命令网格交互回归，以及 FileTree、Developer Codec Tools 两个固定 ZTools HEAD 插件的原版业务流程验收。证据对应当前 source freeze v25；选定源码快照不是完整编译／依赖闭包。

## 验收结果

| 范围 | 结果 | 验收边界 |
|---|---|---|
| Home 命令网格 | 6 个组件测试文件、55 项交互测试通过 | 覆盖卡片键盘选择、移除后焦点同步等组件/App交互；不代表物理键盘或与竞品的同机视觉验收。 |
| Native CLI 与 codec profile | 9 项通过、0 项失败 | profile 范围检查，不是完整测试套件。 |
| Codec 类型及 host profile | 严格 TypeScript 检查退出码 0；host profile 1 项通过、870 项过滤 | 只覆盖选定 profile。 |
| FileTree 原版插件 | native v8：21 项命名检查通过，418 个 TaskRun 均终态 | 固定 HEAD 包经生产 App 激活路径运行；原始扫描、筛选、清除筛选、隐藏文件开关分别检查编辑器模型与真实 DOM。Back/搜索焦点、运行时清理通过；原插件未改，临时夹具已清理。未调用目录选择器或保存对话框。 |
| Developer Codec Tools 原版插件 | native v2：4 项业务操作通过，1 个成功激活 TaskRun | Unicode Base64 编码/解码、非法输入错误及恢复通过；搜索键盘激活、隔离 PluginPanel、Back/搜索焦点及运行时清理通过。固定原版 15 个文件、展开 59,561 字节，内容未改。未调用剪贴板、系统对话框、Node 文件访问或网络操作。 |
| 通用检查及包体 | Svelte 0 errors / 0 warnings；workspace check 退出码 0；初始 JS bundle 为 371,130 / 573,440 字节，较前次增加 42 字节 | 初始 JS 包体预算通过；这些检查不证明全进程或 OS 进程树 CPU/RSS 性能。 |

Codec v2 的独立 root review 将结果绑定到 freeze v25 与所记录的原生二进制哈希。FileTree、Codec 都是固定夹具下的自动化业务流程；不据此推断整插件完整兼容、物理人工输入表现或整个 ZTools 插件生态的兼容率。

## 保留的失败记录

此前 Codec native v1 在 `encode` 阶段超时，错误码为 `DEVELOPER_CODEC_OPERATION_TIMEOUT`；报告同时记录 TaskRun 终态、清理通过和原包未变。后来 native v2 流程通过，但现有证据没有确认 v1 超时的具体根因。

v23 严格 TypeScript 检查有三条诊断，涉及两个问题：`contentWindow` 在两处访问均被收窄为 `never`（TS2339）；`bootstrap` 值不属于声明的阶段联合类型（TS2345）。这是有日志证据的编译错误，后续严格类型检查退出码 0。不要把已确认的两类类型问题与未确认的 Codec v1 原生超时根因混为一谈。

## 证据与来源

当前 freeze 位于 `/private/tmp/atools-batch107-root/source-freeze-v25.json`，303,563 字节，SHA-256 `9fb94f09a364c6080331a6fdfe136e328d40fa50483fe42688872cb9df8cc7ea`，包含 1,806 个选定源码 pin，非编译闭包。当前验收报告、root review、日志和相关 Home/FileTree/Codec 源码快照列于随附 payload plan，并在打包时逐项校验字节数与 SHA-256。

B191 已交付证据通过 `output/plugin-input-2026-10-20/batch191-root-evidence-v1/manifest-v1.json` 引用，manifest SHA-256 为 `7372a73f190d9eb421ba5db487dac2ef1cd1735c94997eeeda2fca7b6e0a2543`。B191 历史 payload 不重复复制。本阶段交付文档目标为 `docs/superpowers/plans/2026-10-20-home-codec-delivery.md`；证据归档目标为 `output/plugin-input-2026-10-20/batch204-root-evidence-v1`。
