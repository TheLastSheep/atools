# R30：隐藏原生 Main/Setting 输入验收接口

承接 ticket19；R28输入浏览器和R29状态读取已通过，整体目标仍active。唯一开发工作区 `/Users/harris/Desktop/atools`，分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。上游只读固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。Root派单、独审和实际运行，Luna实施、不派生；不提交推送。

## 隔离与呈现

- 新建独立精确 `settings-input` journey，使用私有临时SQLite、非持久WK数据、自有UUID bundle/root；不能复用generic settings controller的显示/聚焦/辅助窗口步骤。首次入口、Ready、page-load与event handler都走独立路线。
- 增加私有settings呈现policy，只能由Native隔离smoke的已校验profile注入；生产默认仍是现有呈现语义，renderer参数/URL/环境字符串不能开启隐藏policy。该policy在Child创建、open/reopen与input value回声的所有Native focus调用点生效，隐藏profile不show/focus/activate；记录抑制请求，不能把它报告为OS焦点成功。不存在smoke管理态或错误profile时不启用此policy。必要cfg保持default与legacy-only编译。
- macOS增加只读activation事实观察，至少包含appActive、frontmostIsSelf、window visible/focused与focus/activation计数。baseline必须在触发settings前观察为inactive；尽早安装观察器覆盖所有测试呈现动作，每阶段检查。未知字段不当false，观察不足不宣称“从未激活”。不修改系统输入源，不使用CUA/AppleScript，不激活用户窗口。隐藏视图不能运行时保留失败，不转前台重试。

## 真实输入路径

- 通过原Main `openSettings` 入口创建真实Setting Child，再点击原侧栏进入allCommands，不构造第二个演示页面。从真实Native命令目录中动态选非空canonical目标，名称/路径只在内存使用；空目录不能当筛选通过，不生成虚构业务指令替代。
- 在真实Main `.search-input` 用固定DOM InputEvent驱动原Vue→adapter→Rust→Child，观察原目录筛选与清空恢复、Native序列/字节计数。Child公有setSubInputValue反向经过真实Rust回Main；隐藏policy覆盖其Native焦点请求。只记录布尔/计数/UTF-8 byte/opaque identity，不保留输入原文或用户应用名。
- 原侧栏切页必须创建新owner；关闭后无session/Child、layout注册和pending控制/写入归零，旧身份不能写新session，重开session独立且缓冲为空。旧retained Arc缓冲清除已有Rust直接测试；runtime报告若没有显式retained-buffer witness，不能仅凭session消失宣称其内存内容清零。
- 原Main启动getter应经真实 `get_app_update_status` 读到idle/unchecked等真实观察，不触发网络、下载、安装或重启。此观测可补齐ticket20的Native handler运行证据。

## 测试与运行

- orchestration、bounded correlated probe、原DOM JS、报告/门禁按实际职责独立模块，不继续堆入422行General journey或450行main-probe；所有作者文件≤500行。最多一个pending probe、严格caller/session/operation/evidence schema和16KiB证据上限；不得提供任意eval给renderer。
- 先单元验证policy启用条件/默认语义与profile/schema/report门禁；Root审diff、跑相关Native测试和workspace后，冻结完整来源。只由Root正式构建新example和同一次build的receipt，核对binary SHA及递归Native源码闭包；旧R25或仅cargo check的产物不算fresh可执行证明。
- 复用R29 shared provenance helper及actual chunk字节/来源/原预算门禁，运行前后源与dist稳定；旧失败记录保持。Root独占实际Native运行，精确退出并核实进程/profile/bundle/root清理；timeout只重观测同一live handle，不凭超时重启。
- 结果只证明macOS隐藏DOM→真实Tauri/Rust链和本轮观察；可见材质/像素、物理键盘、OS输入法、完整设置写入/迁移与跨平台仍独立验收。
