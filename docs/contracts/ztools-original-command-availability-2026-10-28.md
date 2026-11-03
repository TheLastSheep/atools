# R35：原版禁用指令写入与刷新

开发工作区 `/Users/harris/Desktop/atools`，分支 `codex/atools-ztools-parity`。固定上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`，原 Vue/CSS 不变。

## 原版行为与实现边界

原 AllCommandsSetting 与 usePluginCommandActions 保存完整 `disable-commands` string[]，再调用无参 `internal.notifyDisabledCommandsChanged()`；Main commandDataStore 的监听器重读该键并执行已有过滤。direct/app 使用稳定路径 ID，并兼容旧名称 ID；插件 ID 与插件整体启停分别处理。宿主不修改这些原版规则，也不对未知 ID 做删除。

Child facade 仅为 `dbPut('disable-commands', value)` 增加有界 writer，其余键保持原权限规则。使用 `writeDisabledCommands`，精确 payload `{baseToken,value}`。baseToken 来自当前 session/bundle 中完整已读 commandSettings 快照，Native 从该快照取旧值；调用方不能自带 expected。SQLite Immediate 事务取得写锁后检查仍是当前 ready/live 会话，再将数据库当前解析值与快照值做 CAS。无存储行与已存在 JSON null 区分，坏数据/越界/冲突均拒绝。

每次保存整表最多4096个非空字符串，每项UTF8≤16448字节，数组JSON≤128KiB。新操作专用 envelope 上限为128KiB+256字节；其它 Child 32KiB、Native 64KiB 的操作限制保持。固定键偏好写入不授予文件、插件执行或通用数据库权限。此处是为现有128KiB存储范围设计的单次有界通信，不能全局扩大调用上限。

回执精确为 `{version:1,success:true,changed:boolean,notificationDelivered:boolean}`。确认提交后失效 Child commandSettings；changed时只向 Main WebView 发送一次 `atools://renderer-disabled-commands` null。发送失败不会谎报未提交。原通知方法仅消费本 bridge 已确认的写回执，不再发送重复IPC；无回执、已消费回执、未确认的刷新都不能假成功。

Core固定错误常量区分session guard与CAS冲突。Native错误码为 `SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT`、`SETTINGS_DISABLED_COMMANDS_COMMIT_UNKNOWN`、`SETTINGS_DISABLED_COMMANDS_FAILED`、`SETTINGS_DISABLED_COMMANDS_BASE_INVALID`；session错误沿用既有。结果未知时清基准，提示重开确认，不盲目重放写入。

## 缓存、预算与验收

Main复用现有命名空间读取与批量快照；禁用通知必须在 public callback 前失效两层缓存，并保护旧在途读取。别名通知、错误隔离与释放语义保持，不增加系统应用扫描。已有事件生命周期可按实际同类职责复用，禁止通过删校验、修改原样式、换依赖/压缩器或信任manifest任意自报预算过门禁。预算变更须明确冻结新milestone并保留旧门禁失败，不能记为原预算通过或性能改善。

本轮预算决策明确覆盖上述旧累计门槛：以R34来源绑定实测产物Main589758/Settings779464为新milestone基线，分别允许1KiB/4KiB增量；Main绝对上限590848，Settings绝对上限786432不变。保留增量与绝对双门禁、旧milestone白名单和全部失败日志，不信任任意manifest自报预算。这一调整及理由见 [R35预算决策](/Users/harris/Desktop/atools/output/renderer-disabled-commands-2026-10-28/budget-decision.md)，不作为性能改善证据。

Child还保留实际交给UI的最后一次禁用列表。自动重读仅提供Native token，不代表UI已经观察新列表；与已观察列表不同即拒绝保存。冲突或结果未知后必须显式重新读取，再允许后续写入；pin失效或过期读取不得静默改变该观察基线。

独立原生 functional report 验证原菜单、SQLite及真正消费通知的原 commandDataStore 搜索结果，和旧12阶段分别记录。同一 fresh Child，不增加 observer；不用数据库读回替代 Main 搜索过滤，也不将隐藏流程称为物理键盘/可见像素验收。Core/Native/两端测试、正式构建、真实进程终止与回收及预算均须实际检查后更新状态。

完整目标仍包括可见UI、其余设置/系统动作、跨平台及发行性能验收；R35不缩小完整还原标准，不切换默认入口，不暂存、提交或推送。

## R35验收结果

Root最终来源绑定运行 `00ad4fd41e6d4d90859d67ab76f91a23` 通过：原版菜单禁用与启用、SQLite保存与Child读回、原Main store排除与恢复、其它设置不变，10项全部为true；原12阶段全部通过，进程exit 0，临时app/数据目录、session/Child/layout/pending任务和材质owner均清理。来源、产物、binary与build receipt运行前后稳定。Core9、Native314（1忽略）、严格当前dist reader单独1、前端249、Node68通过；两端正式构建与workspace编译通过。

实测Main590200字节（相对R34+442）、Settings782341字节（+2877），通过本轮明确调整后的双预算。该Native运行是hidden模式，主题/材质的配置状态通过，`visual=unverified`；没有新的已接受PNG，不代表可见画面或物理键鼠通过。插件启停、通知投递失败的Native故障注入、永久不结束的旧Main批次读取超时策略、跨平台和发行性能仍未验收。详见 [完整验收记录](/Users/harris/Desktop/atools/output/renderer-disabled-commands-2026-10-28/verification.md) 与 [机器可读结果](/Users/harris/Desktop/atools/output/renderer-disabled-commands-2026-10-28/verification.json)。
