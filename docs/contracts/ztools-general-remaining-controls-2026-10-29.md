# 原General剩余主程序接线

当前工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`；上游固定9b15fb1a2a9f3ec886016632761c7bb21e39557a。R45启动恢复和R46位置/保留期限已完成各自hidden切片。本表保持完整目标，不把隐藏原生验收当成完整可见UI通过。R46证据见 `output/renderer-general-policies-2026-10-29/verification.md/json`。

| 用户能力 | 当前确认缺口 | 后续完整验收 |
| --- | --- | --- |
| 窗口呼出位置 | R46原四项保存/重开及生产hidden定位已验；修复逻辑先floor的2倍屏偏差，非居中remember恢复通过；mac仅前台呼出有界采外部窗口 | 外部活动窗口真实跨屏选择、混合DPI/可见呼出、Windows/Linux（当前cursor fallback）仍未验 |
| 剪贴板保留天数与重置 | R46原控件30→1→180保存/重开及生产capture清理私有夹具已验，pin保留；默认180/明确90保留，重置不删除历史；无重复IPC | 系统剪贴板真实输入和完整可见UI另验；本批零系统剪贴板访问 |
| 开机启动 | R49现代SMAppService及R51原Vue/Svelte共享OS状态的hidden切片已验；R59/R60已接旧项持久日志、恢复、明确迁移选择和生产入口 | ticket38仍缺真实旧LaunchAgent迁移和下次登录验收；旧mac/Windows/Linux、可见/物理交互也未验。不重复实现已有恢复/接线，不碰用户已有启动项作测试 |
| 自动返回搜索 | R47原General保存/重开、同session所有指令输入后真实隐藏30s/立即返回、搜索态清空和资源回收已验；单次timer/return有界管理，配置下次hide采样 | 真实可见show取消、物理输入/IME、其余延迟长时等待与跨平台仍开放；默认Svelte旧面板计时不能充当Vue证明 |
| 自动带入复制内容 | R63五值Core/Child保存确认与原Main即时更新已接通，真实SQLite、原浏览器消费者及启动早到关闭通知RED→GREEN通过 | 原General控件→Native提交→Main真实focus的一次完整运行、general剪贴板、可见/物理与跨平台仍开放；见[R63](../../output/renderer-auto-paste-2026-10-29/verification.md) |
| 插件默认高度及重置 | R75/ticket47已接原控件保存/重置确认及owned Settings内容高度消费；区分缺失542/显式541、头58，保留requested缓存和父窗裁剪；Svelte无关保存不覆盖较大原始高度。自动检查与独立复核通过 | ticket48下一步优先实际隔离Native几何/缓存/持久读取/关闭回收；本批无App运行，可见像素、物理输入/DPI切屏与跨平台未验；第三方插件消费仍随插件阶段。见[R75结果](../../output/renderer-settings-height-r75-2026-11-02/verification.md) |
| 完整主快捷键 | R44普通组合键与R45启动恢复之外，R71/ticket44已接通Option/Alt+Space录制；R73/ticket45已实现macOS按需双击监听、统一事务/恢复、350ms blur保护及精确权限/平台拒绝，自动检查和独立复核通过 | ticket44真实系统录制、连续两次与主键恢复未验；ticket45没有创建真实tap或发出OS按键，前后台、权限变化、sleep/wake、Command-Tab/Secure Input、跨平台继续开放。不能把模型或DOM事件当系统按键证明；见[R73结果](../../output/renderer-double-modifier-r73-2026-11-02/verification.md) |
| 关闭插件快捷键与窗口关闭 | R74/ticket46已接原closePlugin控件、三布尔投影、Child单键/Core合法集合保存；macOS双Close三角色投影、原生实例归属、设置事务和统一Settings正常完成100ms保护已实现，定向/双配置编译及Terra/Astra复核通过 | macOS实际菜单/CmdW/红按钮/CmdQ、前后台和原HotkeyInput真实输入未验；Windows/Linux对应后端未实现。默认Svelte不切，见[R74结果](../../output/renderer-close-shortcut-r74-2026-11-02/verification.md) |

原General没有alwaysOnTop或autoHide控件；自动返回搜索不等同自动隐藏。主程序默认入口仍保留Svelte，当前是明确的迁移回退；原Vue整体验收前不直接切默认配置或发布工作流。完整可见像素/材质验收继续沿已有ticket26，不因隐藏Native成功而关闭。

性能约束继续实测：Main JS与Settings全资源分别受独立固定政策约束；开启新能力前核对剩余空间、调用次数、进程与退出。没有实测瓶颈时不换Node/SQLite、不扩插件任务；Harris原包仍是后续插件优先。

R47资源收敛并接入自动返回后，Main593564/593920B（余356，较R46少327），Settings786182/有效786363B（余181，较R46少154），绝对786432B（余250）；未抬预算、删错误校验或改原Vue/CSS。下一批先沿ticket26推进可见主程序与show取消验收，再继续开机启动等剩余控件；证据 `output/renderer-auto-back-search-2026-10-29/verification.md/json`。

R48当前会话返回锁屏标记，正常foreground也激活失败；QA初次失败提前结束、正式门禁保持失败，没有可见验收通过。资源与预算保持上述R47值。会话可交互后继续ticket26/36；等待期间下一独立实现按 `.scratch/original-main-native/issues/37-general-launch-at-login.md` 收敛开机启动OS注册/读取及原Child写通路，不反复盲跑可见窗口。R48证据 `output/renderer-visible-main-2026-10-29/verification.md/json`。

R49最终hidden现代登录项链路已通过，见 `output/renderer-launch-at-login-2026-10-29/verification.md/json`。Settings资源788644B，Main593564B不变；正式测量与有限去重后明确追加Settings预算4KiB，有效790459B/绝对790528B，历史政策/失败记录保留，理由见 `docs/contracts/ztools-launch-at-login-budget-2026-10-29.md`。此为原控件的系统操作验收，不关闭可见UI或完整目标；下一必要兼容项为ticket38旧启动项及跨入口状态。
