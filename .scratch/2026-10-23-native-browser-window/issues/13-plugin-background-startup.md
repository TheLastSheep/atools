# 13: Harris原版插件后台登记与会话复用

**What to build:** Harris原包登记后，下次应用启动只预加载已授权、已安装且启用的插件；用户首次进入时复用同一文档和已有Node会话，不重复初始化业务。

**Blocked by:** 12: ZTools旧版进入回调与后台预加载入口。

**Status:** in progress; source-contract verified, original business and native acceptance pending

当前生产接线和分层自动协议已完成独立检查：803项前端、39项定向Rust、类型0错误/0警告、默认构建与预算通过；Core为283通过/3个显式诊断忽略，Rust整库lib仍有失败，不能称全量通过。详情见`output/plugin-background-startup/verification.md`。

本票保持in progress：原构建Paste持久队列启动尚未验收，已列为子项14；原生App/GUI仍暂缓，不因拆票缩减原有验收范围。

- [ ] 将原包auto-start-plugin登记映射到插件自己的启动偏好，不开放任意宿主全局数据库。
- [ ] 登记与执行使用能力注册、权限和TaskRun；拒绝或不可用时不得伪报成功。
- [ ] 只启动当前安装/启用/已授权的项；并发与重入只创建一次，无轮询重试风暴。
- [ ] 完整加载原页面和preload，不合成Feature action；真实进入复用同一文档，解决ready竞态。
- [ ] 保持全局Node上限4，明确后台占用与前台优先策略；退出、禁用、更新、卸载清理资源。
- [ ] 普通隐藏与显式结束区分；以Paste持久贴图队列初始化与Snipaste真实入口做自动协议验收。

GUI/App/AppleScript/原生探针仍按用户要求暂缓；自动协议与真实业务/资源验收分开记录。未完成前不把原包登记成功当作支持后台运行。
