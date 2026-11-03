# R46 原 General 的窗口位置与剪贴板保留

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`；只读 ZTools `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。Luna 实施，Main 定接口、审查、独立验收；保留既有 dirty，不提交推送。

## 原版行为与交付

原 General 的窗口呼出位置有 remember/cursor/primary/lastActive 四项。更改先保存 General，再通知宿主。每次后续呼出才按策略定位，不在改设置时抢前台。remember 恢复鼠标所在屏的已记位置，cursor 在鼠标屏居中，primary 在主屏居中，lastActive 在打开 ATools 前的外部活动窗口所在屏居中；无有效外部窗口则回到鼠标屏。ATools 旧 LAST_USED_MAIN_MONITOR 指自身上次所在屏，与原版不等价，须纠正。

剪贴板保留天数为 1..3650 整数，默认 180。原按钮“重置”仅恢复 180 天，不清空剪贴板或已有历史。原 updateClipboardConfig 只更新配置，下一次捕获/保存历史时执行保留清理；ATools 现有 capture 每次从 General 读取配置，复用此消费者，不另加立即不可逆清理、常驻轮询或第二次配置 IPC。

## 接口与所有权

- Core 与 Child 原 17 个 writable 字段顺序保持，末尾依次追加 `windowPositionStrategy`、`clipboardRetentionDays`。策略严格枚举；天数接受数学整数 JSON number，拒绝字符串/布尔/null/分数/越界，持久化规范整数。保留 CAS、边界预算、未变字段与坏旧 hotkey 原值。
- Child `updateWindowPositionStrategy(value)` 使用既有 General preference 接口。`updateClipboardConfig(value)` 只接收 own-data exact `{retentionDays: integer}`，映射 `clipboardRetentionDays`。原 saveSettings 已获确认后同值通知不发第二次 Native 调用；读写不增加通用命令。
- 位置消费者仍每次读取已提交数据库。定位职责放入独立 window 模块，复用同一 `position_main_window(app, window)`；hidden QA 可以调用该内部生产函数，不能通过请求参数伪装选中策略。
- 居中基准为原版 800×600 逻辑尺寸：先按所选屏 scale 将工作区尺寸还原为逻辑尺寸，逐轴 `floor((logicalExtent - logicalAnchor) / 2)`，再将偏移转换成物理像素并加物理工作区原点，最后用实际窗口尺寸 clamp。不得先在物理像素取整；2倍屏工作区 `(0,66,3024,1898)` 的原版目标为 `(712,414)`，不是415或416。
- 前台呼出前才有界读取外部窗口上下文；启动与 hidden QA 不采集、不请求前台、不注入系统键。外部窗口坐标与 Tauri 物理监视器坐标必须明确转换，不以统一缩放乘法假定混合 DPI。无权限/不可得就 cursor fallback，其他未实现平台显式列为未验证，不把 API 存在当成通过。

## 验收

1. Core 真实 SQLite：十九字段顺序、枚举/整数边界、规范存储、CAS 冲突和其它字段保留。
2. Child：原投影差异提交、同值通知无多余 IPC、重置 180、非法/访问器/只读/过期会话拒绝、旧 hotkey 保护；严格 TS、Svelte 和正式原 Settings 构建。
3. 原生沿用现有 settings-input profile 与顺序 journey，不加第二套通用验收进程。原 General 通过真实 Dropdown/数值 input/重置按钮修改，SQLite 独立读回，fresh Child 持久化。新固定 sidecar `native-general-policies-report.json` 不写 Native passed 位，由 Node 对 owner、原始观察和生产实际结果独立重算。
4. 真实隐藏主窗口通过同一生产定位函数读取 DB，验证 cursor/primary 的实际位置及 remember 恢复。lastActive 在 hidden profile 只能证明无外部上下文时的 cursor fallback；外部窗口选择另以纯选择/坐标测试覆盖，真实跨屏外部窗口仍待物理验收，不宣称本批完成。
5. 剪贴板仅用独立 profile DB、固定夹具历史和模拟 PasteboardBackend；通过生产 PasteboardRuntime.capture_once 证明保留清理、pin 保留与重置后的新 cutoff，无系统剪贴板读写。保存配置不得立即删除数据，历史正文不写入报告。
6. 运行来源/真实构建收据/owner/自然终态/资源回收保持；回归 R44 主键、R45 启动恢复与既有 settings journey。visible 像素、IME、系统键、整应用性能、跨平台和默认入口迁移仍单列。

## 预算

Main JS 保持 `593891 / 593920 B`；Settings 当前 `786105 B`，有效上限 `786363 B`，绝对 `786432 B`。不提高上限，先收敛受影响模块的实际输出；不删校验、不压掉错误、不改上游 Vue/CSS。所有作者代码模块不超过 500 行，不给旧500行文件继续追加独立职责。
