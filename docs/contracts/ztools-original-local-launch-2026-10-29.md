# 原版本地启动项闭环

状态：R68真实原Main→Wry Settings Child→原本地页受控Rust注册→别名/关闭/重开/Main搜索→实际权限启动/审计/历史/退出通过，独立Sol实际产物复核范围内APPROVE、无剩余P1/P2；R65/R66/R67历史保留。输入为rust-injected-drag-event、physicalOsDrop=false。物理OS拖放/真实选择器、普通文件/文件夹打开与揭示、可见流程继续待验，票43仍in-progress。最新结果见`output/renderer-main-frontier-r68-2026-10-29/verification.md`及`ztools-settings-local-launch-native-2026-10-29.md`。工作区`/Users/harris/Desktop/atools`，开发分支`codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。上游只读固定`9b15fb1a2a9f3ec886016632761c7bb21e39557a`。主程序及内置设置优先，Harris随后，默认仍Svelte。

## 完整目标与本批交付路径

原LocalLaunchSetting与Main形成可用流程：添加文件/文件夹/应用→显示列表→编辑/清除别名→Main及时搜索→打开→最近使用/固定/排序/取消→删除或清理失效引用；重开仍保持，错误不假成功。原版模板/CSS保持。完整目标还包括真实Native拖放、系统选择器及可见/物理输入；R65实现添加按钮/按路径添加和管理、Main启动的数据/调用路径，不把浏览器夹具替代真实OS面板/拖放验收。

选择上次匹配依赖匹配插件启动producer，留待插件闭环，不改变普通app launch语义。旧R66的locked=true是当时快照；R68已有前检在北京时间2026-10-30 11:33:21记录screenLocked=null（未知），不据旧值描述当前桌面。

## R66运行复核

实际Tauri transport曾漏放行`atools://renderer-local-shortcuts`，已修正且目标仍限定Main WebView。两种运行各7阶段通过，真实TaskRun为取消1/成功2，审计拒绝1/确认2；本地模式catalog0/本地注册2，最终历史local-shortcut2/app0，普通app模式相反。记录经Core预置、输入为DOM合成、自有目标为`.app`；不扩大为选择器添加、普通文件默认处理器或可见交互通过。Main603309B（较R65+36B），604116B预算不变，Settings资源不变。

## R67拖放接线复核

已补精确localLaunch原生路由、原R65与新资源milestone加载策略，具体Child的原生Drop路径由Rust有界登记，通知原SFC刷新/反馈。Astra复核关闭通知序号抢先与旧结果清新hover两项P2；实现与自动化通过，OS实际拖放和本轮Wry/App运行仍未验收。Settings最终797670B（+3615），新4KiB/798151B上限余481，Main603309B不变。见`ztools-native-local-drop-2026-10-29.md`及`output/renderer-main-frontier-r67-2026-10-29/verification.md`。

## R68真实Settings到Main宿主复核

新模式初始Core空/revision0，原Wry Child与原LocalLaunchSetting通过同一真实drop binding接受Rust受控四路径，两app/file/folder登记revision4，首app别名revision5；关闭后Main实际匹配该local-shortcut且未启动，新session/新document重开保留；清除别名、删除非app登记后revision8/app2，再关闭。Main事件精确基线0→4/5/8，七阶段保持事件累计；未用Core预置代替设置登记。

Settings-child schema3与外部source/required version/正式bundle/独立SQLite绑定，未知或缺字段、伪phase、错nonce/Child、ACL/focus/cleanup错误拒绝。省略source的旧CoreSeed实际schema2回归通过。真实七阶段两run均TaskRun3/取消1/成功2、audit拒绝1/确认2、local history2/各1次，自然exit0、owner/probe/root/bundle回收；4项框架拖放监听ACL实际拒绝。原root前缀P1已修并保留反例。

