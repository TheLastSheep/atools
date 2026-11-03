# 设置体验与原版插件验收进展

本批为持续开发增量，长期目标仍在进行中：缩小与 ZTools/uTools 的界面及交互差距、让大部分原版插件直接可用，并满足性能预算。尚未建立多数插件可用率，也未完成竞品同机比较。

## 用户可见改动

设置页保留一个品牌图标和一个标题，明确提供“返回搜索”，收紧顶部与筛选区。插件总数融入列表标题，已启用数作为次要信息。普通目录读取成功改为不占布局的辅助播报；进行中、警告、错误和重试保持可见。任何目录读取失败都会锁住变更与打开动作，成功重试后恢复。现有筛选、30 行分页、市场往返状态、拖动区域和更多菜单保留。

实际浏览器覆盖 800/420 宽度与浅深色、详情、打开失败、授权后读取失败及恢复，共 8 张截图。1200 条合成目录最多渲染 30 行，没有横向溢出。截图已人工核对。这证明本批布局与流程，不代表与竞品视觉一致。

[浏览器记录](/Users/harris/Desktop/atools/output/plugin-inventory-2026-10-16/6647ffed-e8cd-47a8-92e4-90da07332b99/report.json)；[桌面截图](/Users/harris/Desktop/atools/output/plugin-inventory-2026-10-16/6647ffed-e8cd-47a8-92e4-90da07332b99/list-800-light.png)；[窄窗口截图](/Users/harris/Desktop/atools/output/plugin-inventory-2026-10-16/6647ffed-e8cd-47a8-92e4-90da07332b99/list-420-light.png)。

## 原版插件的实际状态

| 范围 | 已证明 | 待完成 |
| --- | --- | --- |
| 子网计算器完整原目录 | 真实桌面宿主 39 项检查通过；/24、/31、/32、30 主机逆算、两类错误及恢复；无 Node、数据或路径权限 | 物理键鼠、剪贴板、全部地址边界、视觉比较 |
| 纯文本编辑器完整原目录 | 导入、权限流程、原版页面就绪及前台可见通过；已准备双文稿、SQLite 只读投影、重开恢复用例 | 两轮真实编辑入口失败；未执行编辑命令，自动保存、Markdown 与完整关闭恢复未验收 |
| JSON 编辑器完整原目录 | 独立系统输入模式及严格证据检查已实现、复核；此前 Worker 协议证据单独保留 | 本轮停在可见性前置检查，未进入输入步骤；真实输入、格式化、诊断恢复仍未通过 |
| 原版番茄菜单调用链 | 两次独立桌面运行，各 24 项检查及 9 项隔离探针通过；原版子 preload、点击、回传、父处理及关闭 | 完整番茄插件、查询参数配置、独立原生浮窗 |

两份新目录保持完整原字节：纯文本 7 文件/2 目录，子网 4 文件。统一入口现在注册 14 个原版案例：9 份完整目录、1 份原始 ZPX、4 份发布包。注册数量不等于通过数量，更不等于完整插件验收数量。

当前参考生态有 180 个顶层插件目录，169 个顶层 plugin.json；包含 public/dist 等位置后，180 个目录均存在 manifest，共 264 份 manifest。264 不是插件数量。历史静态资源就绪分类也不能作为直接可用率。

[子网桌面记录](/Users/harris/Desktop/atools/output/legacy-node-2026-10-17/original-subnet-native-batch30-v1.json)；[纯文本首次失败](/Users/harris/Desktop/atools/output/legacy-node-2026-10-17/original-plain-text-native-batch30-v1.json)；[纯文本诊断复验](/Users/harris/Desktop/atools/output/legacy-node-2026-10-17/original-plain-text-native-batch30-v2.json)；[JSON 系统输入前置失败](/Users/harris/Desktop/atools/output/legacy-node-2026-10-17/original-json-editor-native-ui-batch30-v1.json)。

## 编辑器焦点与菜单证据

纯文本第二轮记录了现有那一次聚焦前后的只读状态：host 与 frame 均 visible、hasFocus 为真；宿主 activeElement 是当前 iframe，无权限或模态弹窗；原版 contenteditable 节点已连接、属于当前文档且尺寸有效，但聚焦前后内部 activeElement 均为 body。编辑命令数为零，没有重放焦点或输入，没有模型、React 或存储注入。失败状态回读前先保存原 operation/error。原版节点 tabindex=-1 是观测值，尚未证明它是原因。

只读源码追踪没有确认宿主持续抢焦点：主搜索在插件打开时卸载，iframe 焦点交接是有限生命周期动作，原版 CodeMirror 的 focus/blur 处理未见同步强制失焦。不能据此宣称生产焦点代码没有问题；下一步需区分 WebKit 编辑焦点策略和实际系统点击行为。

