# 原版 Main 自动带入复制内容设置

状态：R63生产接线及分层验收通过，完整Native GUI/焦点与可见验收开放。工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`；只读上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。主程序优先，社区插件后置。

## 用户行为与已确认缺口

原 General 的“自动粘贴”有 `off / 1s / 3s / 5s / 10s`；默认3秒。保存后原 Main 应即时更新策略，下次搜索获得焦点时按原版规则调用当前剪贴板 getter：关闭不读，正数以毫秒限制复制年龄，过期不覆盖现有匹配内容。手动 paste 不受自动带入关闭影响。原版插件视图中的焦点回调不自动带入。

R62已打通 getter 的真实私有命名剪贴板链路，但该设置仍不可写：Settings Child 和 Core 的可写字段表缺 `autoPaste`，内部 `updateAutoPaste` 及 Main 通知未接通。旧 Svelte 的轮询/空查询语义不替代原 Vue 行为。

## 接口与职责

- 在既有有序 General 字段表末尾追加 `autoPaste`，原20项索引保持；Core严格接受五个字符串，CAS、64KiB记录限制、其它字段与未知配置保留。非法值拒绝且不写入。
- Settings Child 复用既有串行 General 写入、revision、确认回执和错误恢复。原 `saveSettings()` 后的 `internal.updateAutoPaste(value)` 仅确认刚保存的相同字段，不重复写入或发送另一条配置 IPC；缺确认、不同值、过期/关闭会话仍拒绝。
- Main 复用同一 `atools://renderer-general-settings` 监听和类型化 schema，激活 `onUpdateAutoPaste`，将有效值交给上游原 App.vue/windowStore。非法事件整体拒绝，dispose 后不交付，不增监听/进程或轮询。
- 原 Vue 模板、CSS和固定上游不改。保持 Main JS≤593920B，Settings沿用既有资源/增量预算；必要时在本轮所属共享 schema 内等价去重，不能删校验/错误或上调预算凑通过。

## 验收

1. Core 对所有五值的写入、CAS冲突、非法值、SQLite重开与未知配置保留有实际证据；Native Child gate/投影/ready可写字段和原Main窄写权限分别确认。
2. 原 Settings bridge 的真实保存序列只发送一次patch，确认API不另发配置IPC；失败/错误回执/无确认/值不匹配拒绝，旧readonly项仍不可写。
3. 原 Main listener 的有效/非法/迟到通知和取消订阅覆盖；以固定上游实际 App.vue/windowStore 消费者证明 `off→3s→off`、五值毫秒映射、过期不覆盖及手动paste仍可用，不能仅检查事件目录。
4. 严格类型、相关前端/Rust测试、正式Main/Settings构建及资源审计通过。来源及未验部分明确记录；不重复无关全库或未变化的R62 Native场景。
5. 当前登录会话在2026-10-29T17:24:46.916Z明确锁定。本批可先验证生产接线、原版浏览器消费者及真实SQLite；未完成的Native焦点自动带入、可见/物理输入和general剪贴板不能记为通过。不操作用户真实剪贴板。

## R63结果

Core28、Native边界21+2、前端379/45、严格类型/正式构建与workspace通过。额外真实复现并修复原Main等待目录时的早到autoPaste通知丢失；只缓存完整校验后的最新primitive，向新订阅者回放并在dispose清理，单监听与各64cap保持。最终browser `0d0f9046-1123-450c-9248-53bee14ebd92` 20检查/13PNG，RED/GREEN及来源/清理均有记录。Main593911B、Settings790457B，阈值未抬。见 [R63验收](../../output/renderer-auto-paste-2026-10-29/verification.md)。没有新Native GUI或收据，票41继续in-progress。
