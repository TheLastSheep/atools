# Task20：受管独立子进程接口冻结

目标仍是 ZTools 全能力对齐、Harris 原包稳定使用；本票解决已实测的 POSIX detached helper 越过 sidecar 回收。不是改写转换引擎，也不因单次合同通过宣称完整插件/平台验收。

## 决策依据与排除

现有红测经真实 LegacyNodeSession 重复证明：Node 已被回收、独立 helper 仍存活。仅 JS 退出 hook 不覆盖 Node SIGKILL；保存数字 PID/PGID 无法保证之后安全识别同一进程；改 detached:false 会改变已确认的原包启动语义。采用 Rust 在创建时持有 Child 和可验证组身份，以修复生命周期；不迁移转换逻辑，不新增常驻 Node/看门狗进程。

本次不承诺 ATools 主进程自身被 SIGKILL 后仍可运行清理代码。该边界需要进程外/OS 监督，不以本票 Node 崩溃测试替代。

## 所有权与接线

- Rust 在随机命名、0700 权限的短临时目录创建两个 AF_UNIX listener，分别接收控制和事件连接。Node 自行建立 socket，不继承人为清除 CLOEXEC 的管理 fd。无 HTTP 端口或新公共能力入口；owner 与同一 session 绑定，继承既有 Node 权限/外层 TaskRun，不新建平行执行管线。
- 环境仅传入 `ATOOLS_MANAGED_CHILD_CONTROL_SOCKET`、`ATOOLS_MANAGED_CHILD_EVENT_SOCKET`、随机 `ATOOLS_MANAGED_CHILD_TOKEN`。Node 安装器在插件加载前捕获并删除全部保留键（包括废弃的 `_FD` 配置）；双路均须发送 `{schemaVersion:1,role,token}`，Rust 完成认证后在控制路发送 ready 帧。关闭时移除 socket 与私有目录。普通 native child 不继承管理 socket 的行为须真实测试，不以源码推断替代。
- Rust launch.start 返回可关闭的 owner：close 幂等、确认所有自己持有的 helper 已终止/reap 后才成功；EOF/Node 崩溃也触发关闭。SidecarProcess 在释放 root permit、返回 strict close 前必须 await 此 owner。失败记录 cleanup error，不能假报空闲预算。
- 首批在 macOS/Linux 启用，其它平台保持现有路径并明确未验。只截获 public Node 异步 `detached:true` 创建；普通同组子进程维持已有路径。已发现的同步 detached/IPC/其它选项覆盖缺口保持待办，不静默放回会逃逸的原始分支。

## Node 接缝

固定产品 Node 22.23.3 的 ChildProcess.prototype.spawn；保留标准模块参数归一化和 ChildProcess 实例，关闭被替代的空 native handle。无需替换原插件文件。未配置宿主 socket 的已有浏览器 fixture 不启用新 owner。安装器有配置时返回握手 Promise，bootstrap 按顺序等待就绪再派发 RPC；无配置保留既有同步派发。

- `pid` 在 spawn 返回前来自 Rust 创建回执，`spawnfile/spawnargs/stdio` 正确；标准 exec/execFile 可继续使用 Node 自己的实现（当前 execFile 不转发 detached，维持原路径）。
- 必须覆盖 Harris 实际 `['ignore','pipe','pipe']` 以及探针 `'ignore'`，并支持缺省三个 pipe。其它 stdio/IPC/serialization/uid-gid 等尚不支持的模式在创建前明确错误；不得为了绿色测试去掉实际必需模式。
- stdin 使用 Writable 与异步写入完成回执；stdout/stderr 使用真实 Buffer 和可背压的流。spawn/error、exit、管道关闭与 close 分开处理，快速完成事件不能丢失给稍后到达的远端监听。
- kill 接受真实信号并同步返回是否接受；process.kill 对本 owner 的正/负 pid 转成 opaque handle 操作，不能把已结束的受管 pid 作为裸数字回退。ref/unref 控制事件通道引用，无闲置轮询。
- 已退出受管 PID 用按需分配的精确 bitmap 记录，固定 512KiB，支持 `0 < pid < 4194304`；活跃映射优先。越界 PID 创建后先清理并明确拒绝，不返回成功回执。child close 必须释放对应通道引用。
- 同步 detached APIs、fork IPC 的未实现模式必须拒绝，不能绕过本票保证；这些是总体兼容目标的未完成项。