JSON 的失败发生于 2026-10-17 UTC：应用活跃、前台且 nativeFocused，但 macOS 报告窗口 occlusion 不可见，host/frame hidden。用户明确屏幕亮着，因此不归因于锁屏。桌面控制工具之后返回临时应用不存在；当时该应用已经失败退出并清理，不能将工具错误当作插件输入结果。较晚纯文本可见的运行是另一时刻，不能覆盖 JSON 那次状态。本批没有使用 AppleScript，既有四步目录/保存授权未扩大。

菜单受控复现证明了旧验收存在误报路径：原版点击通过另一消息通道触发父处理并关闭子窗口，可能早于 executeJavaScript 点击 RPC 回包。新验收先注册一次性固定触发监听并收到 ACK，再经公开 IPC 触发原版 onclick，严格等候唯一 toggle(false)、原句柄清空及实际销毁。没有忽略 RPC 错误或自动重放。最终诊断过滤同时保留新的 arm/trigger 固定阶段，拒绝任意正文。历史 native v2 单次失败根因仍未知。

[菜单复验 v5](/Users/harris/Desktop/atools/output/legacy-node-2026-10-17/native-browser-window-hosted-ipc-v5.json)；[菜单复验 v6](/Users/harris/Desktop/atools/output/legacy-node-2026-10-17/native-browser-window-hosted-ipc-v6.json)。所有原版运行（含失败）均保留最终 TaskRun 终态、完整资源释放、原字节稳定及临时目录清理证据。

## 性能与验证

- 默认生产首屏静态脚本图 319850 字节，比上批增加 17 字节，低于 573440 字节预算；插件面板继续延迟加载。生产源码/配置前后稳定，临时构建已删除。
- 1200 功能串行匹配保留全部 20 个样本，最慢 1.751583 ms，低于每次 25 ms 预算；不含索引构建、进程冷启动、IPC 或 DOM。
- 五个独立前台临时进程：100 个热搜索样本 P95 37 ms，10 次返回焦点恢复 P95 27 ms，5 次 iframe Escape probe 恢复 P95 27 ms。窗口可见与原生焦点证据通过；输入仍为夹具 DOM 操作，不是物理键鼠。1200 条合成 metadata 加两个原版 typed matches 不代表 1200 个原版插件兼容。
- 自有进程组 RSS 最大 156942336 字节，包含边界由精确启动身份及独占进程组定义；未归属 WebKit/XPC 不计入，也不是整应用物理内存。原生测量的 thresholds 为 null，仅作本场景描述数据，不能宣称正式性能预算或竞品比较通过。
- 两次菜单各 20 个串行公开 sendTo 往返，P95/最大均 1 ms，保留零毫秒原样本。帧 visible 不证明物理输入、绘制完成或独立原生浮窗延迟。
- 最终前端 128 文件/1173 项通过，类型零错误/零警告。Rust core 183、plugin 118、shim 21；带 legacy-node-smoke 的宿主 488 项通过、1 项既有忽略；离线工作区编译通过。定向原版用例、诊断、UI 与独立复核记录全部保留。

首轮完整前端有 8 项旧标题定位失败；一次修订误写成“插件”仍失败，最终严格定位“已安装插件 1”。业务安装/授权断言未放宽。首轮宿主 46 项因本机监听端口被沙箱拒绝；取得本机回环执行能力后，原离线套件全部通过。测试准备阶段还保留纯文本投影外键 scaffold 修正。这些历史失败不计为验收通过。

[首屏预算](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/batch30-bundle-budget-v1.json)；[匹配预算](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/batch30-matcher-budget-v1.json)；[前台桌面样本](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/batch30-native-performance-foreground-v1.json)。

## 交付边界与下一步

本批 55 个新增/变更的自有源文件最大 431 行；31 个既有文件均保留与上批精确匹配的完整修改前字节。新增 Toolbar、Feedback、反馈类型、独立 case/数据投影/输入观测模块承担明确职责，没有向既有大型 PluginPanel 追加业务。55 不包含只读加入证据范围的 11 个原版文件。最终选定输入共 1169 个，范围是显式源集合，不是完整编译依赖闭包。

下一步优先解决原版编辑器真实焦点/输入，再扩大按能力分组的原版业务验收；同时补竞品同机交互比较、常规应用启动/空闲与完整进程资源归属。子窗口 Node 入口识别、查询参数、nativeImage/图片剪贴板与独立浮窗仍是既有缺口。

未暂存、提交、推送；保留既有脏工作区。[本批总回执](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/batch30-delivery-v1.json) 记录源指纹、独立审查、失败、备份映射和证据归档。
