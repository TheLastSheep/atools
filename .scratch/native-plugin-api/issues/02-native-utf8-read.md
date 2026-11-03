# 02: 小型 UTF-8 文件通过现有授权通路交给 Rust

**What to build:** 原插件调用同步 UTF-8 读取时，已覆盖的普通文件由 Rust 有界读取，减少远端属性与函数往返；未覆盖签名继续现有 Node 回退。

**Blocked by:** None (can start immediately).

**Status:** done

- [x] 复用现有 Legacy Node 广泛授权、document 生命周期与 TaskRun，不宣称最小权限或零 Node。
- [x] 512 KiB 字节、1 MiB 传输、2 个 blocking worker 与 5 秒截止；权限/IO错误不转成回退。
- [x] 未覆盖的 stat、写入或 Buffer 路线继续真实 Node，不伪装完整 fs API。
- [x] 覆盖 UTF-8 替换、BOM、原始异常、未覆盖路径和会话撤销。

主 agent 执行 Rust 文件测试18项及真实 Node 会话/授权上下文测试3项；前端 bridge/facade/生产序列化测试通过。真实 WebView loopback 完整往返及编辑器 UI 尚未验收。

