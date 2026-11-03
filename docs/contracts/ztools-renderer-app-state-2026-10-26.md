# ZTools Renderer 应用状态合同

日期：2026-10-26

上游：`/Users/harris/Desktop/ZTools`，固定提交 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`（本次核对时工作区干净）

ATools：`codex/atools-ztools-parity`（工作区已有大量未提交改动；本文只新增）

本文件记录固定上游源码的静态协议，供 Rust domain/API 设计参考。它不是桌面运行、交互或兼容验收证据；未运行 build、Cargo 或 browser。

## 持久化记录、身份与排序

| key | 真实记录与语义 |
| --- | --- |
| `command-history` | 数组，元素为命令快照，并带 `lastUsed`（毫秒时间戳）和 `useCount`。实际快照可包含 `name/path/icon/type/subType/featureCode/pluginName/pluginExplain/cmdType/originalName/persistedName` 等。每次加入或更新后按 `lastUsed` 降序写回；持久化列表没有数量上限。首页调用 `getRecentCommands()` 不传 limit，默认折叠仅显示 `recentRows × 9`（默认 2 行、18 项），可展开全部。 |
| `pinned-commands` | 有序命令快照数组；pin 追加到末尾，reorder 原样替换顺序。无持久化数量上限；首页默认折叠显示 18 项，可展开全部。 |
| `command-usage-stats` | 数组记录 `{path,type,featureCode,name,lastUsed,useCount}`；新增时 `featureCode` 可为 `null`。当前 launch handler 只在插件分支新写此表；新行不写 `pluginName`，`name` 是 feature 显示名。更新仅递增计数和刷新时间；不排序、不裁剪，也不发事件。搜索按 `${path}:${featureCode || ''}` 建计数 Map。 |

来源：`src/main/api/renderer/commands.ts:615-847`；`src/renderer/src/stores/commandDataStore.ts:95-120,1547-1665`；`src/renderer/src/components/search/SearchResults.vue:211-223`；`src/renderer/src/components/search/AggregateView.vue:3-32`；`src/renderer/src/components/common/CollapsibleList.vue:48-95`；`src/renderer/src/composables/useSearchResults.ts:68-93,282-287`。

### Identity

- 插件去重、查找、移除以 `featureCode` 精确区分功能；有 `pluginName` 时优先用插件名识别（便于插件目录路径改变），否则退回 `path`。插件右键删除/取消固定传入 `{path, featureCode, name: pluginName || displayName}`。实现见 `src/main/api/renderer/commandMatchers.ts:16-45,52-80,87-115`。
- direct app 身份是 `path + name`；缺 name 才退回 path。相同可执行路径下的不同 alias 是不同历史/固定项。pin 时 direct app 写入 `persistedName || name`；renderer 先按 `path + name` 找当前 alias，找不到时按 path 回退，但保留 `persistedName`，以便 alias 删除后仍能准确删除旧记录。实现见 `commands.ts:751-780,941-969`、`commandDataStore.ts:351-420`。
- 其他类型在提供 name 时按 `path + name`；旧 `type:'app'` 记录兼容 direct app 处理。历史插件项含 `pluginName + featureCode`；插件不同 feature 共用 plugin path，但仍是独立记录。
- history/pin 的插件身份可用 `pluginName + featureCode` 跨目录识别。Usage stats 虽调用同一 `findCommandIndex`，但新写行没有 `pluginName`，所以实际回退为 `path + featureCode`；插件路径升级 helper 因而可能无法改写新格式统计行。renderer 的统计 Map 还会丢掉 `name`，只按 path/featureCode 索引；若旧数据含同 path、同 featureCode、不同 name 的记录会折叠。当前 launch handler 不为 direct alias 新增统计行。

## 启动与计数时机

- `type:'plugin'`：通过禁用检查并补齐默认 featureCode 后，**先**写 usage stats；随后处理历史并准备插件视图。因此插件打开后续失败也可能已有统计/历史。`cmdType:'window'` 不写历史；`img/over/files/regex` 只在 `param.inputState` 存在时保存 `last-match-state`，删除旧 `special:last-match` 后重新加入该特殊历史项；没有 inputState 时不写历史。其余 plugin command 在插件准备前加入历史。
- `type:'file'`：执行 `showItemInFolder` 后写历史，不写 usage stats。
- direct / app / system-setting / local-shortcut 等非 plugin 分支：启动成功返回后写历史，不写 usage stats。管理员启动走单独路径，启动进程请求提交后即加历史，不等待异步进程结果。
- 插件 usage stats 的类型字段由插件分支写入；普通 app launch 不会在该 handler 中增长使用次数。历史写入和统计写入各自直接 `dbPut`，没有共同原子事务。

来源：`src/main/api/renderer/commands.ts:398-547,557-610,615-847`。

## Mutation 参数与事件

| 操作 | 原调用参数 | 持久化与事件 |
| --- | --- | --- |
| 删历史 | `removeFromHistory(path, featureCode?, name?)`；首页右键序列化 `{path,featureCode,name}`，plugin name 用 `pluginName`，direct app 用 `persistedName || name` | `dbPut('command-history', filtered)` 后发 `history-changed`；即使没匹配项也写、发事件。 |
| 固定 | `pinApp(commandSnapshot)`，对象包括命令身份和显示字段 | 按身份去重；重复则不写且不发事件。新项 push 末尾，写 `pinned-commands` 后发 `pinned-changed`。 |
| 取消固定 | `unpinApp(path, featureCode?, name?)` | 过滤后写 `pinned-commands`，发 `pinned-changed`；无论是否实际删除都如此。 |
| 排序 | `updatePinnedOrder(commandSnapshot[])` | 精确采用入参数组顺序，清洗为 `name/path/icon/type/subType/featureCode/pluginExplain/pinyin/pinyinAbbr/pluginName/cmdType/originalName/persistedName` 后写回并发 `pinned-changed`。Renderer 本地先乐观更新，收到对应事件时跳过重复 reload。 |
| 清空历史 | 内建 clear-history 命令，无参数 | 写空 `command-history`；发 `history-changed` 和 `app-launched`，随后隐藏窗口。 |
| 清空固定 | store `clearPinned()`，无参数 | 本地赋空并调用 `dbPut('pinned-commands', [])`；该 helper 不发 `pinned-changed`，当前 renderer 源码未发现调用点。 |

来源：`src/main/api/renderer/commands.ts:121-143,918-1033`；`src/renderer/src/stores/commandDataStore.ts:1572-1691`；`src/renderer/src/components/search/SearchResults.vue:417-538,814-888`；`src/main/api/renderer/systemCommands.ts:200-214`。

### 自动清理与迁移写入

- 启动迁移在数据有变化时会自动写入：旧开发插件名迁移处理 history/pins/super-panel（补 `__dev`、移除 `pluginSource`）；旧网页快开引用清理处理 history/pins/usage-stats/cache；macOS `.icns` 迁移处理 history、pins、cached commands、local shortcuts、super-panel。上述迁移本身不发 `history-changed` / `pinned-changed`。
- 插件删除调用 `removePluginUsageData(effectiveName)`：仅在元素数减少时按 `pluginName` 清除 history/pins 并写库，分别发两个变更事件；该函数不清理 `command-usage-stats`。
- 插件路径升级通过 `replacePluginPathReferences` 按 `pluginName`（旧记录还可用 name+old path）改写 history/pins/usage-stats 的 path，只在有改动时写库；该 helper 不发送 history/pin 变更事件。
- renderer 加载不是持久化清理：history 只按当前 command path 集合过滤并保留 `special:last-match`；缺失 path 的记录被隐藏但不 `dbPut`。plugin history 按 path 判断，不检查 feature 是否仍存在。pinned 只把不可用/禁用 plugin 从内存列表过滤；普通应用固定项不按已安装应用过滤，找不到当前应用时回退展示存档快照。上述过滤不会自动删除数据库记录。

来源：`src/main/core/startupDataMigrations.ts:60-87,151-199,254-281`；`src/main/api/renderer/plugins.ts:460-488,631-660`；`src/main/api/renderer/pluginDevProjects.ts:227-255`；`src/renderer/src/stores/commandDataStore.ts:818-900`。

## 首页、右键与拖拽 DOM

- 空查询首页结构是 `.scrollable-content > .aggregate-view > .content-section`；启用 `showRecentInSearch` 时，其中两个 `.collapsible-section` 依次是标题“最近使用”和“已固定”。通用列表结构为 `.collapsible-section .list-content .app-list .app-grid .app-item`。DOM 没有区分 history/pinned 的专属 data-testid/class，区分依赖 section 标题与组件顺序。
- 仅固定区启用拖拽：`.app-list > .app-grid > .app-item`；VueDraggable 的 item key 是 ``${name}|${path}|${featureCode || ''}``，ghost/chosen class 为 `.ghost` / `.chosen`。数组更新沿 `CollapsibleList → AggregateView → SearchResults @update:pinned-order → updatePinnedOrder` 写回。
- grid 右键目标 `.app-item`；列表搜索模式目标 `.list-mode-results .vertical-list .list-item`。二者都 prevent 默认菜单并把 item + source (`history|pinned|search|recommendation`) 送到 `SearchResults.handleAppContextMenu`。右键菜单通过 `window.ztools.showContextMenu(menuItems)` 发给原生菜单层，不是页面 DOM 菜单。历史区含删历史；固定区根据身份给固定/取消固定菜单。

来源：`src/renderer/src/components/search/AggregateView.vue:1-32`；`src/renderer/src/components/common/CollapsibleList.vue:1-25`；`src/renderer/src/components/common/CommandList.vue:1-22,54-66,138-146`；`src/renderer/src/components/common/VerticalList.vue:1-29`；`src/renderer/src/components/search/SearchResults.vue:1-50,417-538,814-888`。

## ATools 当前适配差距与 Rust 边界建议

- `startupReadModel` 已将这三项作为 `ztools-renderer:<key>` settings 读取；`dbGet` 返回解析后的 namespace value。history/pins 没有专用 schema/写入；adapter `dbPut` 只接受 `search-preference`。见 `packages/ztools-renderer/src/startupReadModel.ts:4-18,86-119`、`hostAdapter.ts:227-246`。
- 当前 `getUsageStats()` schema 是 `{path, featureCode?, useCount}`，解析时丢掉源 `type/name/lastUsed`，且 `MAX_READ_ROWS=4096` 超限时整次解析失败；ZTools 的写入没有此上限。当前 UI 的 path+featureCode Map 也不能区分同 key 的多条历史记录。见 `startupReadModel.ts:20-25,43-47,203-216,307-309`、`packages/ztools-renderer/src/types.ts:71-104`。
- adapter 的 `onHistoryChanged` / `onPinnedChanged` 当前为 inactive no-op；`launch` 仅允许清单中的 app/direct path，并经 `open_or_reveal_path`，不接 plugin launch options，也没有上述历史/统计副作用。见 `hostAdapter.ts:21-45,184-214,273-281`。
- 建议 Rust domain 分开建模：`CommandSnapshot`、历史时间/次数记录、有序 pin 列表、usage stat；统一 identity 函数显式保留 pluginName+featureCode（缺 pluginName 时 path fallback）及 direct app path+persistedName。单独定义“候选列表投影/可见行数”与持久列表，避免把首页 18 项折叠数变为存储上限。集中提供 remove/pin/unpin/reorder/clear/launch-recording 操作，并只在源协议对应写入后发布 history/pin events；launch recorder 需收到 type/cmdType/inputState 与 launch 阶段，保留插件先计数、普通 app 成功后计历史的现状。

以上为源码契约建议，尚待主 Agent 将持久化和事件接口实现后另行验收。
