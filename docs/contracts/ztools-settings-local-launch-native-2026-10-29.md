# R68：原 Settings 本地页到 Main 的真实宿主合同

状态：2026-10-30两次隐藏真实宿主运行通过；独立Sol实际产物复核范围内APPROVE、无剩余P1/P2。完整本地启动交付仍进行中。最新证据为 [R68验收](../../output/renderer-main-frontier-r68-2026-10-29/verification.md)，上层产品合同为 [原版本地启动项闭环](ztools-original-local-launch-2026-10-29.md)。工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。

## 来源与入口

复用原 `launch-return` 验收管线，新增 `--registration-source settings-child`，仅允许 `--target-kind local-shortcut`。参数省略仍为旧 `core-seed`；历史 schema1 app 与 schema2 app/local 只能由外部 CoreSeed owner 校验。Settings child 采用 schema3，并要求外部 `registrationSource=settings-child`、requiredSchemaVersion=3、当前正式 Settings bundle revision、独立 SQLite 行。报告自述不能决定其来源或降级旧 schema。

Settings-child profile 使用既有 `/private/tmp/atools-renderer-launch-return-${runId}`，独立 bundle identifier 为 `dev.atools.renderer-smoke.${runId}`。原 owner marker、私有路径、NoFollow、进程/探针身份和终态清理门禁继续适用。误用 `renderer-smoke` 根的新增 validator 已修复，正确 owned root 与错误前缀/marker/PID/路径反例保留。

## 实际注册与使用

真实原 Main 打开 Wry Settings Child 的原 LocalLaunchSetting 页面。该模式的 Core 不预置快捷项，初始真实读数为空/revision0。同一具体 Child drop binding 接受 Rust 受控输入的四条精确 owned 路径：`launcher-apps/AToolsOwnedProbeFirst.app`、`AToolsOwnedProbeSecond.app`、`settings-registration/owned-file.txt`、`owned-folder`；不开放任意外部路径。

输入声明必须为 `inputSource=rust-injected-drag-event`、`physicalOsDrop=false`。绑定身份/nonce/角色校验、四项实际框架拖放监听 ACL 拒绝、原 SFC 列表/反馈与 Core 真正 mutation 各自有证据；队列接纳不是 DOM 送达证明。

注册四项后 revision4；首应用别名 `ATools R68 Alias` 后 revision5；关闭，Main 搜索到对应 local-shortcut 而 launchCalls 保持0；新文档/新session重开保留别名；清除别名及删除 file/folder 登记后 revision8、app2/无alias，再关闭。Main mutation 事件从实际基线精确增加4/5/8，不能改为 `>=` 或在前置后重置。原字段 id/name/path/type/addedAt 与非展示元数据连续，Core 可在 alias 变更时重算 pinyin/pinyinAbbr；最终整行与独立 SQLite 完全相等。

两个真实 session/Child/origin/URL、bundleRevision 及 binding/batch nonce 必须相互绑定。documentChanged为真实运行断言并有fresh session/中间Child归零边界；原始document UUID未保留，独立复核不逐值重放该UUID。错误 Main、旧session、旧 binding 均拒绝。两次关闭均要求 session/Child/layout/pending call/pending write 为0、bindingActive=false；该字段只证明绑定可用性状态，不声明观测到对象析构。

随后复用七阶段：baseline、pasted、denied、direct-return、typed、keyboard-return、disposed。启动计数0/0/1/2/2/3/3，TaskRun3/取消1/成功2、audit拒绝1/确认2、local history2/app0/各使用1，clipboard0，实际探针启动/退出与 Native/Node PID 一致。Settings-child 使用真实含 `.app` 的名字；CoreSeed 保持旧契约。

## 焦点、内容与清理

九个前置阶段与七个启动阶段合计16个离散 Native/AppKit 样本，本轮 visible/focused/applicationActive/mainKey 全false、focus-event0；Main 七阶段 hidden/unfocused 严格门禁保持。Child DOM visibility/focus 按实测原样记录，与父窗分开。此为采样及事件证据，不扩大为整个桌面全程 foreground 或 visible/physical/IME 验收。

Host 自然 terminal0 后，Node 以独立 owner、私有 canonical 目录和 NoFollow 检查复制有界 DB/WAL/SHM，只读查询自己的证据副本：integrity=ok、revision8、两 owned app/无alias，整行与 Native cleanup 相等。保留副本的 DB/WAL SHA 与运行记录一致；SHM 为可被只读连接更新的共享索引旁文件，单独记录，不能作为业务内容完整性判据。Settings-child三条实际任务/审计逐audit_id关联和local history另经独立产物复核；旧CoreSeed未保留独立SQLite/audit ID，只重算其运行门禁与聚合事实。

Host/probe terminal、正确 owner、严格 Native 报告、独立 SQLite、零 pending/live 全通过才删除对应自有 root。两次运行均自然退出且root/app bundle回收，独立复核补查六PID均ESRCH、root/bundle不存在。原 marker 在运行时验证，清理后独立复核依靠留存事实，不称重新读取原 marker。错误证据保留自有 root，不新增通用删除入口。

## 来源冻结与现有限制

R68 fresh binary `66c46ced47c322ae907d7889ec15c6894acbc9c5c12db77a2a0ac0ae14a43bc8` 与1470份 Native closure `1ad1a8c1be64a09aa2ec6adfb711241d075367afde1ed87e09f85747715de220`、owned probe、新 receipt、两份运行报告绑定。Main/Settings 正式 source/dist/compatibility/provenance 与固定干净上游前后及当前匹配；旧 R66 receipt 不具备新来源授权。

Main JavaScript603309/604116B、Settings resources797670/798151B，预算不变，未重建两份正式UI。默认仍为 Svelte；SQLite、按需 Node 与主程序优先/Harris随后保持。

实际复核回执见`output/renderer-main-frontier-r68-2026-10-29/reviewer-native-run-review.md/json`（JSON SHA `3d6a6015c94a5138bbc2cb32f13c3b6724385ea62a9c29964be7b37d20e24664`），两validator重算及11个篡改反例通过。

仍待：物理 OS 拖放、真实选择器、普通file/folder的实际打开和Finder揭示、可见固定/排序/取消、完整物理/IME/跨平台、默认Vue与完整UI/发行性能。当前不将票43或整体目标标为完成。
