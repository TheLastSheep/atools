# R26 原版命令别名与设置目录

上一轮 R25 为 progress；全目标 active。仓库/工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。原上游只读 pinned `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。Root 派单、接口、审查和独立验收，Luna 实施且不派生代理。无 Git staging/commit/push、用户 app 操作、foreground/CUA/AppleScript。

## 用户路径与范围

保持原 Vue/CSS/模板：AllCommandsSetting 的 direct/app 菜单 → 自定义别名 → Shortcuts alias tab 的原对话框；新增/编辑/删除、保存成功才更新 UI，主搜索立即应用，重开读回。内部 setting 属于主程序。

支持别名元数据不等于启用或验收插件运行。getCommands 返回当前 ATools 可获得的 canonical commands/regexCommands/plugins，不裁成 app-only、不展开 aliases、不合成未实现的 ZTools system-setting。未知/缺目标的 alias 行继续按原 UI 显示；未修改的 legacy/plugin/opaque 数据不得丢失。Svelte localStorage 的另一别名模型不迁移或覆盖。

## 资源分配

明确切换到本里程碑基线，旧 manifests/provenance 冻结在 `output/renderer-aliases-2026-10-27/`，不宣称预算或资源用量从未变化。

| 资源 | R25 实际基线 | 本里程碑最大增量 | 既有绝对上限 |
| --- | --- | --- | --- |
| 主界面 emitted JS | 586447 | 3377 | 589824 |
| 设置全部 emitted resources | 765325 | 8192 | 786432 |

绝对上限不变；逐阶段有效增量门槛按此重新分配。不得为通过构建再抬高门槛或删原界面/字典。Root 最终比较真实 emitted bytes、依赖与原来源，不将字节预算当 RSS/时延基准。仅设置打开时分配有界数据缓冲，不新增轮询、Node 启动或常驻进程。

## Core 单一别名模型

新增纯 Core 模块，存储键固定 `ztools-renderer:command-aliases`，不复用通用 set_setting 或 13 字段 General CAS，不依赖 Tauri。接口名称固定：

```text
RendererCommandAliasesSnapshot { raw: Option<String>, value: serde_json::Value }
RendererCommandAliasesWrite { raw: Option<String>, value: serde_json::Value, changed: bool }
Database::read_renderer_command_aliases() -> Result<RendererCommandAliasesSnapshot>
Database::mutate_renderer_command_aliases(expected: Option<&str>, desired: &Value)
  -> Result<RendererCommandAliasesWrite>
normalize_renderer_command_aliases(raw: Option<&str>) -> Result<Value>
Database::mutate_renderer_command_aliases_guarded(expected, desired, guard: impl FnOnce() -> bool)
  -> Result<RendererCommandAliasesWrite>
```

`raw` 是精确 CAS 比较值，仅 Native 内部保存；`value` 是原 UI 的归一化投影，缺存储时为 null。使用 Immediate 事务读当前 raw、精确比较、合并、提交；并发连接/外部 set_setting 改动均应冲突。无变化保留原 raw/缺失状态，changed=false；失败或超限完全不写。

关闭保护采用纯 Core guarded 入口：取得 `BEGIN IMMEDIATE` 后、数据改动前检查会话存活；原 mutate 方法委托恒真 guard，保留原接口。排队期间关闭则拒绝且不写。已通过该检查的事务由 owned task 完成并记账；UI close 不持同步锁等待 SQLite busy/事务。Core 不引入 Tauri 依赖。该接口由 Root 在 Native 审查发现关闭锁等待问题后明确扩入原 Core owner 归属；此前 324 项结果为 guarded 入口加入前证据，最终需重新验证。

归一化匹配 pinned commandShared.ts：string[] 和对象 alias/icon；alias 按 JS trim、过滤空、区分大小写去重；后值覆盖 icon，次序仍为首次出现位置。icon 非空原样保留，不额外 trim，空 icon 从投影省略。应用 ID 为 `direct:app:<slash-normalized path>`（不含显示名称），插件 ID 为 `<pluginName>:<featureCode>:<name>:<cmdType>`；Core 视 ID 为有界不透明键，不执行目标。

对 submitted normalized map 与当前投影做语义 diff，仅改差异 bucket。未改 bucket 的 string[]、未知字段/记录/opaque bucket 原样保留；编辑 bucket 时保留未被 UI 表达的 opaque 记录，以及同 alias 保留记录的未知字段。UI 明确删掉的可识别 alias/bucket 才删除。不得因整份前端 normalization 静默重写/移除其他 plugin 数据。非法根结构拒绝，不覆盖成空。

硬界限：stored raw ≤128 KiB（现有 namespace 限制）；normalized projection/提交 document ≤512 KiB（允许 legacy string[] 展开）；最多4096 bucket/4096可识别 alias；commandId≤16448 UTF-8 bytes、alias≤512 bytes、icon≤65536 bytes。先检查原始字节，再解析/归一化；写完再检查 stored bytes。测试须覆盖 Unicode trim、dup/icon/order、opaque 保留、删除、空值/no-op、两连接 CAS 冲突与失败后文件 DB 重开。

## 有界 canonical 目录

Native 新模块 `renderer_commands_catalog` 提供：

```text
capture(app: &AppHandle, state: &AppState) -> Result<Vec<u8>, String>
```

返回完整 UTF-8 JSON `{commands,regexCommands,plugins}`，apps 用既有 catalog/name/path/opaque icon；plugins 使用当前主 renderer 的 canonical pluginName/featureCode 和现有 installed/static/dynamic metadata，本地启动项沿用现有 namespace。保持各来源原遍历次序，不展开 aliases，不启动插件或 Node，不逐页重扫。未知/未支持的系统条目不能伪造。

一个 capture 形成不可变快照，分页期间仅切此 bytes。保留 snapshot ≤8 MiB、最多16384 command/regex rows 和2048 plugin records；超限拒绝整次 getCommands，不返回部分列表。来源必须有界读取，不能先无限拉取 DB 后再检查长度；必要时加独立 Core bounded catalog reader（插件/feature 元数据总字节≤8 MiB，单记录≤512 KiB）。仅读现有数据，不改插件装载/执行语义。

app-icon 授权从 main 扩展到当前活动的原 setting child：精确 Native label/current session/settings URL/origin/bundle revision，其他 child/plugin 仍拒绝。保留只读 GET/opaque ID/current catalog membership 与原 worker/队列/缓存界限；没有任意 path 或代理通道。CORS/Referer 策略按实际 child 原点验证，不以声称 null origin 就放行。

## Child scoped 数据传输接口

仍经 call_renderer_settings/session。新操作各 payload ≤32 KiB、实际 JSON reply ≤64 KiB，旧 General 接口原界限不变。读页 raw chunk ≤32 KiB，写页 raw chunk ≤16 KiB，base64 标准编码。所有 token 为服务端随机UUID，绑 active session/bundle/kind；每类最多一份 snapshot、每 session 一份 staged write。别名 projection ≤512 KiB、commands ≤8 MiB、staged write ≤512 KiB；close 清理，未开始的写不得提交。

```text
readCommands {}                  -> DataPage(kind=commands)
readAliases {}                   -> DataPage(kind=aliases)
readCommandDataPage {kind,token,offset} -> DataPage
writeAliases {baseToken,value}    -> CommitReply       // small, one RPC
beginAliasWrite {baseToken,totalBytes} -> {writeToken,offset:0}
appendAliasWrite {writeToken,offset,data} -> {writeToken,offset}
commitAliasWrite {writeToken}     -> CommitReply
abortAliasWrite {writeToken}      -> {aborted:boolean}

