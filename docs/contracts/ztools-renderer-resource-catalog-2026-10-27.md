# R21 兼容目录与构建产物预算收敛

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`。R20已完成实现和定向检查，但正式JS587111超过有效预算583字节；dist已恢复R19的586470字节，不能借旧产物验收新source。本轮先收敛此缺口，原目标和UI/插件范围不缩减。

## 固定约束

- 上游ZTools commit `9b15fb1a2a9f3ec886016632761c7bb21e39557a`仍只读；原Vue/CSS、依赖、压缩策略、Node/SQLite路线不改。
- Main固定基线570144、增量16384、绝对589824，有效586528。预算不提高，不删校验、错误或诊断以取得通过。
- 已保存44输入preimage、真实适配器81个自有键/30方法/53事件与notes的基线；输出在 `output/renderer-resource-catalog-2026-10-27/`。元数据键序不作合同；键集合、状态/notes、get/has/descriptor与全新副本、订阅参数/错误/生命周期保持。

## 两项实施

1. 兼容目录：集中实际重复的settings callback名称、宿主入口和capability描述；hostAdapter保留执行与生命周期，目录负责稳定名称/availability。不引入通用缓存，不将General写入/CAS或错误处理强行泛化。
2. 受控构建发布：先在私有同文件系统stage里构建，完整预算、源/依赖稳定性、输出扫描与provenance均通过才发布固定dist。发布前失败清理自己stage，旧dist逐文件不变；发布rename失败需安全回滚并保留无法回滚的旧备份，不能覆盖他人锁或目标。并发构建应明确拒绝或互斥，不猜测清理遗留所有权。发布已经完成而释放锁失败时需报告已发布状态和保留位置，不能将其冒充回滚；构建锁协调使用本builder的进程，不承诺防住同用户恶意改写任意文件系统路径。

## 验收

Root复核关键diff、对比真实Interface基线、完整renderer相关Vitest/strict、原有Node回归与正式Vite预算；构建输出helper用真实私有目录验证成功、失败、锁和回滚。另执行一次真实CLI负向预算构建，证明失败exit1、dist与manifest恢复和临时stage/锁回收；同轮正向正式构建必须使用未变原预算。新构建helper需纳入浏览器/Native来源闭包。

当前只读会话仍locked，原解锁询问未收到回复；不重复foreground验收。可分析后台真实Tauri事件链的独立可行性，但后台DOM不等同可见窗口、材质、物理输入或焦点验收。完整目标保持active，插件扩展后置并优先Harris，无staging/commit/push。

## 本地切片验收结果

Root真实Interface对比、Main19文件142项/strict、Node45项（含输出事务15项）、最终正向CLI及两次负向预算CLI、workspace检查通过。正式JS586524，减少587、余4，预算/manifest未提高；当前source与dist一致，Native1080输入和两个fresh可执行文件已绑定。两个独立review指出的条件性并发问题已修复，Root在最终源码实际复跑。

headless原版Vue四组主题计算样式、搜索/键盘、历史/固定、真实CDP拖拽及两种焦点返回通过，六类精确通知各1共享listener、dispose逐key归零；14检查/6截图，source/package/dist摘要稳定，临时进程/profile回收。此为严格合成端口的浏览器证据，不能证明真实Rust TaskRun、Tauri/OS焦点或系统图标。ticket11完成本地资源切片；ticket10和整个还原目标继续进行。完整证据 `output/renderer-resource-catalog-2026-10-27/verification.md/json`。
