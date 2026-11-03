# 12: ZTools旧版进入回调与后台预加载入口

**What to build:** 原版ZTools插件的旧onPluginReady按真实进入动作调用；内部后台预加载入口运行页面与preload时，不自动触发用户功能。uTools现有ready行为保留独立，不混用两个来源的语义。

**Blocked by:** None (can start immediately).

**Status:** source-contract verified; background scheduling/native business pending

- [x] 用固定官方源码证明ZTools的旧ready别名及后台加载不派Enter。
- [x] ZTools旧ready与Enter共用注册槽，支持替换、未消费动作缓存、真实重复进入与销毁后静默。
- [x] 仅可信宿主参数可以选择预加载入口；不启动Feature或MainPush，不合成公开生命周期。
- [x] 默认前台、列表/无界面导出、子窗口与MainPush路径通过回归。
- [x] 主Agent独立审查、自动检查与体积预算，原包指纹不变。

本项不实现或宣称自动启动登记、后台调度、常驻会话、前台复用、实机验收；这些由13完成。新入口是兼容层可验证的前置能力，不是已运行的后台宿主。

主Agent独立通过68套/620项前端（0跳过）、6项桥接脚本、类型/默认构建/workspace编译。启动JS432,238字节不变，插件独占按需静态JS775,659（+1,660）；9代码文件最大463行，原包指纹不变。实际生成preload与late HostClipboard路径也有受控协议回归。见[验收记录](../../../output/plugin-entry-lifecycle/verification.md)。
