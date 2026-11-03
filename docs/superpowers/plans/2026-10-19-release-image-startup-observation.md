# 发布版图片与 Node 启动观测（B63）

B63 已通过根代理的有界验收：支持选择 debug/release 构建，保留原 debug 调用接口；在指定原生夹具内记录有界 Node 启动 checkpoint，再用同一发布版二进制和同一前端产物分别观测耗时与资源。实现和接入由 Luna 完成，根代理负责复核和实际运行。

## 两次全新进程的实测

两次都使用 B64 已接受的原始 PasteboardPro `ja` 缩略图类、固定 512×512 PNG 和 64 个 revision；两次的原生二进制、压缩 IIFE、CSS、原类和输入图片指纹相同。资源轮复用已验收的编译产物，只重新生成带新临时路径的消费者包，没有再次构建。两轮分别使用全新隔离目录和应用、Node 进程。

| 项目 | 结果与范围 |
| --- | --- |
| 无周期资源采样的耗时轮 | 首条 33 ms，后 63 条 P50 28 ms、P95 61 ms、最大 64 ms，总 await 2463 ms |
| Node 初始化完成 | 耗时轮 66 ms，资源轮 58 ms；仅所记录的解析、spawn、initialize 阶段 |
| 资源轮 | 目标 1000 ms 周期，另有初始、绑定 Node 时和退出后的采样；共 5 个样本，Node 在 3 个样本中被观测 |
| 主进程 + Node RSS 峰值 | 177045504 字节（168.84375 MiB）；是所观测进程 RSS 之和，不是物理内存或整应用内存 |
| CPU 峰值观测 | 46.815789755131235%，以一个核心 100% 计；相邻样本累计 CPU 差值可能漏掉短峰值 |

资源轮不用于主耗时结论。耗时轮没有周期 `ps` 采样，但仍有进程所有权检查；上述数字不是重复统计后的性能认证，也没有覆盖完整应用启动、WebView JPEG 解码、匹配器或整体内存预算。WebContent、XPC 和其他未绑定进程仍未纳入，RSS 相加可能重复计算共享页面。

每轮均为 265 个终态任务，其中图片操作 128 次成功、1 次预期容量拒绝；64 个 JPEG 都可解码为 480×480，缓存命中不重放，第 65 个 handle 按原限制拒绝。两轮授权范围、JPEG 尺寸和字节长度一致，未证明逐张 JPEG payload 精确相等。

两轮 CSP、opaque iframe、隐藏且不聚焦均通过；Pasteboard backend 调用为 0、capture 未启动。图片引擎归零，Node/宿主剪贴板会话归零，transport 停止，精确主进程和已捕获 Node 均退出，临时目录已删除。

## 所有权与权限边界

checkpoint 只允许指定 case、plugin、runtime 和显式夹具 flag，不合成 `--native-ui-input`。固定文件位于报告旁、夹具目录之外，使用 create-new 临时文件和原子 hard-link 发布；内容最多 2048 字节，只含固定身份、owned PID、所选 Node 路径摘要及有序阶段时间。

根代理结合 checkpoint PID、所选路径摘要、已验证的本地 Node 二进制哈希、直接父进程关系和实时 PID/PGID/启动时间/进程标题绑定 Node。路径摘要不是可执行文件内容证明，进程标题也不是内核可执行文件证明；原始启动记录与本次 TaskRun/owner 的关联另由宿主检查。

本批没有全局网络或文件系统隔离证明。现有夹具 Node 工具仍预授权了包括 Network、FileRead、FileWrite 在内的十个 scope；没有系统剪贴板实际调用不等于整个 Node 运行时被操作系统沙箱限制。

## 修正与检查

原 180 秒构建上限不足：首次离线 release 预构建用了 5 分 47 秒，首轮测量也在重编译阶段触发 180 秒上限，应用尚未启动。保留了失败日志和 journal。现在仅编译计划使用 debug 180000 ms、release 600000 ms；实际成功的 release 构建耗时 5 分 03 秒。应用运行、图片工作线程和业务调用的时间预算没有放宽。

- 当前构建 profile/CLI 测试 8 项通过；源码绑定、突变检测和递归模块检查通过。
- 5 项新 checkpoint 测试和 4 项迁出的既有授权/关联测试通过。
- 扩展启动检查首次为 16 项通过、1 项失败：既有生命周期测试的本地回环监听被 sandbox 拒绝。该精确用例在允许回环连接的隔离环境中复验通过；首次失败保留，没有改写成一次全绿的套件结果。
- 普通 workspace 和原生 feature/example 编译通过。1641 个选定源在两轮前后无漂移；清单不是编译器依赖闭包。
- 所有 11 个本批源码路径小于 500 行；没有提交或推送。

## 可复核证据

验收记录：[batch63-root-release-observation-acceptance-v1.json](../../../output/plugin-input-2026-10-19/batch63-root-release-observation-acceptance-v1.json)。归档保存 111 个 payload，共 3684694 字节，包含 before/after、候选、失败与成功日志、两轮 IIFE/CSS/原类/图片、启动 checkpoint、任务统计和资源样本；逐项哈希、字节及原始内容校验通过。原生二进制仅保留哈希，实际为 25307536 字节的 release 文件；耗时轮 journal 的 retention reason 继承了旧的 debug 措辞，以实际 profile、Cargo 参数、路径和二进制指纹为准。

本批是图片消费者和测量能力验收，仍不代表完整 PasteboardPro、ImageToolbox、大部分原插件、安装全流程或物理 UI 体验已经验收。B65 原应用文件导出与 B66 返回搜索快照修复仍在私有候选复核中。
