# 04: 测量并减少核心流程 RPC

**What to build:** 在一个已验收的 Harris 核心流程中，以同操作、同输入和同操作次数为基线，减少实测到的重复 RPC、payload 字节或同步等待。

**Blocked by:** 02 或 03 任一票完成即可（OR）：Live Markdown 或 Format Converter 任一完整原包流程提供基线；不要求两票都完成。

**Status:** blocked

- [ ] 冻结所选流程、输入、操作步骤和操作次数，记录优化前 `get` / `call` 往返、请求/响应字节及同步等待；另计 `poll` / `pollPromise` / `release`，不以 TaskRun 数冒充总请求数。
- [ ] 实施后按同一流程复测，并至少降低一个预先指定的 RPC、payload 或阻塞指标。
- [ ] 原包 UI、错误、权限、取消、TaskRun 与持久化行为保持通过；同步 API 不改为 Promise。
- [ ] 不缓存有副作用或读取时变化的 `get`；不新建 benchmark/监控平台；无可复现改善则记录证据并保持现状。