九个前置和七个启动阶段共16个Native/AppKit离散样本visible/focused/applicationActive/mainKey=false、focus-event0；不推导全时段桌面foreground。两次关闭session/Child/layout/pending call/write=0、binding不可用；两session/nonce不同，documentChanged有运行断言（原UUID未保留）并与实际正式资源绑定。Node只读证据副本integrity=ok、rev8/app2/无alias且整行一致；DB/WAL SHA一致，SHM只作共享索引旁文件记录。详见R68合同与独立复核回执，不把受控Rust注入当物理OS拖放。

## Core数据契约

- 固定数据key `ztools-renderer:local-shortcuts`，单独revision key `ztools-renderer:local-shortcuts-revision`；不写插件数据或General。SQLite Immediate中检查guard、读取并修改最新值，changed才递增安全整数revision，noop原文/revision不变。absence=空列表，已存null/损坏/超限明确拒绝，不静默清理。
- `RendererLocalShortcut` DTO：字符串id/name/path，type为file/folder/app，addedAt为非负JS安全整数；可选alias/icon/keywords/pinyin/pinyinAbbr。可选字段缺失按原版处理；不把旧记录投影后再整体写回。Core提供 `read_renderer_local_shortcuts() -> Vec<RendererLocalShortcut>`、`apply_renderer_local_shortcut_guarded(mutation, guard) -> RendererLocalShortcutWrite{changed,revision}`。
- mutation公开enum：`Add{record}`、`SetAlias{id,alias}`、`Remove{id}`、`RemoveMissing{expected:Vec<RendererLocalShortcutIdentity{id,path}>}`。新record由Native元数据生成；id用UUID、addedAt用宿主时间。新路径与已有path重复拒绝；旧重复记录保留。SetAlias改首次id匹配并派生pinyin/pinyinAbbr，alias trim，空串清除alias；Remove按原版删除所有同id记录。RemoveMissing仅删除观察到的相同id/path，避免删掉后来替换的引用；不删除任何实际文件。
- 既有行以RawValue保留；只编辑目标行已知字段，未知数字/小数token不经JS或Value重写。更新alias时未知字段值也保留原始token。未知字段只作被动JSON。最大4096行/完整raw UTF8 128KiB、JSON深度8/节点32768；id256B、path16KiB、name/alias4KiB、icon64KiB、pinyin/pinyinAbbr各16KiB，keywords最多128项/每项512B。先计数再分配完整输出；Core不执行OS I/O。
- 扩展`RendererAppIdentity`为可选wire字段`subType`（Rust默认App，枚举App/LocalShortcut，序列化app/local-shortcut）。现有双字段调用继续有效。Core历史/固定/移除/排序/清空支持这两类direct记录，并保留plugin/builtin/future行；保存新的subType，默认app行为不回归。类型未知不作为直接启动。必要Rust构造方完整迁移。

## Native边界与资源

- Child仍走已绑定的设置session/实际Webview/main父窗/nonce/generation/active guard与现有有界operation系统。固定7操作：`readLocalShortcuts`、`addLocalShortcut`、`addLocalShortcutByPath`、`deleteLocalShortcut`、`updateLocalShortcutAlias`、`openLocalShortcut`、`deleteMissingLocalShortcuts`。请求分别为`{}`、`{type:file|folder}`、`{path}`、`{id}`、`{id,alias}`、`{path}`、`{}`，精确字段验证。read返回DTO数组；其余按原UI回`{success:true}`或固定可识别业务失败；取消为`{success:false,error:'用户取消选择'}`。固定上游的失效清理也只回success，不增加无用计数字段。
- 路径来自原选择器或明确按路径操作；新路径须当前OS绝对路径、UTF8/无NUL、有界元数据读取，目录或常规文件/合法应用。清理失效项只采用明确NotFound，权限/其他I/O错误不按不存在删除。元数据准备在阻塞worker，锁外完成；提交前检查session，关闭不开始新工作。已提交事务可能完成，UI不接受迟到回执。
- 添加按钮复用现有可取消Native panel后台。只开放窄的trusted settings选择接口，不给插件增加任意路径/对话框权限。全应用同一面板资源账本，单窗1/全局4、120s deadline；session closing/timeout取消真实面板并等待原生确认，关闭后不提交选中路径。仅该添加调用允许128s等待，普通RPC期限保持。
- 当前Native panel仅macOS受支持，其他平台明确unsupported；按路径管理/打开的支持范围单独记录。getAll允许专用≤256KiB响应，其他操作仍用原96KiB预算；请求仍32KiB。不得无条件扩大其他协议预算或静默截断列表。
- Main `launch_renderer_app`的target带默认app的subType。App仍必须在原生安装应用catalog；LocalShortcut必须在Core当前注册表且路径/显示名对应，不能用前端列表代替最终授权。打开复用audited `open_or_reveal_path`，reveal同样校验注册表；仅成功后写历史/通知/hide。Child列表中的open也复用相同权限/TaskRun调用，不记录伪app历史；取消/打开失败/权限拒绝不记录成功。
- changed提交后仅向Main发`atools://renderer-local-shortcuts` `{version:1,revision}`。一个写入一次请求/一次事件，不另广播全量内容。无新生产进程、空闲轮询或不使用时的额外listener。

