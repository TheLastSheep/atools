# R80 原版普通 App 全局快捷键接入合同

状态：Root 已确定实施范围；架构建议见 `output/renderer-main-frontier-r80-2026-11-02/architecture-review.md`。本文件不是实现或验收回执。
工作区 `/Users/harris/Desktop/atools`；开发分支 `codex/atools-ztools-parity`；上游只读 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。

## 交付行为与不变项

- 原 Main 普通应用右键“更多 → 设置全局快捷键”，打开原 Shortcuts/global 编辑器并预填该应用；同名不同 path 不合并。也支持原选择器选择普通 App。
- 原页创建、改键/改目标、删除，一次请求完成 CAS、owned OS apply、持久提交及结果确认；关闭重开、启动恢复和退出回收属于同一功能。
- 只含 Native 当前 catalog 中的普通 App，不包含 local-shortcut/plugin/URL/shell。沿用 Main 的 exact path authority，label 不授权；不宣称 inode/签名或文件系统 TOCTOU 保证。
- 原 template/style/logo 不变，只作固定 SHA/锚的编译期脚本适配；原列表没有 enabled 控件，不新增可见启停。存量 enabled=false 不登记、不触发，后端状态与测试不冒充原 UI 启停。
- autoCopy 是独立能力。未真实实现时 true 明确 unsupported，恢复界面并保留存量字段；不假保存或改作启停。旧/plugin 行和未知字段保留，不能按 target 名称自动迁移为受信绑定。
- 默认 Svelte、SQLite WAL、按需 Node、主程序优先和 Harris 后置保持；无 Claim、提交、推送、安装新依赖或用户正式数据操作。

## Core 数据边界

- 公共原数组键仍为 `ztools-renderer:global-shortcuts`，每项上游字段包含 id/shortcut/target/enabled/autoCopy 等。未知行顺序和 RawValue 数字/扩展字段原文保留。
- 新 Native authority 固定键 `ztools-renderer:app-global-shortcut-targets`，按 rowId 绑定 `kind=app`、path/name 快照、授权 shortcut/enabled、配置 generation；另有固定 revision 键。三者同 SQLite Immediate transaction 提交。
- 新 owned App 行最多 64，原数组仍按现 128 KiB/4096 object rows 上限；authority 原文最多 128 KiB；path/name 分别 16 KiB/4 KiB。超限、歧义 owned id、无效已知 authority 拒绝，不截断或重排存量未知行。
- Core 只做类型、损失无关解析、prepare/commit/CAS，不依赖 Tauri/OS。prepare plan 保存实际全量前像；commit 比较原文和 revision，并在事务内最后检查 guard；不得仅靠 JS 反序列化再序列化充当原文基线。
- 新 id/config generation 由受信 Rust 生成。Native 接受 Core snapshot 的内部 revision 与前像，但页面 revision 是 Native 对完整当前 snapshot 绑定的 opaque 32hex token；任何原文变化均使旧 token 失效。
- Create/Update/Remove/SetEnabled 为闭集 Rust mutation；已知字段更改不丢未知字段。无 authority 的旧行只读保留；显式重新选择 App 后才允许受控 adopt，不隐式匹配名称。
- Core 新模块由专属 worker 给出实际公开 API 与测试后冻结，Native 据该 API 接入，不另实现第二份 SQL。

## Native 注册与事务

- 独立 AppBinding registry；现 FeatureCode registry 保持 API/replace_all 语义。抽取/复用 typed owned OS 算法与 Port，不复制不协调的 SDK 注册器，不将 path 塞入 targetCode。
- 与 Main/录制/Paste 共用既有 hotkey operation fail-fast lease；增加可移动 owned lease，内部 under-lease 操作不再次抢同一 lease。
- 最多 64 个新增 owned keys；规范化后静态保留当前平台 CmdOrCtrl+W/Q/V。Main 等动态 owner 经 SDK + 同 lease 仲裁，外部冲突以真实 OS register 结果确认；is_registered 只证明本 App 注册。
- 串行 owned task 持 lease 跨 prepare、OS apply、DB commit、发布与补偿，直到真实终态；调用者离开不能提前释放。不能持 DB/registry 锁等待 Tauri main-thread dispatch。
- 新键探测失败保留旧集合；provisional callback 在 DB commit 前不得派发。提交后发布新 generation；补偿失败/未知结果保持真实 owned 证据并隔离派发，不假称回滚成功。
- 回执区分 persisted/runtimeApplied/notificationDelivered/error；提交成功但通知失败不回滚数据，不让页面重建同一条。未知提交先重读判别，禁止盲重放。
- 旧回调、queued 旧 generation 在修改/删除后拒绝。回滚恢复也发行新 runtime generation，避免旧 queued 工作复活。

## 页面接口与跨页意图

