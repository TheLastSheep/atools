# R65 原版本地启动项资源预算冻结

状态：Main 与 Settings 正式构建及 Root 预算来源测试已通过。Main 日志为 `output/renderer-main-frontier-r65-2026-10-29/main-build-final-accepted.log`，本文只记录静态资源预算，不替代发行性能验收。

Main 与 Settings 使用不同的资源度量，预算分别管理：

| 域 | 里程碑 | 基线 | 最大增量 | 绝对上限 | 本轮测量 | 实际增量 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Main JavaScript | `original-vue-local-launch-main-2026-10-29` | 598,996 B | 5,120 B | 604,116 B | 603,273 B | 4,277 B |
| Settings emitted resources | 现行设置预算 | 790,457 B | 4,096 B | 794,553 B | 794,055 B | 3,598 B |

## Main 决策

R65 Main 基线为 598,996 B。完整本地启动项闭环本轮预算增量为 5,120 B，绝对上限为 604,116 B。现有测量 603,273 B，比基线增加 4,277 B，在本轮上限内余 843 B。

本轮增长覆盖完整本地启动项接入、启动早期事件竞态修复、两处带 SHA-256 锁定的上游逻辑修正，以及 App-first direct launch。各项没有独立拆分测量，因此不对单项成本作归因。

旧的 R65 local-shortcuts 里程碑 `original-vue-local-shortcuts-2026-10-29` 保持冻结：基线 598,996 B、增量上限 4,096 B、绝对上限 603,092 B。历史日志继续表示旧门槛下的失败：

- `output/renderer-main-frontier-r65-2026-10-29/main-build-final.log` 记录 603,190 B，高于旧上限 98 B。
- `output/renderer-main-frontier-r65-2026-10-29/main-build-integrated.log` 记录 603,273 B，高于旧上限 181 B。

阈值更新是对完整本地启动项闭环的单独预算决策，不把这些旧门槛失败改判为通过。更新后的 Main manifest 使用新里程碑；Root 已在新预算下正式构建，并独立校验当前38份Main源文件、上游输入、两个补丁描述符与产物一致。

## Settings 与度量边界

Settings 沿用本批先前已冻结的 4 KiB 增量预算：基线 790,457 B，最大增量 4,096 B，绝对上限 794,553 B。`output/renderer-main-frontier-r65-2026-10-29/settings-build-accepted.log` 记录 794,055 B emitted resources，增加 3,598 B，低于上限 498 B。旧 R64 上限 790,459 B 下的失败保留在 `settings-build-old-budget.log`；本次 Main 从 4 KiB 修订到 5 KiB 时不再调整 Settings。

两域增量的算术和为 7,875 B（4,277 + 3,598），分别对应 Main JavaScript 与 Settings emitted resources 两种度量，不能作为整应用包体增量。

本轮没有 CPU、RSS、冷启动/唤起、IPC 延迟或整应用包体数据，不据此作性能结论。

## 验证边界

provenance 验证器保留历史里程碑，并分别冻结本轮 Main 的 604,116 B 上限和 Settings 既有的 794,553 B 上限。Node 定向测试验证 Main 实际测量、精确边界以及多出 1 B 的拒绝；Settings 的现有预算测试一并回归。