DataPage = {version:1,kind,token,offset,nextOffset,totalBytes,data}
CommitReply = {version:1,success:true,baseToken,notificationDelivered:boolean}
```

读首包包含第一页，完整返回后 child 才 JSON.parse/resolve 给原 API。任何页错/越界/不前进/不匹配都拒绝整次，不给部分数组。aliases token 同时保留 Native raw CAS 基线；commands 只读。成功提交返回新 baseToken，前一个写 token 不再能提交。client 保存开始时固定 base token 和 candidate；一个 write in flight，其间其他写明确拒绝，不用新 revision 默默覆盖旧 candidate。

Native detached commit 复用现有 write_gate/accounting：启动前校验 current session，事务已经开始则必须等其完成并记录结果，child dispose 不等于回滚。成功且 changed 才 emit_to main Webview `atools://renderer-command-aliases`，payload严格null；child不发事实。通知失败不得将已提交伪装成未写入，回执明确 notificationDelivered，重开按数据库事实恢复。

Child 专用模块挂入 internal.getCommands / internal.dbGet('command-aliases') / internal.updateCommandAliases；General 原路径保留。业务接口保持原 Promise/成功语义。baseToken未读/失效、CAS冲突、写已提交但回执丢失需明确错误/未知，不能假定取消或自动整份重试。

Native 错误沿用 `{code,message}`：`SETTINGS_ALIAS_BASE_NOT_READ`、`SETTINGS_ALIAS_REVISION_CONFLICT`、`SETTINGS_ALIAS_TOKEN_INVALID`、`SETTINGS_ALIAS_WRITE_IN_FLIGHT`、`SETTINGS_ALIAS_COMMIT_INTERRUPTED`。最后一项为结果未知；child 清空基线并要求重读，不自动重试。原设置路由精确增加 `#/allCommands`、`#/shortcuts`；外层 URL query 与任意 hash 仍拒绝。实际原 DOM 菜单会生成 `#/shortcuts?_t=<Date.now()>`，因此只对该内部 fragment 路由允许单个有界十进制 `_t`，拒绝其它字段、重复值、非数字或超限值。此差异由真实菜单导航观测修正，不能把内部 fragment query 与外层 URL query 混为一谈。

## Main 缓存与事件

onCommandAliasesChanged 由 inactive 接入共享 native subscription；在通知原 callback 前使 startupReadModel 和 settingsSnapshot 两层 alias 缓存失效。in-flight旧读必须采用更新代次的新数据，不能晚回写旧值；dispose后拒绝/释放。只更新别名与索引，不失效 app catalog 或重扫 apps。Native main 设置快照可用 Core 投影 alias value（raw比较仍保留Native），别名投影单值限额512 KiB、整体1 MiB，其他namespace限额不扩大。

## 分工与验收

Core alias、Native catalog/icon、Main adapter/cache、Child bridge/typed transfer 四个独立归属。Core完成后再派 Native scoped transfer/session/CAS 接线；Root只做公共 module hooks/预算文件等简单集成与关键 review，不让两 Worker 写同一文件。所有 authored文件≤500行。

先最小模块测试与 strict/typecheck，再构建和 source-bound Native。先用原 DOM 的真实观测校准必需字段，不能再猜 DOM activeElement 等于 OS focus 或将合法 duplicate drop 当错误。fixture异步状态、合成回执、Native事实分别记录。

验收覆盖原 DOM 新建/改名/删除、重开持久化、missingTarget/旧 string[]/unknown保留、同路径不同名同bucket/不同路径同名分离、至少1024条目录完整分页、超限/冲突/关闭未知/迟到回执、角色和图标原点拒绝。主窗搜索实时反映 alias，缓存更新不额外 getApps；可用自有后台探针验证 alias Enter 与同一生产 TaskRun/history 路径。原 UI/物理输入/材质/跨平台未验部分继续开放，默认入口不在本票切换。
