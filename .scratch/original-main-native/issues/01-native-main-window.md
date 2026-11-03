# 01: 原版主界面的真实窗口往返验收

**What to build:** 在独立临时应用中运行原版主界面，使用真实宿主命令和生产窗口生命周期完成显示、隐藏、再次显示与失焦返回，验证输入偏好和退出回收。

**Blocked by:** None (can start immediately).

**Status:** verified (isolated macOS main-window lifecycle; full application acceptance remains open)

- [x] 临时数据目录、独立应用身份和非持久化WebView，不读写用户ATools数据，不启系统剪贴板采集、托盘、热键或MCP服务。
- [x] 原版Vue使用真实Tauri IPC；同轮记录native可见/焦点与实际DOM状态，不能用模拟focus或show成功代替。
- [x] 立即清空与保留全选两种偏好完成hide/reshow、自己辅助窗口引起的真实blur/return。
- [x] adapter退出后三个监听及待处理资源清完；临时应用进程真正结束后才删除自有目录和应用副本。
- [x] 生产普通启动仍使用相同命令注册、窗口事件和桌面服务；没有新增常驻Node或包依赖。

证据：`output/renderer-native-2026-10-27/verification.md`；正向 `run-473f399b-e0f4-464b-88b8-55186ae17642/report.json`；负向退出 `run-e46395f9-6a6f-4d01-881a-193a2941a68e/expected-failure-proof.json`。两个正向case各九阶段；负向同样走完九阶段但报告失败、进程exit1，不能计为第三个正向case。输入使用DOM setter，不代表物理键盘；fixture省略普通启动服务，不代表完整普通启动。设置同窗入口、真实系统菜单与应用启动另票验收。