## 前端接入

- 原`internal.localShortcuts`提供getAll/add/addByPath/delete/updateAlias/open/deleteWhenNotExist七方法。复用现有Child request、session与错误处理，必要时抽出独立service；未知方法仍拒绝。参数在提交时快照，串行/有界；关闭后停止新请求，不接受迟到响应。原UI确认/刷新与取消文案保留。
- Main复用启动批次的local-shortcuts数据，不增加启动RPC；合法变更事件失效该域的setting/read-model/命令目录并使原Store重载，早到和迟到读不得回滚新数据；非法/stale事件不污染缓存。订阅资源有界并随dispose回收。
- 首次任意settings批次（包括General预热）之前先等待同一个local变更监听ready，早到变更留待原Store订阅时回放；generation拒绝迟到快照。已知App先查原目录并直接启动/揭示，不等待本地配置；显式local只查local，显式app不回退。
- Main app/direct分派保留原App路径白名单；`subType:local-shortcut`独立解析/发原生最终核验。历史、固定、排序、取消和Finder菜单按原direct身份及两类subType工作，插件操作仍后置。hostAdapter已498行，先做文件归属检查，把目标解析/launch/reveal职责提为有意义模块，不继续堆入大文件。
- 原DOM File→getPathForFile仍不作为可信路径解析。R67另绑定实际Child原生事件，在Rust登记后发无路径结果供原SFC刷新；不得用该接线/夹具宣称OS实际拖放已验。

## 两处上游逻辑修正

固定上游Store按名字匹配local历史/固定项会将同名B误配到A；别名改变后原SearchResults又仅给app使用persistedName。本批通过`packages/ztools-renderer/upstream-compatibility-patches.mjs`在构建时精确修正：Store用subtype/path/name匹配并按同path回退；三处菜单身份分支支持local的持久化名字。两个源文件的before/after SHA均固定，模块必须各实际应用一次，漂移/遗漏拒绝构建，provenance记录描述符。原版模板/CSS及上游checkout不修改，不能宣称完整Store逻辑未改。

## R65历史验证与预算

1. Core真实SQLite添加/重复拒绝/别名/删除/重开/未知metadata token、并发当前值、guard/预算拒写及direct app/local类型回归；不触实际文件。
2. Native私有临时文件/目录元数据、NotFound与权限分支、session/取消/迟到、真正Core调用、打开失败不写历史，原App白名单不放宽；OS选择器与真实可见另记。
3. 固定上游原LocalLaunchSetting UI完成添加/取消/改别名/删除/确认/失败，Main收到事件搜索/启动/固定/历史/移除；浏览器synthetic与Native/SQLite分层记录，收集截图并清理资源。
4. Root独立review、相关类型/回归、正式资源构建与workspace检查。Main最终603273B（+4277），4KiB门槛失败181B保留，新里程碑明确冻结5KiB/604116B；Settings实际794055B（+3598），独立冻结4KiB/794553B，不采用初提6KiB。见`ztools-local-launch-budget-2026-10-29.md`；不把旧失败改判通过或删除必要验证来压字节。CPU/RSS/唤起/IPC延迟需另测。
