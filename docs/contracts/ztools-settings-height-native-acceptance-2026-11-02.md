# R76 设置高度隔离Native验收

工作区 `/Users/harris/Desktop/atools`；开发分支 `codex/atools-ztools-parity`；固定上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。承接ticket47/R75实现，优先取得真实窗口几何证据；完整可见UI、系统输入与跨平台目标不缩减。

## 运行范围

新增独立settings-height闭集profile/journey，复用自有私有root/DB/bundle、source与fresh binary receipt、HiddenSmokePolicy和终态清理。普通生产启动、既有旅程与R75高度策略不改；必要presentation接线仅在legacy-node-smoke及完整profile/owner验证后安装，未授权profile拒绝。

本profile不注册全局快捷键、不建托盘、不操作login-item/系统剪贴板、不启旧launch probes、Node插件或额外公共服务。只走本隔离实例的生产Settings open/General patch/close、真实几何读取和有界自退出，不提供任意脚本、任意路径或通用GUI控制。源码和runner先验证/冻结/独立复核，Root消费证据后运行fresh候选，不调用CUA或扩用旧AppleScript/OS输入授权。

## 四个闭集新进程案例

| case | 初始原始General | 初次内容高 | 本次保存 | 保存后及同bundle重开 |
| --- | --- | ---: | ---: | ---: |
| a | 缺windowDefaultHeight | 542 | 200.5 | 542 |
| b | a终态SQLite数据 | 200.5 | 重置541 | 200.5 |
| c | b终态SQLite数据 | 541 | 2001 | 541 |
| d | c终态SQLite数据 | 2001 | 不改高度 | 2001 |

每次是实际新进程/新runtime；不能以清内存缓存冒充重启。若独立root之间用DB副本，必须在上个进程终态后保存SQLite完整性、General原始字节/未知字段和数据链证明，再创建下个实例；明确这不是复用同一路径。缺失542/总600、显式541/总599分别验证，浮点和较大值实际进入Native创建/布局。

## 事实与判定

- Native从真实Window/Webview接口读parent inner/outer、Child position/size、scale、工作区，记录当前session/registration/bundle身份；expected/模型结果与actual分开，不用requested值或API成功填充actual。
- 当前闭集仅有一个owned Settings Child；注册身份采用single-owned-child lifecycle组合事实：实际child label/url/parent、session/bundle、session持lease且active registration count1，关闭后全部缺席/count0，重开换新session/child。numeric registration ID未采集，不能伪称已读取；若源码允许其它owner混入，本组合不得通过。此为当前双feature普通Window承载的证据，不代表旧R58受限NSPanel原型或完整Mac非激活面板已验收。
- 父窗按desired+58受工作区/frame限制；Child实际物理bounds应对应requested逻辑内容高度。允许有依据的平台像素取整，不能放宽到任意可见高度。读数中若scale/registration已改变，要明确重取或拒绝不一致样本，不混合两个时点伪造一致。
- R76实际小数案例补充：锁定macOS Wry 0.55.1在创建/重排Child时把物理bounds转为整数逻辑单位。令原始`desired=d`、倍率`s`，先`p=round(d*s)`，宿主可表示内容高度为`q=round(p/s)`，Child目标物理高为`round(q*s)`；父窗使用`q+58`再按既有工作区/frame限制。生产创建、重排与父窗必须共用此换算，DB及请求缓存仍保留原始d。其它平台维持原路径且未由本次macOS验收覆盖。200.5@2应明确请求并精确读回Child402、未裁剪parent518；缺失542/显式541仍分别为总600/599，不采用±1范围。
- 上述是明确的可表示尺寸布局策略，不把先前parent517请求读回518解释为已确诊的AppKit取整；两个失败B进程、原始输入日志及其未完成阶段继续保留为失败。新策略须重新构建、从A开始完成四个真实进程，不能重判旧B为完整通过。来源见`output/renderer-settings-height-native-r76-2026-11-02/fractional-geometry-diagnosis.md`。
- 保存后检查当前尺寸未立即改变、DB实际值已提交，关闭后新session/registration重开仍保留同bundle请求；下一实际新进程再使用持久值。cache来源标签只作预期描述，行为和数据链才是验收事实。
- 关闭后确认Child/layout/current session/pending写和请求的已知所有权归零，Main回搜索；记录hidden/unfocused及未激活观测，不声称全时段桌面可见性或框架全进程枚举。
- Native自身时钟包含setup，work/cleanup/report总期限175秒；runner外部观察沿既有180秒边界。缺报告、stage未完、超时、源漂移、非零退出或实例终态不明均失败，不能把deadline exit0当功能通过。异常或身份不明时保留证据/资源，清理仅验证owner与终态后的本次路径。

## 验证与资源

Native先跑准确profile/journey/几何报告与身份反例；runner先覆盖owner/source/超时/缺报告/数据链/尺寸错误/清理拒绝。保留失败，使用不可变after/diff/hash供非实施者复核；跨profile启动边界交Astra限定审查，普通runner交Terra。

保持既有Main604522B与Settings803857B正式产物，预算分别606381/804189B；不为此重建前端。Native-only QA代码不得新增默认生产进程、timer或监听；fixture自身watchdog是测试生命周期。单一Cargo lane locked/offline/j2，产品Node22.23.3；不repurpose HOME/CODEX_HOME，不暂存/提交/推送。

所有作者文件不超过500行；复用有真实职责的公共helper，不完整复制无关launch-return旅程。报告位于`output/renderer-settings-height-native-r76-2026-11-02/`，并更新ticket48、ticket47/General剩余验收状态。实际运行失败若暴露产品问题，应修复并保留反例，不能把验证器改宽来通过。