## 线协议（schemaVersion=1）

帧为 4 字节大端长度 + UTF-8 JSON，单帧 ≤1MiB。控制请求有递增 `id`，响应 `{id,ok,result}` 或 `{id,ok:false,error:{code,message,errno?}}`。

- spawn：`{id,op:'spawn',file,args,envPairs,cwd?,stdio:[mode,mode,mode]}`；args[0] 为 argv0，envPairs 是 Node 原生 `KEY=VALUE` 字符串数组（首个等号分隔，保留值中其它等号），mode 仅 pipe/ignore。结果 `{childId,pid}`，childId 是规范正十进制字符串（Rust 内部 u64），不透明且只属于当前 owner。全部控制与事件帧保持同一字符串类型。
- kill：`{id,op:'kill',childId,signal,group}`；signal 为经 Node 校验的 OS 整数。只操作保有所有权的同一 Child/组。
- write：`{id,op:'write',childId,writeId,data}`，data 为 base64，单片 ≤64KiB；只回复接收入有界队列，事件 writeAck 才完成 Node Writable callback。
- end：`{id,op:'end',childId,writeId}`，同样以 writeAck 表示实际 stdin shutdown。
- credit：`{id,op:'credit',childId,stream,count}`；各输出初始 2 片，后续每次授予 1..32 片，未消费额度最多 32。stdin 队列 8 片；队列满立即返回 EAGAIN，不等待不存在的 drain，也不暗中重复写入。

事件 `{childId,event,...}`：data(stream,data)、end(stream)、streamError(stream,error)、writeAck(writeId,error?)、exit(code,signal)、close(code,signal)。输出读取失败发送明确 streamError，不伪造成功 EOF；JS 报错并销毁本地流，仍须等真实 exit/close 才释放 ChildProcess 引用。每片输出 ≤16KiB 原始字节，传输队列有界（32），不得将每块输出改成同步 RPC。退出码、OS 信号必须保留；无正整数可用 PID 的启动失败不伪造 spawn 事件，OS spawn errno 在 JS 恢复对应 Node 错误码。

Rust 独立校验尺寸、参数、环境、stdio、handle 和信号。继承精确 Node envPairs，禁止混入宿主 ambient env。每 owner 最多4个同时 helper、进程内全局最多8个；额度必须在真实 cleanup/reap 后释放，错误明确。空闲没有 helper 轮询；活动 helper 可复用现有 WNOWAIT/定向回收模式。

仅已验证 PG 的 SIGKILL EPERM 可以暂存；root reap 后只读观察组消失（有界等待）才确认解决，禁止 reap 后重新发送信号。其它 capture/observe/signal 错误仍严格保留。helper 配额要求 root reap 与组消失双重确认；spawn 后清理未确认的失败除 RPC 响应外必须进入 owner 的持久错误，不能让 close 返回成功。

## 归属

- background_host_finish：新 sidecar/node_children Rust 模块、协议/传输/owner 与有针对性测试；如需 process.rs 的 owned signal 方法也归此 worker。禁止改 supervisor/process_loop/legacy_node 接线及 JS。
- node_close_finish：SidecarProcess 资源接线、root 生命周期/permit/诊断，与 legacy_node/mod.rs 的 launch/脚本接线及必要调用方；不得写新 Rust manager/JS 文件。
- paste_startup_coverage：新的 managed-child CJS 接缝与独立 Node 合同测试；不得改 Rust/原包。与原 bootstrap 调用接线由主 Agent 协调。
- 主 Agent：冻结接口、源代码审查、真实生产红绿、原模块/必要回归、性能与资源记录、最终验收；独立 reviewer 复核关键 diff。

## 验收

保留原 detached 清理红测，必须在同一真实 LegacyNodeSession 路线转绿。另测真实 spawn PID/独立组、stdin/stdout/stderr、失败启动与快速退出、单 child 信号、两个 owner 隔离、close/Node自杀/强杀、预算与额度释放。文件/进程均为固定短时自退出夹具，避免发生故障时留下永久进程。不运行 GUI、AppleScript、OS clipboard、Office 安装或已安装应用。

未通过的模式/平台仍列为缺口；不得将手写 Rust 子进程单测当作完整 Node 或 Harris 原包通过。上位目标不变。