- Main 新窄入口 `open_renderer_app_shortcuts` 仅接受 `{app:{path,name,subType:'app'}}`；验证实际 Main 与 Native 当前 catalog，name 只作展示，再打开/复用固定 Settings Child。拒绝任意 route/plugin/script/confirmed。
- 原 Main 菜单与 handler 脚本保留实际 app path/name，不按名称反查。仅确切设置命令 `ui.router?router=Shortcuts` 的普通 App payload 走此窄入口，其他 plugin launch 不因此放开。
- 固定 intent 为 `{version:1,id,sessionId,sequence,target:{kind:'app',path,name}}`；id/sessionId 为 32hex、sequence 为 safe integer。原 Child ready/general 契约保持，新 intent 使用独立窄 delivery/controller。
- 首次创建和已有 Child 均可一次消费；绑定当前 session/document/generation，latest-wins，关闭或离开目标页废弃未接受 intent。不存在通用 route 或任意 payload 转发。
- Current compiled Child、实际 parent/nonce/bundle/ready 及 `#/shortcuts` 共同授权两个窄 operation：`readAppGlobalShortcuts {}`、`mutateAppGlobalShortcut {revision,mutation}`。revision 为 opaque 32hex；Native 只接闭集 mutation，target 引用须重新核 Native catalog。
- 读回包含 revision、App owned 行、原 legacy 行只读投影及 runtime 状态；不输出私有 grant。具体字段由 Native owner 在实施前补齐 wire annex，前后端同时使用，不各自猜测。
- 修改/删除 UI 仅在真实回执后更新；CAS 冲突停止旧提交并重读。原 `dbPut → register → JS 删除补偿` 对 App 路径改为一次 mutation，不开放通用 dbPut/裸 register。
- ShortcutEditor 保留原 option 的 commandId/path；选中后不再用名称 `.find`，保存向父组件附带结构化 identity。无匹配或歧义旧目标要求重新选择。
- DOM 录制沿用原组件。若接特殊 Native 录制，必须增加 Shortcuts 独立 scope，不放宽 R71 General 的 origin/route 检查；不得逐按键 IPC。

## 启动执行与退出

- 一个 App 级 worker，最多 64 个紧凑 queued 事件，每绑定最多一个 pending/inflight；Pressed 首边沿入队、重复合并，Released 无条件复位 latch。callback 不进 DB/SDK/UI、不等 lease、不无限 spawn；忙时有界等待用 Notify，禁止轮询。
- queued 不等于 admitted；取得 owned lease 后再核 current row/generation/enabled、authority 与当前 Native catalog，再进入实际 owned launch task。修改/删除在已 admitted 工作期间返回 busy，不假成功。
- 抽共享 Native App launch service，Main 保留真实 Webview 授权，hotkey 用不可序列化、仅 Native 可构造的 AppLaunchGrant。启用绑定表示用户确认启动该 App；每次仍执行 Deny、PermissionDecision、TaskRun、审计与成功历史，不另写 shell 分支。
- 私有 guarded audit 入口携 grant 沿既有 TaskRun/tool_executor 至固定 builtin/open_or_reveal_path/reveal=false/path。公开调用无 grant，JSON/页面不能提供 confirmed 或 grant，不改 Core 依赖方向。
- 真正 blocking closure 持 grant/lease；DB/catalog/权限读取在短 fence 外。与 shutdown 共用的短 fence 覆盖 stopping/current-generation 检查和实际 spawn；等待进程在 fence 外。spawn 胜则 drain，stop 胜则不 spawn。
- drop async awaiter 不取消真实 blocking 工作，不提前清 accepted-work/lease。open 已发生但 audit/history 失败须明确已生效、记录失败，不自动重试启动。
- 启动只作一次 bounded restore；仅原行/authority 一致的 enabled App 登记，缺失/保留键/冲突逐项状态保留配置，不转绑、不轮询重试。
- ExitRequested 先停新 admission/撤 queued，再异步 drain 实际 mutation/launch、注销自有键，最后允许一次 exit；UI thread 的 Exit 不 block_on。强杀不承诺 drain。
- SDK updater restart 前复用同一窄 drain hook，不能仅靠 ExitRequested；不重写 R79 updater 状态机，不用裸 unregister_all。

## 预算、归属与证据

- 无新 Node/常驻进程、全局键流监听或 JS 定时轮询；单次保存 1 mutation RPC、按键触发 0 IPC。64 owned/64 pending/1 worker 为上限，按真实计数验证。
- Main 基线 612530 B，现 cap 614004 B 先保留；事前新增功能增量上限 4096 B。Settings 基线 806371 B，现 cap 812049 B 先保留；事前增量上限 8192 B。若旧 cap 不足，先保留失败/收敛，再显式登记 R80 新 milestone，不能事后以实测值设门槛。
- Updater runtime/provenance cf49…全部七文件保持；默认 Svelte 不构建不切换。前端正式重建只在源码/strict/非作者审查后执行；不混用 R79 binary/receipt。
- Core worker 独占新 Core domain/store/tests 及最少 module export；Native worker 独占 AppBinding registry/lease/launch/guard/exit/Settings endpoints；Frontend worker 独占 Main/Settings bridge、原脚本 patches/测试/预算策略。共享调用文件写前报 Root 定边界，禁止同文件并发写。
- 先定向 tests，再当前范围检查；普通独立复核，权限/数据一致性增量交 Astra。Rust 唯一 Cargo lane、locked/offline/-j2，Root 决定 fresh build 与实际运行。
- 实证须覆盖真实 caller CAS/commit/补偿、同名、失效/旧代次、Deny、spawn/stop 两种胜序、调用者退出及启动恢复。原 Main→原 Shortcuts 全路径与真实 OS register/fire/修改/删除/退出分别验；注入事件不冒充物理按键。
- R79 证据/失败记录保持；完整默认迁移、真实物理输入/可见材质/Windows/Linux、Harris 与可选同步仍属完整目标，不因本切片缩小目标或称全局完成。
