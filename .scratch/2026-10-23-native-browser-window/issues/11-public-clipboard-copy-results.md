# 11: 原版插件复制API的同步结果

**What to build:** 公开copyText/copyImage/copyFile遵守同步boolean合同；只有受权宿主写入完成才true。原版Harris Snipaste的copiedToSystemClipboard不把Promise误判为成功。原包保持不变。

**Status:** source-contract verified; native/full business pending (in-progress)

- [x] 原版固定小PNG/文字，经生产编译桥复现和复验服务结果。
- [x] 复用现有同步host clipboard、NativeImage转换、FileRead授权、TaskRun/会话回收，不增加Rust API、Node进程、依赖或扩大预算。
- [x] 保留manifest clipboard.write门；需异步授权时只请求授权、返回false、丢弃本次payload，不重放，重试才写入。
- [x] DataURL/Buffer/Uint8Array/本地路径经过现有正规化；保留JPEG/WebP等现有Node转换及其授权/预算限制，不自建PNG-only公开API。
- [x] 主Agent独立回归、类型、构建与体积；真实OS剪贴板和原paster提示仍单列。

原paster复制badge不检查服务结果，文字分支还传plainText而服务读text，属于原包限制。本批不改原包、不声称修复其UI提示。后台自动启动缺口另登记，不以成功stub替代。

主Agent独立通过46套/364项前端、19项相关Rust、6项JS脚本、类型和构建。启动JS432,238/573,440字节；按需插件JS754,121字节（+5,688）。15代码文件最大493行，指纹冻结复核及原包6文件哈希检查通过。见[验收记录](../../../output/plugin-clipboard-copy-result/verification.md)。系统剪贴板、实际sidecar和原UI仍待验，原paster提示问题保留。
