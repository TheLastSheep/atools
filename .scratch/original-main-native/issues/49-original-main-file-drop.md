# 49：原主搜索框拖入文件与目录

**What to build:** 将文件或目录拖入原版主搜索框，显示原高亮及文件标签，成功后清空查询；失效项、错误与迟到结果保留用户已有输入，离开搜索或关闭后不再接收旧输入。

**Blocked by:** None (can start immediately). 复用已有原 Main、宿主事件和 Settings 原生拖放接线模式；主程序优先，插件后置。

**Status:** scoped implementation verified / physical pending — R77 原组件与headless浏览器范围已独立通过；隐藏Native注入合同范围已获[Terra终验PASS](../../../output/renderer-main-file-drop-r77-2026-11-02/native/reviewer-final.md)。真实OS/完整UI入口仍开放，不能关闭完整goal。

- [x] 原生 Main 事件按OS来源、Main与搜索框区域授权，不开放任意路径 stat 或读文件内容，不冒用 Settings/插件通道；物理交付另验。
- [x] 原高亮、文件/目录标签及成功清空 query；空、错误与取消保留用户已有输入，DOM/native 不重复。
- [x] 单 owned 目标、有限批次/元数据工作，后一次 Drop、切视图、隐藏、导航、卸载与退出正确失效并回收；范围为定向回归及隐藏注入。
- [x] 原模板/CSS保持，来源绑定、资源预算、定向测试、原组件浏览器10checks/两次真实Settings/最终dispose及独立复核通过。
- [x] 隔离 Native 的生产处理函数到原 SearchBox/App 及上下文真实链实际通过，Rust注入与OS输入明确区分；Terra终验限定hidden injected合同范围PASS。
- [ ] 真实 OS 拖放、可见 UI、物理输入、跨屏/其它平台与默认入口推广分别取得证据；不得据隐藏流程关闭完整目标。

结果、正式来源、旧失败与未验范围见[R77验收记录](../../../output/renderer-main-file-drop-r77-2026-11-02/verification.md)。Main609908/cap610666（旧cap失败及批准6144增量保留）；Settings803857/cap804189保持。范围、接口与证据边界以本轮本地合同为准。不提交、不推送、不发布外部 Claim。
