# ATools macOS Smoke Checklist

本文档用于 macOS 首版回归。只记录当前仓库真实可验证能力；未实现能力必须标记为限制，不能当作通过项。

## 1. 环境准备

```bash
cd /Users/harris/Desktop/atools
pnpm install
```

基础校验：

```bash
pnpm check
pnpm build
pnpm test
pnpm test:browser
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm release:check:macos:unsigned
```

当前已知警告：

- `pnpm release:check:macos` 在未注入发布凭据时预期为 `warn`，仅缺正式签名与公证凭据；自动更新配置必须保持为 `ok`。
- 真实 Tauri smoke 不应再出现 `json-viewer` feature code 冲突 warning；若复现，说明 feature 索引幂等替换或内置资源路径回归。

2026-07-14 自动化基线：`pnpm test` 134/134、Vitest 组件行为 2/2、`pnpm test:browser` 8/8、Rust 308/308、严格 Clippy 零告警、Svelte check 0 errors / 0 warnings。应用发布版本已在 `package.json`、Tauri bundle、Rust workspace/crates 与 `Cargo.lock` 统一为 `3.0.0`，并由 fast tier 一致性测试约束；发布包预算测试会在隔离临时目录执行 production build，不再受 `tauri build --debug` 覆盖共享 `dist` 的影响。真实 `pnpm test:desktop` 于 `2026-07-14T04:36:06Z` 通过，PluginPanel render 2/2、bridge 10/10、native method 8/8、BrowserWindow isolation 9/9；重建 `.app` 的 Info.plist 版本为 `3.0.0 / 3.0.0`，`pnpm smoke:macos-release-app` 于 `2026-07-14T04:59:44Z` 为 10 ok / 1 个预期 Gatekeeper warning / 0 error；自动更新产物、公钥与 `TheLastSheep/atools` 稳定版清单地址已配置，`pnpm release:check:macos:unsigned` 精确为 9 ok / 2 warn / 0 error。剩余 warning 仅为正式 Developer ID 签名和 Apple 公证凭据。

## 2. Web Preview Smoke

启动：

```bash
pnpm dev --host 127.0.0.1
```

打开：

```text
http://127.0.0.1:1420/?parity=1
```

检查项：

- [x] 首页显示 ZTools 风格搜索框和右侧三笔画圆形 Z 图标。
- [x] 空搜索时显示“最近使用”；存在固定指令时先显示 `固定` 分区，再显示 `最近使用` 分区。
- [x] 空搜索且没有固定指令时，首页仍显示紧凑 `固定` 空态，并提供 `管理固定指令` 入口。
- [x] 点击首页 `管理固定指令` 会进入设置页并直接选中 `所有指令`，不落到通用设置。
- [x] `固定` 分区最多显示 `固定栏显示行数 * 9` 个固定指令，超出部分不挤占最近使用区域。
- [x] 最近使用磁贴显示来源类型 SVG 图标，不显示命令标题首字 fallback；图标外层约 38px，且网格无横向溢出。
- [x] 空搜索首页上方显示 `导入 ZTools 插件`、`插件管理`、`Agent / MCP`、`设置` 四个紧凑入口，不显示营销说明块。
- [x] 四个首页常用入口使用明确功能图标，不显示入口文字首字 fallback，且按钮具备 `打开...` aria label。
- [x] 点击 `导入 ZTools 插件` 只进入导入面板，并显示 `选择目录并扫描`、`等待扫描`，不自动执行导入。
- [x] 输入 `set` 后搜索结果按来源分组，结果行显示标题、说明、来源 detail、匹配标签。
- [x] 没有真实应用图标的内置搜索结果显示来源类型 SVG 图标，不显示标题首字 fallback；真实本地应用结果仍显示应用图标。
- [x] 搜索结果匹配标签带有类型 tone，`精确/前缀/包含`、`别名`、`拼音`、`模糊`、`待处理` 视觉上可区分。
- [x] 搜索结果当前选中行显示上下文 Enter 提示：系统/插件为 `Enter 执行`，网页/链接/本地启动为 `Enter 打开`，文本转换为 `Enter 复制`；按 `ArrowDown` 后提示移动到下一行。
- [x] 最近使用和搜索结果底部显示 34px 状态栏，展示当前位置/总数、当前选中项和 `Enter` / `Tab` / `Esc` 等按键提示；设置页不显示该底栏。
- [x] 首页存在固定指令时，底部状态栏选中固定项显示 `固定 n/m · 名称`，移动到最近使用项后显示 `最近使用 n/m · 名称`。
- [x] 点击 Z 图标进入设置页。
- [x] 设置页顶部标签、左侧宽侧栏菜单、通用设置布局接近 ZTools，顶部小/大 Z 图标均为三笔画圆形标识。
- [x] 设置页顶部标签栏高度约 94px，标签约 72px，小/大 Z 图标约 42/72px，更多按钮三点居中，且没有横向溢出。
- [x] 设置页顶部三点按钮可展开更多操作菜单；`复制运行信息` 显示复制状态，按 `Esc` 只关闭菜单不关闭设置页，`回到主搜索` 返回首页。
- [x] 设置页恢复默认、清空历史/审计/插件数据/崩溃日志、WebDAV 恢复/导入剪贴板等危险操作使用应用内确认弹窗，不出现浏览器原生 `confirm`；按 `Esc` 或 `取消` 只关闭弹窗，不关闭设置页且保留当前左侧菜单。
- [x] 设置页以完整设置窗口展开，目标高度约 860px；在低视口下按 `min(100vh, 860px)` 收敛，不出现裁切或横向溢出。
- [x] 设置页左侧菜单桌面宽度约 300-400px，选中行约 80px 高，图标约 32px，字号约 24px，且没有横向溢出。
- [x] 设置页右侧内容区桌面 padding 约 60/50/56/40px，分组标题约 26px，首行高度约 116px 以上，且没有横向溢出。
- [x] 设置页桌面控件为 ZTools 风格大尺寸：呼出快捷键约 300x66px，下拉约 300x66px，按钮约 54px 高，开关约 86x48px，且没有横向溢出。
- [x] 设置页左侧菜单和右侧内容区都有细窄圆角滚动条，亮/暗主题颜色正确，滚动条出现时布局不抖动且没有横向溢出。
- [x] 设置页左侧菜单包含 `HTTP 服务` 和 `关于`，菜单顺序接近 ZTools 设置源码。
- [x] `HTTP 服务` 页不是空白页，显示传统 HTTP API `未接入`，并明确推荐使用 `MCP 服务`。
- [x] `HTTP 服务` 页显示 `MCP 替代入口`、当前 MCP 状态和 token/security 提示；Web 预览无 token 时 `复制 MCP 地址` 保持禁用。
- [x] `HTTP 服务` 页的 `复制 MCP 配置` 可用；HTTP MCP 未就绪时应复制 stdio proxy fallback，并通过设置页内联状态反馈复制结果。
- [x] `关于` 页不是空白页，显示 `ATools 3.0`、`Tauri + Rust`、本地 MCP、HTML/JS 插件 UI 和运行信息。
- [x] `关于` 页显示 `本地环境`、`本地数据路径`、`数据库路径`、`插件目录`、`本地 Agent 能力`、`MCP 监听` 和 `运行事件`。
- [x] `关于` 页提供 `复制运行信息`、`复制脱敏诊断`、`打开调试日志`、`打开 MCP 服务`；复制运行信息后显示内联成功状态，复制内容不得包含 MCP token 明文。
- [x] `关于` 页点击 `打开 MCP 服务` 后左侧菜单选中 `MCP 服务`，并显示客户端配置复制入口。
- [x] 呼出快捷键右侧齿轮打开快捷设置，下拉包含默认快捷键、`Command+Space`、`Control+Space` 和重置项。
- [x] 设置页 `快捷键` 不是简短说明页，显示 `全局快捷键`、`应用快捷键`、`指令别名` 三个 tab 和概览卡。
- [x] `快捷键 / 全局快捷键` tab 显示当前呼出快捷键、录制/保存状态，以及自定义全局快捷键尚未接入的空状态。
- [x] `快捷键 / 应用快捷键` tab 显示 8 个内置快捷键行，并且 `Space`、`Tab` 两项会随设置值更新文案。
- [x] `快捷键 / 应用快捷键` tab 中点击 `添加快捷键` 会新增一条自定义应用快捷键，概览和页头自定义数量同步更新。
- [x] 自定义应用快捷键行支持启停、编辑快捷键、选择目标和删除；输入与内置快捷键重复时显示冲突提示。
- [x] `快捷键 / 指令别名` tab 显示真实的 `添加映射`、`清空别名`、启停和删除入口；无别名时显示空状态。
- [x] 自定义应用快捷键保存到本地设置；刷新后仍保留；主搜索框聚焦时按自定义组合键会触发对应目标。
- [x] 自定义应用快捷键不会在设置页输入框、快捷键录制框等普通可编辑控件内误触发。
- [x] 设置页 `所有指令` 不是简单别名页，显示可绑定指令、指令别名、固定指令、来源分组四个统计卡。
- [x] `所有指令` 左侧来源包含 `全部来源`、`系统指令`、`本地启动`、`网页快开`，点击来源后右侧列表只显示该来源目标。
- [x] 设置页 `网页快开` 以卡片列表展示 Google/GitHub/NPM 等默认项，卡片包含启停、关键字 chip、URL 预览和 `编辑` / `预览` / `删除` 操作，页面无横向溢出。
- [x] `网页快开` 点击 `编辑` 打开页面内编辑面板，支持 `搜索模板` / `固定网址` 类型切换、名称/关键字/URL 模板编辑和 `URL 预览`；按 `Esc` 只关闭编辑面板，不关闭设置页且仍停留在 `网页快开`。
- [x] `网页快开` 保存非法 URL、非 http/https URL、空名称、空关键字或带空格关键字时显示错误，不落库；删除按钮弹出应用内确认弹窗，取消或 `Esc` 不删除卡片。
- [x] 设置页 `本地启动` 显示 `添加文件`、`添加文件夹`、`添加应用`、`手动添加`、拖拽添加区域和行级 `打开` / `定位` / `删除`；Web 预览下文件选择按钮禁用，桌面端选择后会新增可搜索启动项。
- [x] `本地启动` 删除按钮弹出应用内确认弹窗，按 `Esc` 或 `取消` 只关闭弹窗，不删除条目且仍停留在 `本地启动`；确认删除后主搜索不再匹配该条路径。
- [x] `本地启动` 页在 1280px 和窄屏下没有横向溢出，路径输入框单独成行，行级操作按钮不挤压字段。
- [x] `所有指令` 右侧列表显示目标名称、启用状态、固定状态、说明、code、别名数量、别名 chip，并按状态显示 `添加别名` 或 `管理别名` 操作入口。
- [x] `所有指令` 行级 `固定` 会把目标加入主搜索首页固定项；`取消固定` 后首页移除该固定项。
- [x] `所有指令` 行级 `启用/停用` 对本地启动和网页快开生效，主搜索匹配结果同步变化；系统指令显示 `不可停用` 且不可点击。
- [x] `所有指令` 支持按名称、路径、code、别名或固定状态搜索；状态筛选包含全部/仅启用/仅停用。
- [x] `唤醒黑名单` 的 `添加当前窗口` 在桌面端可读取当前前台应用并添加；Web 预览下保持禁用并提示需在桌面应用中使用。
- [x] 通用设置中“搜索框显示最近使用”关闭后，回到首页不显示最近使用。
- [x] 刷新页面后，上一步设置仍保留。
- [x] 设置“最近使用显示行数”为 1，首页最多显示 9 个最近项。
- [x] 设置“固定栏显示行数”为 1，首页固定分区最多显示 9 个固定项；刷新后该设置仍保留。
- [x] 主题设置切到暗黑后，设置页和主界面变量变为暗色。
- [x] 主题色切到橙色后，选中态和开关颜色变为橙色。
- [x] 主题色切到 `自定义` 后显示颜色选择器，修改颜色后刷新仍保留。
- [x] 设置页 `开发者工具位置` 下拉可保存 `独立窗口` / `靠右` / `靠下` / `独立窗口（可停靠）` 偏好；桌面端 `打开主窗口 DevTools` 会调用 Tauri `open_devtools_for_window`，非法旧值会回退到默认偏好。
- [x] 设置页 `AI 模型` 不是占位页，显示模型提供商、API Base URL、默认模型、API Key、温度、Agent 默认开关和配置预览。
- [x] `AI 模型` 提供商切到 `兼容 API` 时显示配置不完整，Base URL/模型/API Key 输入可编辑；切回 `关闭` 后输入禁用且 Agent 默认开关关闭。
- [x] Web 预览下 `AI 模型` 的 `测试连接` 按钮保持禁用，并提示 `需在桌面应用中测试 AI 连接`。
- [x] 桌面端 `AI 模型` 配置完整后，点击 `测试连接` 只读取 `/models`，并显示连接状态、模型是否出现在列表、模型数量和耗时。
- [x] `AI 模型` 连接测试不发送聊天内容，不在页面结果、审计日志或 MCP 客户端配置中展示 API Key。
- [x] 桌面端启用通用网络代理并填写合法 http/https `代理地址` 后，`AI 模型` 连接测试请求层会使用该代理；非法协议会被设置规范化拒绝。
- [x] 通用设置中 `启用超级面板` 可保存并调用 Tauri `set_super_panel_visible`；桌面 smoke 会创建/隐藏独立 `super-panel` 窗口并验证 `super_panel_window=true`，超级面板路由可读取剪贴板文本并通过 `打开主搜索` 调用 `show_main_window`。
- [x] 通用设置中 `显示悬浮球` 可保存并调用 Tauri `set_floating_ball_visible`；桌面 smoke 会创建/隐藏独立 `floating-ball` 窗口并验证 `floating_ball_window=true`，悬浮球点击路径调用 `show_main_window`。
- [x] `AI 模型` 开启 `用于 Agent 默认模型` 后，`ask_ai_model` 工具会使用该配置调用 OpenAI-compatible `/chat/completions`。
- [x] 设置页 `插件市场` 不是旧占位页，显示 `未接入` 或 `目录可用` 状态、已安装插件数量、本地可用能力、远程目录能力、远程 ZIP 下载/安装/更新能力、SHA-256 校验能力、安装确认能力和暂缓接入能力。
- [x] 通用设置中自定义插件市场地址接受合法 http/https URL；启用后 `插件市场` 页显示 `市场地址`，桌面端 `打开市场地址` 会调用 `shell_open`，且页面明确提示需先读取自定义目录才能下载安装更新；目录条目提供 `checksum`/`sha256` 时会在安装/更新前校验 ZIP SHA-256，评分详情和签名信任仍未接入。
- [x] `插件市场` 中 `刷新插件` 可用；桌面端能读取已安装插件数量，配置自定义市场地址后会调用 `fetch_plugin_market_catalog` 读取远程 JSON 目录并展示插件条目；对 http/https `.zip` 条目点击 `安装` / `重装` / `更新` 会先弹出设置页内嵌确认，确认后才调用 `install_plugin_from_market` 或 `update_plugin_from_market` 下载、安全解包并复用本地安装/更新流程；已安装同 ID 条目更新会保留启停状态；Web 预览下提示需在桌面应用中查看。
- [x] 设置页 `已安装插件` 不是旧占位页，显示插件总数、启用/停用数量、feature 数量、插件列表和本地路径。
- [x] `已安装插件` 支持按名称、feature、描述、路径或来源筛选；状态筛选包含全部/启用/停用，来源筛选包含全部/内置/导入。
- [x] `已安装插件` 中 `安装插件` 在桌面端可选择包含 `plugin.json` 的目录并调用本地安装；Web 预览不打开目录选择器并提示无法安装；网络 ZIP 安装/更新从插件市场远程目录触发；导入插件可卸载，内置插件只能停用。
- [x] `已安装插件` 桌面端可刷新插件列表，插件行显示版本、来源、feature 预览和启用状态；Web 预览下提示需在桌面应用中查看。
- [x] `已安装插件` 中选择插件后显示 `插件详情`，包含名称、状态、版本/来源、更新时间、描述、路径和 feature 明细。
- [x] `插件详情` 中 `打开目录` 可用，桌面端会通过 Finder 定位插件路径；导入插件的 `更新插件` 可选择本地同 ID 插件目录更新，保留启停状态，拒绝当前安装目录或不匹配的 manifest；远程同 ID 更新从插件市场目录触发，保留启停状态，并可校验目录 SHA-256；`插件权限` 可展开只读 `插件权限/能力审计`，展示 main/preload、feature 匹配、Agent tools 和本地数据边界；完整插件权限授权/隔离模型仍保持未接入；导入插件的 `卸载插件` 可用，必须先显示会移除插件本体、指令索引和插件数据的页内危险确认，确认后刷新插件列表；内置插件的更新/卸载动作不可用。
- [x] 设置页 `WebDAV 同步` 不是占位页，显示 WebDAV 服务器地址、用户名、密码/Token、远端目录、同步范围和同步状态。
- [x] `WebDAV 同步` 空配置时启用开关禁用且未选中；填写合法 http/https 地址和用户名后才允许启用。
- [x] Web 预览下 `WebDAV 同步` 的 `立即同步` 按钮保持禁用，并提示需在桌面应用中同步。
- [x] Web 预览下 `WebDAV 同步` 的 `检查远端备份` 按钮保持禁用，并提示需在桌面应用中检查。
- [x] Web 预览下 `WebDAV 同步` 的 `生成恢复计划` 按钮保持禁用，并提示需在桌面应用中生成。
- [x] Web 预览下 `WebDAV 同步` 的 `恢复设置` 按钮保持禁用，并提示需在桌面应用中恢复。
- [x] Web 预览下 `WebDAV 同步` 的 `导入剪贴板` 按钮保持禁用，并提示需在桌面应用中导入剪贴板历史。
- [x] 桌面端配置完整且启用后，`WebDAV 同步` 的 `立即同步` 会上传所选范围的远端备份，并显示上传文件数、远端 manifest 校验和耗时。
- [x] 桌面端配置完整且启用后，`检查远端备份` 只读取远端 manifest 和文件摘要，并显示远端备份类型、导出时间、文件数量和摘要。
- [x] 桌面端配置完整且启用后，`生成恢复计划` 会比较本机与远端备份，显示设置变更 key、跳过的脱敏密钥、插件/剪贴板替换摘要和高风险标记。
- [x] 桌面端启用通用网络代理并填写合法 http/https `代理地址` 后，WebDAV 同步、远端备份预览、恢复计划和恢复/导入下载请求会共用代理请求客户端。
- [x] 桌面端生成包含设置变更的恢复计划后，`恢复设置` 会弹出确认；确认后只恢复 `settings.json` 中未脱敏的设置项，`<redacted>` 字段保持本机原值，并显示已恢复/已跳过 key。
- [x] 桌面端生成包含剪贴板差异的恢复计划后，`导入剪贴板` 会弹出确认；确认后只追加导入本机缺失的文本历史，不清空、不覆盖现有剪贴板历史，并显示远端/已导入/已跳过条目数。
- [x] 桌面端生成包含插件数据差异的恢复计划后，`导入插件数据` 会弹出确认；确认后只追加本机已安装插件缺失的文档，同 ID 冲突文档会跳过，不覆盖本机插件数据，并显示远端/已导入/已跳过/冲突/缺失插件数量。
- [x] 桌面端生成包含插件数据差异的恢复计划后，`覆盖冲突数据` 会弹出单独确认；确认后会导入缺失文档并用远端同 ID 文档覆盖本机冲突文档，结果显示 `已覆盖` 数量。
- [x] 桌面端生成包含插件数据冲突的恢复计划后，会显示 `插件数据冲突选择`，可 `全选冲突`、`清空选择`，并通过 `覆盖选中冲突` 只覆盖已勾选的同 ID 冲突文档。
- [x] WebDAV 恢复设置、导入剪贴板和导入插件数据确认均复用设置页内嵌确认弹窗；确认前不会执行本地写入，取消后不会改变设置、剪贴板历史或插件数据。
- [x] `WebDAV 同步` 当前已支持远端备份上传、manifest 读取校验、远端备份预览、恢复计划 diff 预览、设置恢复确认流、剪贴板历史追加导入、插件数据追加导入、插件数据冲突覆盖导入和逐文档冲突选择；远端覆盖本机全部数据仍未接入。
- [x] 设置页 `调试日志` 不是占位页，显示运行环境、桌面运行状态、本地配置状态、MCP 状态、崩溃日志和最近审计错误。
- [x] `调试日志` 中点击 `复制信息` 后复制的是 `atools_diagnostic_bundle` 脱敏诊断包，不包含 MCP token、AI API Key、WebDAV 密码等敏感字段。
- [x] `调试日志` 脱敏诊断包包含 `proxyEnabled` 状态，但 `proxyUrl` 始终以 `<redacted>` 输出。
- [x] 测试结束后恢复为：主题 `跟随系统`、主题色 `罗兰紫`、最近使用开启、最近使用 2 行。

已知限制：

- 当前 Codex 内置浏览器自动化可能无法 `fill` 输入框，报 virtual clipboard 未安装；搜索框提示文字输入需要人工验证或换 Playwright/CDP 验证。

## 3. Tauri Dev Smoke

启动：

```bash
pnpm tauri dev
```

检查项：

- [x] App 启动后主窗口居中显示。
- [ ] `Option+Z` 可显示/隐藏主窗口。
- [x] 设置页修改“呼出快捷键”后，新快捷键生效，旧快捷键不再触发。
- [x] 设置页录制 `Command+Space` 这类系统保留快捷键时显示冲突风险，不进入静默保存。
- [x] 真实系统占用导致注册失败时，“冲突/保存状态”显示保存失败和错误详情。
- [ ] 设置“显示托盘图标”打开后，macOS 菜单栏出现 ATools 图标。
- [ ] 设置“显示托盘图标”关闭后，图标隐藏。
- [ ] 设置“开机自动启动”打开后，生成 `~/Library/LaunchAgents/com.atools.desktop.plist`。
- [ ] 设置“开机自动启动”关闭后，上述 plist 被删除。
- [x] 桌面 smoke 的 `system_settings_smoke` 会观测主窗口几何居中、事务性切换并恢复呼出快捷键、按当前设置重放托盘可见性、校验 LaunchAgent plist、仅在系统临时目录写入/删除自启 plist，并验证 `settings-general` 不被 smoke 改写；smoke 不触碰真实 `~/Library/LaunchAgents`。

风险：

- 前端已拦截明显无效或常见系统保留组合；其他真实系统占用仍依赖 Tauri 全局快捷键注册失败返回。
- 唤醒黑名单已接入 macOS 前台应用判断；依赖系统 Automation 权限，权限不足时不会阻塞唤醒。

## 4. Plugin Smoke

真实 ZTools 插件 manifest 兼容扫描：

```bash
pnpm report:ztools-compat -- --source /Users/harris/Desktop/ZTools-plugins/plugins --output output/ztools-plugin-compatibility-report.json
```

- [x] 报告能成功生成 JSON。
- [x] `summary.scanned_plugins` 大于 0。
- [x] `unsupported_cmd_plugins` 保持为 0；若升高，说明 manifest cmd type 解析覆盖回归或样本新增了未支持类型。
- [x] `error_plugins` 主要来自源码型插件缺少构建后的 `main` 文件；若已构建插件报缺 main，需要检查安装包路径策略。

真实 ZTools 插件运行态样本候选报告：

```bash
pnpm report:ztools-runtime-samples -- --source /Users/harris/Desktop/ZTools-plugins/plugins --output output/ztools-plugin-runtime-sample-report.json --limit 20
```

- [x] 报告能成功生成 JSON。
- [x] 当前基线为 125 scanned、61 launchable、21 ready、40 risk、64 blocked、20 selected sample candidates。
- [x] `missing_local_resources` 当前为 17；若升高，需要检查入口 HTML 资源改写、构建产物或样本仓库结构是否变化。
- [x] `preload_electron_require_plugins` 当前为 26，`preload_node_risk_plugins` 当前为 69；这些是后续逐插件 runtime smoke 的风险信号，不代表本地启动已失败。
- [x] 该报告只是候选池和风险分层，不等同于逐插件导入、启用、激活、UI load、bridge 调用和清理。

真实 ZTools 插件激活 smoke plan：

```bash
pnpm report:ztools-activation-plan -- --source /Users/harris/Desktop/ZTools-plugins/plugins --output output/ztools-plugin-activation-plan.json --limit 10 --install-root /tmp/atools-ztools-plugin-smoke
```

- [x] 报告能成功生成 JSON。
- [x] 当前基线为 10 planned samples、61 launchable、64 blocked skipped、10 ready plans、0 risk plans。
- [x] 当前 10 个计划样本均有 text trigger；若出现 regex/typed/manual trigger，需要确认后续 desktop harness 是否能构造对应输入或 payload。
- [x] 每个 plan item 都应包含 `install`、`enable`、`activation`、`assertions`、`cleanup`，并且 `cleanup.uninstall_plugin_id` 与 `install.expected_plugin_id` 一致。
- [x] `ztools-developer-plugin/ui.router` 在 plan 中保留 activation 覆盖，但标记 `render_smoke.safe:false`，真实 PluginPanel render 队列应跳过该无交互 iframe probe unsafe 样本。
- [x] 该 plan 是后续自动导入/启用/激活/清理 smoke 的输入，不代表 10 个外部插件已经被实际运行。

真实 ZTools 外部插件 activation desktop smoke：

```bash
ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop
```

- [x] `status` 为 `ok`。
- [x] `ztools_external_activation_smoke.plan_path` 解析到 repo 根目录下的 `output/ztools-plugin-activation-plan.json`，不是 `src-tauri/output/...`。
- [x] 当前基线为 10 planned、9 imported、9 activated、9 ui actions checked、9 PluginPanel FS load specs checked、9 assertions checked、9 cleanup verified、1 skipped、`error:null`。
- [x] 同一次 smoke 的 `plugin_panel_render_smoke` 覆盖当前可安全渲染外部 plan action 队列；当前基线为 `expected_samples:8`、`reported_samples:8`、`rendered_samples:8`、`external_plan_expected_samples:8`、`external_plan_rendered_samples:8`、`error:null`。
- [x] 同一次 smoke 的 iframe bridge probe 当前基线为 `bridge_probe_expected_samples:8`、`bridge_probe_reported_samples:8`、`bridge_probe_passed_samples:8`、`bridge_probe_checks:40`、`bridge_probe_passed_checks:40`、`bridge_probe_failed_ids:[]`。
- [x] 同一次 smoke 的 iframe native/system method probe 当前基线为 `native_method_probe_expected_samples:8`、`native_method_probe_reported_samples:8`、`native_method_probe_passed_samples:8`、`native_method_probe_checks:32`、`native_method_probe_passed_checks:32`、`native_method_probe_failed_ids:[]`。
- [x] 同一次 smoke 日志不应出现 `Scoped command osascript not found`；`src-tauri/capabilities/default.json` 必须把 `shell:allow-execute` scope 限定到 `osascript` + `-e` + 非空脚本参数。
- [x] `ui_actions_checked` 验证 `activate_feature_inner` 返回了 `PluginPanel` 可用的 `FeatureAction`，包括 plugin path、main URL、可选 preload path 和受限 expand height。
- [x] `plugin_panel_fs_load_checked` 验证真实导入插件的 `FeatureAction` 可形成 `PluginPanel.loadPluginHtml()` 的文件系统加载规格：canonical plugin path 匹配导入目录、`main_url` 是插件目录内相对文件、可选 preload 位于同一插件目录内，且 payload 不使用 Web preview `iframeSrc` / `srcdoc`。
- [x] skipped 样本来自 feature code 已归属现有插件；这类样本应跳过，不能覆盖内置 feature ownership。
- [x] 标准 `pnpm smoke:tauri-desktop` 不设置 `ATOOLS_ZTOOLS_ACTIVATION_PLAN` 时仍应通过，且 `ztools_external_activation_smoke` 为空 skipped summary。
- [x] 该 smoke 覆盖外部插件导入、feature 激活查找、真实 PluginPanel FS load spec、render-safe 外部 plan PluginPanel 文件系统渲染、main/preload 断言、no-side-effect iframe native/system method probes 和清理；外部插件逐插件截图、交互或 side-effecting native bridge 调用仍需专项回归。

真实 Tauri PluginPanel render smoke：

```bash
pnpm smoke:tauri-desktop
```

- [x] `status` 为 `ok`。
- [x] `plugin_panel_render_smoke.reported` 为 `true`。
- [x] `plugin_panel_render_smoke.plugin_path_exists`、`fs_load`、`iframe_srcdoc_loaded`、`iframe_src_empty`、`load_error_empty` 均为 `true`，`iframe_srcdoc_bytes > 0`，`error:null`。
- [x] 标准 smoke 当前基线为 `expected_samples >= 1`、`reported_samples == expected_samples`、`rendered_samples == expected_samples`、`external_plan_expected_samples:0`、`external_plan_rendered_samples:0`。
- [x] 标准 smoke iframe bridge probe 当前基线为 `bridge_probe_reported_samples == expected_samples`、`bridge_probe_passed_samples == expected_samples`、`bridge_probe_checks > 0`、`bridge_probe_passed_checks == bridge_probe_checks`、`bridge_probe_failed_ids:[]`。
- [x] 标准 smoke iframe native/system method probe 当前基线为 `native_method_probe_reported_samples == expected_samples`、`native_method_probe_passed_samples == expected_samples`、`native_method_probe_checks > 0`、`native_method_probe_passed_checks == native_method_probe_checks`、`native_method_probe_failed_ids:[]`。
说明：标准 smoke 会优先打开时间戳插件并要求 `plugin_panel_render_smoke.timestamp_subinput_checked:true`；新版 host SubInput 和旧版页面内可见输入框都会通过 iframe smoke probe 映射到该断言。
说明：2026-07-10T13:20:34Z 的最终 queue-gated 真实 `pnpm smoke:tauri-desktop` 已通过；BrowserWindow 隔离 probe 基线为 1/1/1 samples、9/9 checks（1/1/1 分别为 expected/reported/passed），且 `browser_window_created:true`、`browser_window_child_origin_opaque:true`、`browser_window_self_tauri_unavailable:true`、`browser_window_parent_tauri_unavailable:true`、`browser_window_parent_document_blocked:true`、`browser_window_send_to_parent_checked:true`、`browser_window_execute_javascript_checked:true`、`browser_window_ipc_roundtrip_checked:true`、`browser_window_cleanup_checked:true`。
- [x] 该 smoke 由前端在 `VITE_ATOOLS_DESKTOP_SMOKE=1` 下调用 `desktop_smoke_plugin_panel_actions` 自动打开真实 PluginPanel action 队列，并由 `PluginPanel.loadPluginHtml()` 在文件系统读取、资源改写、bridge 注入、写入 `iframeSrcDoc` 后逐项调用 `report_plugin_panel_render_smoke` 回传。
- [x] `PluginPanel` 的 smoke bridge probe wait budget 应根据最终 `srcdoc` 字节数计算，避免 5MB 级真实入口被固定低 timeout 误判；预算下限为 12s，上限为 20s。
- [x] 设置 `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json` 时，该 smoke 应切到外部 plan render 队列；当前基线为 8/8 external plan render samples、40/40 smoke-injected iframe bridge probe checks 和 32/32 iframe native/system method probe checks。
- [x] 该 smoke 证明真实 Tauri 前端 PluginPanel 的 FS `srcdoc` 加载路径、iframe 内基础 `utools/ztools` bridge 和 no-side-effect native/system method path 可用；它不等同外部 ZTools 插件全量逐插件视觉回归、插件自写交互 replay 或 side-effecting native bridge 全量回放。

真实 ZTools 外部插件 UI host smoke report：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures --fixture-base-url http://127.0.0.1:1434/
```

- [x] 报告能成功生成 JSON。
- [x] 当前基线为 10 planned、10 UI host samples、10 desktop action fixtures、10 Web preview actions、10 iframe-ready checks、20 screenshot viewport checks、50 bridge probes、10 real entry HTML checks、10 real entry HTML ready、0 real entry HTML missing、42501 real entry HTML bytes、27 real entry resource checks、27 real entry resources ready、0 real entry resources missing、1970144 real entry resource bytes、10 real entry fixtures generated、2152915 real entry fixture bytes、10 real entry fixture matrix count、13082 real entry fixture matrix bytes、10 real entry PluginPanel checks、10 real entry PluginPanel ready、10 real entry PluginPanel matrix count、28331 real entry PluginPanel matrix bytes、90 real entry fixture bridge API probe checks、77 runtime support files、4735659 runtime support bytes、2 preload expected、0 skipped。
- [x] 每个 plan item 都应包含 desktop `FeatureAction` fixture、`pluginHostSmoke=externalPlan` Web preview URL、iframe-ready expectation、screenshot viewports 和 bridge probes。
- [x] 每个 plan item 都应包含 `real_entry_html`，记录真实 `manifest.main` 的 status、absolute `html_path`、entry directory、byte size、SHA-256 和 resource signals；该字段不得把第三方 HTML 内容复制进 Web preview URL。
- [x] 每个 plan item 都应包含 `real_entry_resources`，记录本地 entry script/stylesheet 的 ready/missing counts、absolute path、byte size、SHA-256 和 script `module` 标记；HTTP(S)、data、protocol-relative 和 hash-only URL 不应算作本地缺失。
- [x] 每个 plan item 都应包含 `real_entry_fixture`，记录生成 fixture 的 status、path、file URL、byte size、SHA-256、inlined script/stylesheet counts、probe ids、bridge API probe ids、runtime support file count 和 runtime support byte count。
- [x] 每个 plan item 都应包含 `real_entry_plugin_panel`，记录通过 Web preview `PluginPanel` 加载该 fixture 的 status、app preview URL、fixture path、fixture URL、probe ids 和 expected DOM；当传入 `--fixture-base-url` 时，preview action payload 应使用 `iframeSrc` 指向本地 HTTP fixture URL，且不应把真实第三方 HTML 复制进 `srcdoc`。
- [x] 报告顶层应包含 `real_entry_fixture_matrix`，记录 matrix harness 的 status、path、file URL、byte size、SHA-256 和 fixture count；summary 应包含 `real_entry_fixture_matrix_count`、`real_entry_fixture_matrix_bytes`、`real_entry_fixture_bridge_api_probe_checks`、`real_entry_fixture_runtime_support_files` 和 `real_entry_fixture_runtime_support_bytes`。
- [x] 报告顶层应包含 `real_entry_plugin_panel_matrix`，记录 PluginPanel matrix harness 的 status、path、file URL、browser URL、byte size、SHA-256 和 panel count；summary 应包含 `real_entry_plugin_panel_matrix_count` 和 `real_entry_plugin_panel_matrix_bytes`。
- [x] Web preview URL 的 `pluginHostSmokeAction` 必须用 UTF-8 解码，中文插件名和触发词不能出现 mojibake。
- [x] externalPlan `srcdoc` 应回传 `__atools_ui_host_probe_result__`，PluginPanel runtime strip 应显示 `宿主探针 5/5`。
- [x] Browser smoke 可用第一个 `externalPlan` URL 验证页面标题 `ATools 3.0`、插件名 `计算稿纸`、iframe mode、bridge capability strip、`宿主探针 5/5`、主插件 iframe sandbox `allow-scripts allow-popups`、console 0 warn/error、无 framework overlay、无横向溢出。
- [x] Browser smoke 可用本地 HTTP 服务打开第一个生成 fixture `001-calculation-paper-calc.html`，验证真实 DOM 可见 `计算公式` 输入框、`data-atools-real-entry-fixture=true`、`data-atools-real-entry-ready=true`、`data-atools-real-entry-bridge-present=true`、`data-atools-real-entry-ztools-alias=true`、plugin id `calculation-paper`、feature code `calc`、console 0 warn/error；直接 `file://` 可能被 Browser URL policy 阻止，应用本地 HTTP 服务验证。
- [x] Browser smoke 应使用 `pnpm serve:ztools-ui-host-fixtures -- --root output/ztools-ui-host-real-entry-fixtures --host 127.0.0.1 --port 1434` serve fixture 目录；该服务应支持 CORS headers、`OPTIONS` preflight、字体/script/json MIME，并保护 path traversal。
- [x] Browser smoke 应用本地 fixture server 打开生成目录的 matrix `index.html`，验证 `data-atools-real-entry-fixture-matrix=true`、expected-count 10、ready-count 10、error-count 0、all-ready true、10 个 fixture iframe、10 行，每行 fixture 的 ready/bridge/ztools/identity 均为 true，且每行 `bridgeApi=9/9 bridgeApiFailed= errors=0`，console 0 warn/error。
- [x] Browser smoke 应用本地 fixture server 在 `127.0.0.1:1434` serve fixture 目录，并打开第一个 `real_entry_plugin_panel.url`；应验证页面标题 `ATools 3.0`、插件名 `计算稿纸`、主插件 iframe `src=http://127.0.0.1:1434/001-calculation-paper-calc.html`、`srcdoc` 为空、sandbox `allow-scripts allow-popups`、runtime `iframe`、bridge capability strip、`宿主探针 15/15`、console 0 warn/error、无 Vite error overlay、无横向溢出。
- [x] Browser smoke 应打开 `real_entry_plugin_panel_matrix.browser_url`，即 `http://127.0.0.1:1434/plugin-panel-matrix.html`，验证 `data-atools-real-entry-plugin-panel-matrix=true`、expected-count 10、ready-count 10、error-count 0、all-ready true、10 个 PluginPanel iframe、每行 `ready passed=15/15 failed=`、console 0 warn/error；若有失败，matrix 行应渲染 `messages=` 透传真实 fixture error。
- [x] Browser screenshot capture 应实际采集 report 的 20 个 `screenshot_viewports` PNG 像素 artifact，并校验每个 artifact 的 PNG header、视口尺寸、字节数、页面标题 `ATools 3.0`、插件名、`宿主探针 5/5`、console 0 warn/error、无 framework overlay、无横向溢出；这些 screenshot artifacts 才能作为后续自动化输入，而不是只记录 viewport plan。
- [x] 该 report 是外部插件 UI host 自动化 fixture，并已覆盖最小 externalPlan 探针回传、真实入口 HTML readiness/hash 基线、本地脚本/样式依赖 readiness/hash 基线、CSS `@import`/`url()` 字体资产复制、生成 fixture 的首样本浏览器渲染、10 个 standalone fixture 的 matrix 生命周期/bridge/identity/bridge API 脚本错误检查、首个 generated fixture 通过 Web preview `PluginPanel` iframe `src` 加载，以及 10 个 generated fixture 通过 Web preview PluginPanel matrix 回传 `passed=15/15` 且 Browser console 0 warn/error；仍不代表真实 Tauri FS 导入插件、真实第三方入口逐插件视觉截图和真实 native bridge probe 回放已完成。

内置插件检查：

Batch 384 安全边界：主插件和 hosted BrowserWindow iframe 的 sandbox 均严格为 `allow-scripts allow-popups`，不含 `allow-same-origin`。主 iframe invoke 采用 deny-by-default allowlist、`WindowProxy` source/generation 绑定、参数重建和强制 active `pluginId`；hosted child 不再由宿主读取 DOM，只通过每个 child 独立的 `MessageChannel` 调用固定 RPC 方法 `describe`、`executeJavaScript`、`sendInputEvent`、`insertCSS`、`removeInsertedCSS`、`findInPage`、`stopFindInPage`。

- [x] Web 预览 `?parity=1` 不搜索真实插件；真实 `activate_feature` 插件运行态必须在桌面端验证，并由 `pnpm smoke:tauri-desktop` 自动检查至少一个已索引插件入口及其真实 Tauri PluginPanel FS render 回传。
- [x] Web 预览 `?parity=1&pluginHostSmoke=1` 只验证插件宿主 UI：显示 `插件运行态预览`、运行状态/SubInput/输出结果/桥接能力 4 个状态卡、桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`、SubInput 和 output 列表，且 header/runtime/SubInput/body/output 不互相覆盖。
- [x] 插件 HTML 资源兼容由 `pnpm test:plugin-resource-html` 覆盖：`main_url` 子目录、相对 script/style、CSS `url(...)` / `@import`、`srcset`、link icon/modulepreload、常见图片/媒体资源，以及入口 HTML 本地 `<base href>` 下的静态资源会按入口文件目录或声明 base 目录解析，改写后的 `<base>` 会保留原始本地 href marker；运行时动态资源属性解析由 `pnpm test:plugin-resource-runtime` 覆盖，常见动态插入的 image/media/script/link/object 节点、`<style>` 文本、inline `style` 属性、`CSSStyleSheet.insertRule()` 规则，以及 fetch-sensitive 的动态 script/link 通过 `appendChild` / `insertBefore` / `append` / `prepend` / `before` / `after` / `replaceWith` 插入前 preflight 会经父窗口转换本地相对 URL，并在存在当前本地 `<base href>` marker 或插件运行时更新后的 live 本地 `<base href>` 时按声明 base 目录解析。
- [x] 搜索 `计算` 或 `calculator`，能进入计算器插件。
- [x] 搜索 `时间戳`，进入后出现 subInput。
- [ ] `时间戳` 插件真实桌面聚合回放仍需人工完成：标题栏/运行状态/SubInput/动态指令/设置跳转/注册工具/高度/焦点/主窗口生命周期，以及 clipboard、输入自动化、shell、screen、context 等 side-effecting native bridge 均需在受控环境逐项验证。BrowserWindow 兼容面以本节后续已勾选的宿主状态/API 行为和 Batch 384 隔离拒绝语义为准，不再把 inspect/capture/export/edit/selection 的旧同源 DOM 实现当作成功条件。
- [x] BrowserWindow handle 的 `isResizable()` / `setResizable()`、`isMovable()` / `setMovable()`、`isClosable()` / `setClosable()`、`isMinimizable()` / `setMinimizable()`、`isMaximizable()` / `setMaximizable()` 会路由到宿主内 capability state；`closable:false` 会禁用宿主内子窗口关闭按钮。
- [x] BrowserWindow handle 的 `isFullScreen()` / `setFullScreen()`、`isFullScreenable()` / `setFullScreenable()` 会路由到宿主内 full-screen state；`setFullScreen(true)` / `setFullScreen(false)` 会切换宿主内 full-screen class/state 并派发 `enter-full-screen` / `leave-full-screen`，`fullScreenable:false` 不进入宿主 full-screen。
- [x] BrowserWindow handle 的 `getOpacity()` / `setOpacity()`、`hasShadow()` / `setHasShadow()` / `invalidateShadow()` 会路由到宿主内 appearance state；非 1 opacity 写入宿主内子窗口 inline style，`hasShadow:false` 添加 `noShadow` class，恢复后最终窗口不残留 opacity/noShadow。
- [x] BrowserWindow handle 的 `setBackgroundColor(color)` / `getBackgroundColor()` 会路由到宿主内 background-color state；setter 保持 void-return shape，getter 返回同步规范化后的 `#RRGGBB`，hosted 子窗口 shell 会应用同一背景色。
- [x] BrowserWindow handle 的 `setSkipTaskbar()`、`setKiosk()` / `isKiosk()`、`setVisibleOnAllWorkspaces()` / `isVisibleOnAllWorkspaces()`、`setContentProtection()` / `isContentProtected()` 会路由到宿主内 system-state；`kiosk:true` 会填满 hosted layer，恢复后最终窗口不残留 `kiosk` class。
- [x] BrowserWindow handle 的 `setFocusable()` / `isFocusable()`、`flashFrame()`、`setProgressBar()` 会路由到宿主内 focus/attention/progress state；`flashFrame(true)` 添加 hosted `flashing` class，`setProgressBar()` 显示 hosted 标题栏进度条，恢复后最终窗口不残留 `flashing` class 或 progress strip。
- [x] BrowserWindow handle 的 `getMediaSourceId()`、`moveTop()`、`moveAbove(mediaSourceId)` 会路由到宿主内 z-order/media-source state；`moveTop()` / `moveAbove()` 更新 hosted z-index，临时参照子窗口关闭后最终只保留主子窗口。
- [x] BrowserWindow handle 的 `getContentSize()` / `setContentSize()`、`getMinimumSize()` / `setMinimumSize()`、`getMaximumSize()` / `setMaximumSize()`、`setAspectRatio()` 会路由到宿主内 content-size/min-max/aspect-ratio state；`setBounds()` / `setSize()` / `setContentSize()` 共享 hosted size constraint 路径。
- [x] BrowserWindow handle 的 `webContents.send(channel, ...args)` 会投递到对应 hosted child iframe；子窗口通过 `require("electron").ipcRenderer.on(channel, listener)` / `once()` 接收 payload，并可继续用 `sendToParent()` 回调父插件 iframe。
- [x] BrowserWindow handle 的 `webContents.executeJavaScript(code[, userGesture])` 会在对应 hosted child iframe 中执行脚本，返回脚本结果或明确 method-scoped 错误，不返回静默成功。
- [x] BrowserWindow handle 的 `webContents.sendInputEvent(inputEvent)` 会在对应 hosted child iframe 中派发兼容 DOM 键盘、鼠标或滚轮事件；`loadURL()` / `reload()` 后续 WebContents 动作不应打到初始空文档。
- [x] BrowserWindow handle 的 `webContents.insertCSS(css[, options])` 会向对应 hosted child iframe 注入 keyed stylesheet 并返回 key；`webContents.removeInsertedCSS(key)` 会移除同一 key 的 stylesheet，移除后 child iframe 不残留 injected style。
- [x] BrowserWindow handle 的 `webContents.findInPage(text[, options])` 会同步返回 request id，并通过 `webContents.on("found-in-page", listener)` 向父插件派发 targeted 查找结果；`webContents.stopFindInPage(action)` 会路由到同一 hosted child iframe 且保持 void-return shape。
- [x] BrowserWindow handle 的 `webContents.getURL()` / `getTitle()` / `isLoading()` / `isLoadingMainFrame()` / `canGoBack()` / `canGoForward()` 会读取 hosted child iframe 导航状态；`webContents.reloadIgnoringCache()` / `goBack()` / `goForward()` 会路由到同一 hosted history，back/forward 后 sync 状态同步更新。
- [x] BrowserWindow handle 的 `webContents.openDevTools(options)` / `closeDevTools()` / `toggleDevTools()` 会更新 hosted DevTools state，并通过 `webContents.on("devtools-opened" | "devtools-closed", listener)` 向父插件派发 targeted 事件；`isDevToolsOpened()` / `isDevToolsFocused()` 会同步读取 hosted state。
- [x] BrowserWindow handle 仍暴露 `webContents.inspectElement(x, y)` 兼容入口，但 opaque hosted child 下宿主不读取 child DOM；调用会明确拒绝并返回 `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED`，Web preview smoke 将该稳定拒绝视为隔离边界通过，而不是元素检查成功。
- [x] BrowserWindow handle 仍暴露 `webContents.capturePage([rect, opts])` / `print([options], [callback])` / `printToPDF(options)` / `savePage(fullPath, saveType)` 兼容入口；opaque hosted child 下 `capturePage()`、`printToPDF()`、`savePage()` 均明确拒绝为 `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED`，`print()` 只通过 callback 返回 `success:false` 和明确 `native-only` failure，不伪造 snapshot、PDF 或页面写盘成功。
- [x] BrowserWindow handle 的 `webContents.getUserAgent()` / `setUserAgent(userAgent)`、`getFrameRate()` / `setFrameRate(fps)`、`getBackgroundThrottling()` / `setBackgroundThrottling(allowed)`、`getProcessId()` / `getOSProcessId()` 会路由到 hosted runtime state；setter 保持 void-return shape，sync getter 立即可读，process id 为 hosted compatibility 正整数，不等同真实 Electron renderer 或 OS process id。
- [x] BrowserWindow handle 的 `webContents.loadURL(url[, options])` / `reload()` / `stop()` / `isDestroyed()` / `getType()` 会路由到 hosted child iframe navigation/lifecycle state；`loadURL()` / `reload()` 更新 hosted URL/title/history/loading state，`stop()` 保持 void-return shape 并同步清理 hosted loading/loading-main-frame，`isDestroyed()` 随 hosted close/closed event 更新，`getType()` 在当前宿主内返回 `"window"`。
- [x] BrowserWindow handle 的 `webContents.isCrashed()` / `forcefullyCrashRenderer()` 会路由到 hosted child iframe crash lifecycle state；`forcefullyCrashRenderer()` 保持 void-return shape，同步标记 hosted crashed state，并向父插件派发 targeted `render-process-gone` 事件，随后 `reload()` / `loadURL()` / history navigation 会清理 hosted crashed state。
- [x] BrowserWindow handle 的 `webContents.focus()` / `isFocused()` / `getOwnerBrowserWindow()` / `getMediaSourceId()` / `isBeingCaptured()` / `setIgnoreMenuShortcuts(ignore)` 会路由到 hosted child iframe focus/owner/media/shortcut state；`focus()` / `setIgnoreMenuShortcuts()` 保持 void-return shape，sync getter 立即可读，owner 返回当前 hosted BrowserWindow handle，media source id 为 hosted compatibility id。
- [x] BrowserWindow handle 的 `webContents.navigationHistory.canGoBack()` / `canGoForward()` / `goBack()` / `goForward()` / `goToIndex(index)` / `canGoToOffset(offset)` / `goToOffset(offset)` / `clear()` 会路由到 hosted child iframe navigation history state；动作方法保持 void-return shape，sync getter 立即可读，`clear()` 会把 hosted history 折叠到当前 entry。
- [x] BrowserWindow handle 的 `webContents.isWaitingForResponse()` 会读取 hosted child iframe waiting-response state；`loadURL()` pending 期间可同步读到 true，hosted response 完成、`stop()` 或 lifecycle 清理后应回到 false。
- [x] BrowserWindow handle 的 12 个编辑入口 `webContents.insertText(text)` / `undo()` / `redo()` / `cut()` / `copy()` / `paste()` / `pasteAndMatchStyle()` / `delete()` / `selectAll()` / `unselect()` / `replace(text)` / `replaceMisspelling(text)` 保留兼容方法，但 opaque hosted child 下全部明确拒绝为 `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED`；宿主不再读取或编辑 child DOM，也不维护伪本地编辑剪贴板。
- [x] BrowserWindow handle 的 4 个 selection/scroll 入口 `webContents.centerSelection()` / `scrollToTop()` / `scrollToBottom()` / `adjustSelection({ start, end })` 保留兼容方法，但 opaque hosted child 下全部明确拒绝为 `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED`，不再由宿主直接读取 selection 或滚动 child document。
- [x] BrowserWindow handle 的 `webContents.setZoomFactor(factor)` / `getZoomFactor()` / `setZoomLevel(level)` / `getZoomLevel()` / `setVisualZoomLevelLimits(minimumLevel, maximumLevel)` 会更新 hosted zoom state；`setZoomFactor()` / `setZoomLevel()` 保持 void-return shape，sync getter 立即可读，child iframe 通过 CSS scale 呈现当前 factor。
- [x] BrowserWindow handle 的 `webContents.setAudioMuted(muted)` / `isAudioMuted()` / `isCurrentlyAudible()` 会更新 hosted audio state；`setAudioMuted()` 保持 void-return shape，sync getter 立即可读，targeted `audio-state-changed` 事件会同步 `event.audible` 和 boolean listener argument。
- [x] BrowserWindow handle 的 `setBounds()` / `setSize()` / `setPosition()` / `center()` 会派发宿主内 `resize` / `move` 几何事件，插件可通过 `on()` / `once()` 监听。
- [x] BrowserWindow handle 的 `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()` 会更新 hosted menu-bar state；setter/remove/setMenu 保持 void-return shape，sync getter 立即可读，`removeMenu()` 会隐藏并标记 removed，`setMenu(menu)` 会恢复非 null 菜单可见状态。
- [x] BrowserWindow handle 的 `setWindowButtonVisibility()` / `setWindowButtonPosition()` / `getWindowButtonPosition()` / `setVibrancy()` / `setBackgroundMaterial()` / `setSheetOffset()` 会更新 hosted macOS titlebar/material state；setter 保持 void-return shape，`getWindowButtonPosition()` sync getter 立即可读，`setWindowButtonPosition(null)` 会重置为系统默认 `null`。
- [x] BrowserWindow handle 的 `isNormal()` / `isModal()` / `setDocumentEdited()` / `isDocumentEdited()` / `setRepresentedFilename()` / `getRepresentedFilename()` / `setParentWindow()` / `getParentWindow()` / `getChildWindows()` 会更新 hosted document/parent state；document/representedFilename setter 保持 void-return shape，sync getter 立即可读，`setParentWindow(null)` 会清理 hosted parent/child 关系。
- [x] Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会自动验证 hosted child sandbox 为 `allow-scripts allow-popups` 且无 same-origin，并验证每个 child 独立 `MessageChannel` 的固定 RPC allowlist：`describe`、`webContents.executeJavaScript()`、`webContents.sendInputEvent()`、`webContents.insertCSS()`、`webContents.removeInsertedCSS()`、`webContents.findInPage()`、`webContents.stopFindInPage()`；`webContents.send()` / child `ipcRenderer` / `sendToParent()` 继续走受控消息通道。`webContents.inspectElement()`、`capturePage()`、`printToPDF()`、`savePage()`、12 个 edit API 和 4 个 selection/scroll API 共 20 个入口必须逐个返回 `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED`，`print()` 必须 callback 明确失败；最终要求 `data-browser-window-isolated-unsupported-complete="true"` 与 `data-browser-window-smoke-complete="true"`。
- [x] Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.loadURL()` / `reload()` / `stop()` / `isDestroyed()` / `getType()`，并记录 `data-browser-window-webcontents-load-url="true"`、`data-browser-window-webcontents-lifecycle="true"` 和 `data-browser-window-runtime-state="true"`；这些 supported lifecycle/state 标记必须与 `data-browser-window-isolated-unsupported-complete="true"` 的 20 个隔离拒绝、audio、zoom、DevTools、IPC、find-in-page、CSS insert/remove 和 always-on-top 证据同时成立，不再要求 fake capture/export、edit、inspect 或 selection/scroll 成功。
- [x] Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.isCrashed()` / `forcefullyCrashRenderer()` / targeted `render-process-gone`，并记录 `data-browser-window-render-process-gone="true"`、`data-browser-window-webcontents-crash="true"` 和 `data-browser-window-webcontents-crash-reload="true"`；这三项需和 `data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"` 及既有 BrowserWindow smoke 标记同时保持通过。
- [x] Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.focus()` / `isFocused()` / `getOwnerBrowserWindow()` / `getMediaSourceId()` / `isBeingCaptured()` / `setIgnoreMenuShortcuts()`，并记录 `data-browser-window-webcontents-focus-state="true"` 和 `data-browser-window-webcontents-owner-media="true"`；这两项需和 `data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"` 及既有 BrowserWindow smoke 标记同时保持通过。
- [x] Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.navigationHistory.goToOffset(-1)` / `goForward()` / `clear()`，并记录 `data-browser-window-navigation-history="true"`；这项需和 `data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"` 及既有 BrowserWindow smoke 标记同时保持通过。
- [x] Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.isWaitingForResponse()` 和 BrowserWindow `setBackgroundColor()` / `getBackgroundColor()`，并记录 `data-browser-window-webcontents-waiting-response="true"` 和 `data-browser-window-background-color="true"`；这两项需和 `data-browser-window-navigation-history="true"`、`data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"` 及既有 BrowserWindow smoke 标记同时保持通过。
- [x] Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 BrowserWindow `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()`，并记录 `data-browser-window-menu-bar-state="true"`；这项需和 `data-browser-window-background-color="true"`、`data-browser-window-webcontents-waiting-response="true"`、`data-browser-window-navigation-history="true"`、`data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"` 及既有 BrowserWindow smoke 标记同时保持通过。
- [x] Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 BrowserWindow `setWindowButtonVisibility()` / `setWindowButtonPosition()` / `getWindowButtonPosition()` / `setVibrancy()` / `setBackgroundMaterial()` / `setSheetOffset()`，并记录 `data-browser-window-titlebar-material-state="true"`；这项需和 `data-browser-window-menu-bar-state="true"`、`data-browser-window-background-color="true"`、`data-browser-window-webcontents-waiting-response="true"`、`data-browser-window-navigation-history="true"`、`data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"` 及既有 BrowserWindow smoke 标记同时保持通过。
- [x] Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 BrowserWindow `isNormal()` / `isModal()` / `setDocumentEdited()` / `isDocumentEdited()` / `setRepresentedFilename()` / `getRepresentedFilename()` / `setParentWindow()` / `getParentWindow()` / `getChildWindows()`，并记录 `data-browser-window-document-parent-state="true"` 和 `data-browser-window-parent-child-state="true"`；这项需和 `data-browser-window-titlebar-material-state="true"`、`data-browser-window-menu-bar-state="true"`、`data-browser-window-background-color="true"`、`data-browser-window-webcontents-waiting-response="true"`、`data-browser-window-navigation-history="true"`、`data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"` 及既有 BrowserWindow smoke 标记同时保持通过。
- [x] 插件宿主返回、iframe `__ipc_close__`、Web preview close 和 Svelte 销毁 fallback 会向插件 iframe 派发 `atools-plugin-out`，正常退出回调参数为 `isKill:false`，销毁 fallback 为 `isKill:true`，不会静默丢弃 `onPluginOut(callback)` 清理钩子。
- [x] 插件调用 `getCopyedFiles` / `getCopiedFiles` 时，插件侧返回官方 `CopiedFile[]` 对象形态，至少包含 `path`、`name`、`isFile`、`isDiractory`，而不是直接暴露宿主路径字符串数组。
- [x] 输入时间戳/日期后，插件输出列表可选，选中行显示 `Enter 复制`。
- [x] 插件 output 行右键会打开 `复制结果` 菜单；按 `Esc` 只关闭该菜单，不退出插件态，点击菜单项应复制当前行结果并显示既有复制反馈。
- [x] 插件 iframe 内右键不会被宿主 `preventDefault` 取消；宿主应收到 `contextmenu` 上报，并在运行状态条显示 `右键菜单` 与目标区域，例如 `iframe button`。
- [x] 插件运行态标题栏、subInput、iframe/output body 不互相覆盖；output layer 出现时不和 iframe 同时占位。
- [x] 搜索 `JSON`，JSON 插件能显示格式化结果或错误。
- [x] 搜索 `颜色`，颜色插件能输出转换结果。
- [x] 插件内点击返回后回到搜索。

ZTools 插件导入：

- [x] 打开导入面板。
- [x] 未扫描时显示 `等待扫描` 空态，不显示候选统计、候选行或报告行。
- [x] 选择本机 ZTools 插件目录。
- [x] 显示候选插件、候选/可导入/已选/警告/错误统计、warnings/errors、缺失标记、状态胶囊和 selected count。
- [x] 候选结果中不可导入项禁用 checkbox，可导入项支持 `全选可导入` 和 `清空选择`。
- [x] 导入报告显示成功、跳过、失败三类明细；失败项必须显示错误原因。
- [x] 导入后插件出现在插件管理列表。
- [x] 插件 feature 能被搜索。

已知限制：

- 插件 `showOpenDialog` / `showSaveDialog` 已接入 Tauri dialog；自动化 smoke 覆盖 no-side-effect guard，真实文件选择/保存面板的选择、取消和路径返回仍需人工插件交互验证。
- 插件 `setFeature` / `removeFeature` / `getFeatures` 已接入宿主内存态动态 registry；它提升运行态兼容性，但不替代导入后持久 feature 索引、搜索匹配和插件管理列表的人工回归。
- 插件 `redirectHotKeySetting(cmdLabel[, autocopy])` / `redirectAiModelsSetting()` 已接入当前主窗口宿主设置导航；WebView host 可打开本地 `快捷键` / `AI 模型` 设置页，但 API shim 中仍是 native-only unsupported，且不会替代 uTools 原生设置页中的全局快捷键绑定能力。
- 插件 `registerTool` 已接入宿主可见运行态计数；当前只覆盖注册可见性，不代表宿主已具备跨插件调用这些 handler 的调度能力。
- 插件 `setExpendHeight` / `setExpandHeight` 已接入宿主可见运行态高度请求并做 120-900px 限制；当前覆盖请求可见性和兼容 API，不替代真实桌面窗口尺寸变化的逐插件人工回归。
- 插件 `hideMainWindow` / `showMainWindow` 已接入宿主生命周期桥接并调用主窗口 native command；`hideMainWindow(isRestorePreWindow)` 接收兼容参数，但“恢复前一个窗口焦点”的系统级行为仍需人工回归。
- 插件 `getWindowType` / `findInPage` / `stopFindInPage` 已接入注入桥接与宿主消息路径；当前 PluginPanel 只支持 `main` 宿主窗口类型，`detach` / `browser` 仍需后续分离窗口能力。自动化覆盖 bridge API、host 静态路径和 Web 预览稳定性；由于 `?pluginHostSmoke=1` output layer 不渲染 iframe，真实 iframe 查找高亮和选区清理仍需具体插件桌面回归。
- 插件 `startDrag(filePath)` 已暴露官方窗口拖拽 API surface，并在当前 WebView host 下返回明确 method-scoped native-only unsupported；真实文件拖拽到外部窗口仍依赖后续 native host/window 支持和人工回归。
- 插件 output layer 已覆盖宿主结果行的右键 `复制结果` 菜单、复制 helper 复用和 `Esc` 不退出插件态；iframe 内 `contextmenu` 事件已通过注入桥上报宿主且不取消插件事件路径，但 native 右键菜单、插件自绘菜单完整交互和拖拽行为仍需真实插件专项回归。
- 插件 `isDarkColors()` 已接入 WebView 深色主题媒体查询，并在无 `matchMedia` 环境下返回安全布尔 fallback；Rust local-only API shim 当前返回 light-theme fallback，不等同真实桌面主题监听或跨窗口主题同步。
- 插件 `redirect(label, payload)` 已接入当前主窗口 host 的唯一 feature 搜索/激活路径；插件市场远程 ZIP 安装/更新已接入，但市场搜索多结果选择器、分离窗口和 browser 窗口路由仍未实现，歧义或找不到目标时会返回明确错误。
- 插件 `createBrowserWindow(url, options, callback)` / `sendToParent(channel, ...args)` 已从固定 unsupported 推进到当前 PluginPanel 宿主内的受控 browser-window 子 iframe：子窗口内 `getWindowType()` 返回 `browserWindow`，`sendToParent` 会回调父插件 iframe 的 create callback，返回 handle 的 `show()` / `hide()` / `focus()` / `close()` / `isDestroyed()` 会更新宿主内子窗口可见、聚焦和销毁状态，`getBounds()` / `setBounds()` / `getSize()` / `setSize()` / `getPosition()` / `setPosition()` / `center()` 会更新宿主内子窗口尺寸和位置；真实系统级独立 BrowserWindow、外部焦点、生命周期事件和跨窗口资源兼容仍需后续 native window host 支持。
- 插件 BrowserWindow hosted `webContents.send(channel, ...args)` 已可投递到对应子 iframe 的最小 `ipcRenderer.on()` / `once()` 监听表面；hosted `webContents.executeJavaScript(code[, userGesture])` 已可在对应子 iframe `contentWindow` 中执行脚本并回传 Promise 结果；hosted `webContents.sendInputEvent(inputEvent)` 已可向对应子 iframe 文档派发兼容 DOM 键盘、鼠标和滚轮事件；hosted `webContents.insertCSS(css[, options])` / `removeInsertedCSS(key)` 已可在对应子 iframe 文档 keyed 注入和移除 `<style>`；hosted `webContents.findInPage(text[, options])` / `stopFindInPage(action)` 已可在对应子 iframe 文档文本上返回 request id、派发 targeted `found-in-page` final event 并停止查找路径；hosted `webContents.getURL()` / `getTitle()` / `isLoading()` / `isLoadingMainFrame()` / `canGoBack()` / `canGoForward()` 已可同步读取 URL/title/loading/history 状态，`reloadIgnoringCache()` / `goBack()` / `goForward()` 已可路由到当前 hosted history；hosted `webContents.openDevTools()` / `closeDevTools()` / `toggleDevTools()` / `isDevToolsOpened()` / `isDevToolsFocused()` 已可维护 DevTools open/focus 状态并派发 targeted opened/closed 事件；hosted `webContents.inspectElement(x, y)` 已可打开/聚焦 hosted DevTools state 并记录元素摘要；hosted `webContents.capturePage()` / `print()` / `printToPDF()` / `savePage()` 已可覆盖 hosted snapshot、明确 print failure callback、minimal PDF bytes 和 page serialization/save path；hosted `webContents.insertText()` 和 editing commands 已可编辑 focused child iframe editable target，并使用 hosted 本地 edit clipboard 覆盖 copy/cut/paste；hosted `webContents.centerSelection()` / `scrollToTop()` / `scrollToBottom()` / `adjustSelection()` 已可控制 child iframe 文档滚动和 focused editable selection；hosted `webContents.setZoomFactor()` / `getZoomFactor()` / `setZoomLevel()` / `getZoomLevel()` / `setVisualZoomLevelLimits()` 已可维护 zoom factor/level/visual limits 状态并以 child iframe CSS scale 呈现；hosted `webContents.setAudioMuted()` / `isAudioMuted()` / `isCurrentlyAudible()` 已可维护 muted/audible 状态并兼容 targeted `audio-state-changed` 事件；当前不等同完整 Electron WebContents，不包含 isolated world、Chromium raster capture/full-page capture、Chromium session history、真实 Chromium DevTools window/dock UI/protocol attachment、Chromium 原生 page zoom/pinch zoom pipeline、完整 Chromium media audibility pipeline、系统打印、完整 Chromium PDF pipeline、跨进程 frame routing、原生 CSS cascade origin、真实 cache 策略或 OS 级真实输入注入等能力。
- BrowserWindow hosted `webContents.loadURL()` / `reload()` / `stop()` / `isDestroyed()` / `getType()` 已接入当前 hosted child iframe navigation/lifecycle 兼容层；`loadURL()` / `reload()` 更新 hosted iframe 内容和 hosted history，`stop()` 只同步清理 hosted loading state 并不取消真实 Chromium network navigation，`isDestroyed()` 反映当前 hosted handle destroyed state，`getType()` 固定返回当前宿主内 `"window"` 类型，不等同完整 Electron WebContents type matrix。
- BrowserWindow hosted `webContents.isCrashed()` / `forcefullyCrashRenderer()` 已接入当前 hosted child iframe crash lifecycle 兼容层；`forcefullyCrashRenderer()` 只维护 hosted crash cache 并派发 targeted `render-process-gone` compatibility event，不会终止真实 Chromium renderer，details 固定为 `{ reason: "crashed", exitCode: 1 }`，不等同完整 Electron/Chromium renderer crash semantics。
- BrowserWindow hosted `webContents.focus()` / `isFocused()` / `getOwnerBrowserWindow()` / `getMediaSourceId()` / `isBeingCaptured()` / `setIgnoreMenuShortcuts()` 已接入当前 hosted child iframe focus/owner/media/shortcut 兼容层；`focus()` 只维护 hosted focus cache 并同步宿主内 focus 事件，不等同 OS 级 native focus，`getMediaSourceId()` 返回 hosted compatibility id，不等同真实 DesktopCapturerSource，`isBeingCaptured()` 不跟踪真实 tab capture，`setIgnoreMenuShortcuts()` 只维护 hosted shortcut state，不接入 native app menu shortcut pipeline。
- BrowserWindow hosted `webContents.navigationHistory` 已接入当前 hosted child iframe navigation history 兼容层；`canGoBack()` / `canGoForward()` / `canGoToOffset()` 只读取 hosted history array，`goBack()` / `goForward()` / `goToIndex()` / `goToOffset()` 只导航当前 hosted child iframe，`clear()` 只把当前 hosted history 折叠到当前 entry，不等同完整 Chromium session history、真实 WebView 历史清理或 cache 清理。
- BrowserWindow hosted `webContents.isWaitingForResponse()` 已接入当前 hosted child iframe loading/waiting cache；它只反映 hosted `loadURL()` / `reload()` 兼容路径中的等待响应阶段，不等同真实 Chromium network first-response tracking、跨 frame navigation wait state 或底层 WebView 网络栈。
- BrowserWindow hosted `setBackgroundColor()` / `getBackgroundColor()` 已接入当前 hosted child-window shell background state；当前只维护 CSS background 和 `#RRGGBB` getter cache，不等同 native transparent window、alpha compositor、vibrancy、材质背景或 OS 级窗口背景合成。
- BrowserWindow hosted `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()` 已接入当前 hosted child-window menu-bar state；当前只维护 auto-hide、visible、removed cache，不等同 Windows/Linux native menu bar、Alt 键唤起、Electron `Menu` object 渲染、accelerator、role item、application menu 或 OS 级菜单事件。
- BrowserWindow hosted `setWindowButtonVisibility()` / `setWindowButtonPosition()` / `getWindowButtonPosition()` / `setVibrancy()` / `setBackgroundMaterial()` / `setSheetOffset()` 已接入当前 hosted child-window titlebar/material state；当前只维护 window-button visibility/position、vibrancy、background material 和 sheet offset cache，不等同 native macOS traffic lights、NSVisualEffectView vibrancy、WindowServer material/compositor 或真实 sheet attachment point。
- BrowserWindow hosted `isNormal()` / `isModal()` / `setDocumentEdited()` / `isDocumentEdited()` / `setRepresentedFilename()` / `getRepresentedFilename()` / `setParentWindow()` / `getParentWindow()` / `getChildWindows()` 已接入当前 hosted child-window document/parent state；当前只维护 hosted normal/modal/document/represented-filename cache 和同宿主内 BrowserWindow handle 关系，不等同 native macOS document proxy icon、dirty-dot integration、sheet/modal session、NSWindow parent/child lifetime 或系统级窗口层级销毁语义。
- 插件 BrowserWindow handle 的 `isVisible()` / `isFocused()` / `showInactive()` / `blur()` / `getTitle()` / `setTitle()` / `isAlwaysOnTop()` / `setAlwaysOnTop()` / `getURL()` / `loadURL()` / `reload()` / `minimize()` / `isMinimized()` / `restore()` / `maximize()` / `unmaximize()` / `isMaximized()` / `on()` / `addListener()` / `once()` / `off()` / `removeListener()` / `removeAllListeners()` / `getContentSize()` / `setContentSize()` / `getMinimumSize()` / `setMinimumSize()` / `getMaximumSize()` / `setMaximumSize()` / `setAspectRatio()` / `isResizable()` / `setResizable()` / `isMovable()` / `setMovable()` / `isClosable()` / `setClosable()` / `isMinimizable()` / `setMinimizable()` / `isMaximizable()` / `setMaximizable()` / `isFullScreen()` / `setFullScreen()` / `isFullScreenable()` / `setFullScreenable()` / `getOpacity()` / `setOpacity()` / `hasShadow()` / `setHasShadow()` / `invalidateShadow()` / `setSkipTaskbar()` / `setKiosk()` / `isKiosk()` / `setVisibleOnAllWorkspaces()` / `isVisibleOnAllWorkspaces()` / `setContentProtection()` / `isContentProtected()` / `setFocusable()` / `isFocusable()` / `flashFrame()` / `setProgressBar()` / `getMediaSourceId()` / `moveTop()` / `moveAbove()` / `webContents.send()` / `webContents.executeJavaScript()` / `webContents.sendInputEvent()` / `webContents.insertCSS()` / `webContents.removeInsertedCSS()` / `webContents.findInPage()` / `webContents.stopFindInPage()` / `webContents.getURL()` / `webContents.getTitle()` / `webContents.isLoading()` / `webContents.isLoadingMainFrame()` / `webContents.canGoBack()` / `webContents.canGoForward()` / `webContents.reloadIgnoringCache()` / `webContents.goBack()` / `webContents.goForward()` / `webContents.openDevTools()` / `webContents.closeDevTools()` / `webContents.toggleDevTools()` / `webContents.isDevToolsOpened()` / `webContents.isDevToolsFocused()` / `webContents.inspectElement()` / `webContents.capturePage()` / `webContents.print()` / `webContents.printToPDF()` / `webContents.savePage()` / `webContents.getUserAgent()` / `webContents.setUserAgent()` / `webContents.getFrameRate()` / `webContents.setFrameRate()` / `webContents.getBackgroundThrottling()` / `webContents.setBackgroundThrottling()` / `webContents.getProcessId()` / `webContents.getOSProcessId()` / `webContents.insertText()` / `webContents.undo()` / `webContents.redo()` / `webContents.cut()` / `webContents.copy()` / `webContents.paste()` / `webContents.pasteAndMatchStyle()` / `webContents.delete()` / `webContents.selectAll()` / `webContents.unselect()` / `webContents.replace()` / `webContents.replaceMisspelling()` / `webContents.centerSelection()` / `webContents.scrollToTop()` / `webContents.scrollToBottom()` / `webContents.adjustSelection()` / `webContents.setZoomFactor()` / `webContents.getZoomFactor()` / `webContents.setZoomLevel()` / `webContents.getZoomLevel()` / `webContents.setVisualZoomLevelLimits()` / `webContents.setAudioMuted()` / `webContents.isAudioMuted()` / `webContents.isCurrentlyAudible()` 已接入当前 PluginPanel 宿主内状态；其中 `setAlwaysOnTop()` 只代表宿主内子窗口层级和 class，不等同系统级 native always-on-top，`loadURL()` / `reload()` / `reloadIgnoringCache()` / `goBack()` / `goForward()` 只更新宿主内子 iframe 内容、URL 状态和 hosted history，不等同系统级 native BrowserWindow 导航栈或 Chromium session history，`webContents.openDevTools()` / `closeDevTools()` / `toggleDevTools()` 只维护 hosted DevTools state 和事件，不打开真实 DevTools 窗口或 dock UI，`webContents.inspectElement()` 只维护 hosted DevTools state 和元素摘要，不打开真实 Chromium inspect UI、元素高亮 overlay 或 protocol attachment，`webContents.capturePage()` 只返回 hosted SVG snapshot data URL，不等同 Chromium raster capture 或 full-page capture，`webContents.print()` 只返回明确 hosted native-only failure callback，不等同系统打印，`webContents.printToPDF()` 只生成 minimal PDF compatibility bytes，不等同完整 Chromium PDF pipeline，`webContents.savePage()` 只序列化 child iframe document 并受 Tauri FS scope 限制，不等同 Electron 完整 HTMLComplete asset save，`webContents.getUserAgent()` / `setUserAgent()`、`getFrameRate()` / `setFrameRate()`、`getBackgroundThrottling()` / `setBackgroundThrottling()` 只维护 hosted runtime state cache，`getProcessId()` / `getOSProcessId()` 返回 hosted compatibility ids，不等同真实 Electron renderer 或 OS process identity，`webContents.insertText()` 和 editing commands 只编辑 focused hosted editable target 并使用 hosted 本地 edit clipboard，不等同 Chromium 完整 editing stack、系统剪贴板、IME、spellchecker 或真实 undo/redo history，`webContents.centerSelection()` / `scrollToTop()` / `scrollToBottom()` / `adjustSelection()` 只控制 child iframe DOM scroll 和 focused editable selection，不等同 Chromium 完整 selection pipeline、native scroll integration 或跨进程 frame routing，`webContents.setZoomFactor()` / `setZoomLevel()` / `setVisualZoomLevelLimits()` 只维护 hosted zoom state 并通过 child iframe CSS scale 呈现，不等同 Chromium 原生 page zoom/pinch zoom pipeline，`webContents.setAudioMuted()` / `isAudioMuted()` / `isCurrentlyAudible()` 只维护 hosted muted/audible cache 和 targeted event 兼容，不等同 Chromium 完整媒体播放或 native media audibility pipeline，`webContents.sendInputEvent()` 只派发 child iframe DOM 事件，不等同 OS 级键鼠输入、IME 或完整 Electron input pipeline，`webContents.insertCSS()` / `removeInsertedCSS()` 只在 child iframe DOM 中 keyed 插入/移除 `<style>`，不等同 Chromium 原生 user/author origin 或跨 frame CSS 注入，`webContents.findInPage()` / `stopFindInPage()` 只在 child iframe 文档文本中计算 matches 并派发 targeted `found-in-page`，不等同 Chromium 原生查找 UI、高亮、滚动或跨 frame 搜索，`minimize()` / `maximize()` / `restore()` 只更新宿主内 shell 折叠/填满/恢复状态，不等同系统级窗口管理，`setContentSize()` / `setMinimumSize()` / `setMaximumSize()` / `setAspectRatio()` 只影响宿主内 content-size/min-max/aspect-ratio 兼容状态，不等同 OS 级 native content bounds、window chrome 或用户拖拽 aspect-ratio 约束，capability flags 只表示宿主内壳层能力状态，`setFullScreen()` 只切换宿主内 full-screen class/layout 并派发 hosted `enter-full-screen` / `leave-full-screen`，不等同 OS 级 native fullscreen，`fullScreenable` 也只是宿主内能力开关，`setOpacity()` / `setHasShadow()` / `invalidateShadow()` 只影响宿主内 CSS opacity/shadow class，不等同 OS 级 native window opacity、阴影重算或透明窗口合成，`setSkipTaskbar()` / `setKiosk()` / `setVisibleOnAllWorkspaces()` / `setContentProtection()` 只影响宿主内 system-state，不等同 OS 级 taskbar、kiosk、workspace 或 screen-capture protection，`setFocusable()` 只影响当前 hosted shell 的后续聚焦状态，不等同 OS 级 focusability，`flashFrame()` / `setProgressBar()` 只影响 hosted shell class/progress strip，不等同 Dock/taskbar 原生闪烁或进度，`getMediaSourceId()` 返回 hosted 兼容 source id，`moveTop()` / `moveAbove()` 只影响 hosted z-index，不等同 DesktopCapturerSource 或 OS 级 native z-order，`setBounds()` / `setSize()` / `setPosition()` / `center()` 会派发宿主内 `resize` / `move` 几何事件，但事件监听只覆盖当前宿主内 action/lifecycle/geometry/full-screen/appearance/system-state/focus-attention-progress/z-order 事件，不等同 OS 级完整 native BrowserWindow 事件流。
- 插件 `getNativeId` / `getAppName` / `getAppVersion` / `isDev` / `isMacOS` / `isWindows` / `isLinux` 已接入同步系统身份桥接；`getNativeId` 当前是 ATools 本地稳定兼容 ID，优先持久化到 WebView `localStorage`，不可用时退回 iframe 内存态，不等同 uTools/Electron 的真实硬件或账号级设备 ID。
- 插件 `getFileIcon(filePath)` 当前 WebView/API shim 返回 ATools SVG fallback，不是真实 Finder/system icon；`shellTrashItem(path)` 在主 WebView host 下使用 Finder move-to-Trash AppleScript，空路径会返回明确错误，Rust/API shim 仍保持 native-only unsupported；`shellBeep()` 在 WebView host 下使用 AppleScript beep，API shim 仍保持 native-only unsupported。
- 插件 `getUser` / `fetchUserServerTemporaryToken` 已暴露官方用户 API surface；当前 ATools 不接入 uTools 账号会话，`getUser()` 返回 `null` 表示未登录/本地-only，临时 token API 返回明确 method-scoped unsupported，不生成假 token。
- 插件入口 HTML 资源准备已接入：本地 `<script src>`、stylesheet link、CSS `url(...)` / 字符串 `@import`、`srcset`、link icon/modulepreload 和常见图片/媒体 URL 会按 `main_url` 所在目录解析并转换为 WebView 可加载资源；入口 HTML 本地 `<base href>` 会把静态资源解析切到声明 base 目录，将 base 自身改写为 WebView 可加载 asset URL，并保留原始本地 href marker 供运行时读取；external/data/protocol/hash-only URL 保持原样。插件运行时资源桥已覆盖常见动态节点的 `src`、`poster`、`srcset`、`href`、`data` 属性、`<style>` 文本、inline `style` CSS、`CSSStyleSheet.insertRule()` CSS，以及本地动态 script/link 通过 `appendChild` / `insertBefore` / `append` / `prepend` / `before` / `after` / `replaceWith` 插入前资源 preflight；存在当前本地 `<base href>` marker 时，运行时动态资源会按声明 base 目录而非只按 `main_url` 目录解析；插件运行中把 `<base href>` 改成新的本地目录时，后续资源请求会优先使用 live href，再回退到静态 marker。完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需桌面专项回归。
- 插件 `hideMainWindowPasteText(text)` 已在当前 WebView host 下接入文本剪贴板写入、主窗口隐藏和 macOS Command+V 粘贴路径；`hideMainWindowPasteImage(image)` 已接入图片路径或 data URL 图片剪贴板写入、主窗口隐藏和 macOS Command+V 粘贴路径；`hideMainWindowPasteFile(file)` 已接入单个或多个文件路径剪贴板写入、主窗口隐藏和 macOS Command+V 粘贴路径；`hideMainWindowTypeString(text)` 已在当前 WebView host 下接入主窗口隐藏和 System Events `keystroke` 直接输入路径；这些外部输入能力都依赖系统辅助功能/自动化权限和前台焦点，失败时会返回 method-scoped 错误。图片/文件粘贴的真实目标应用兼容性仍需具体插件和目标应用人工回归。
- 插件 `screenCapture(callback)` 已按官方 callback 形态接入，并通过 Tauri `screen_capture` 命令返回 `data:image/png;base64,...`；自动化 smoke 仍会走 no-side-effect guard，避免启动交互截图 UI。`screenColorPick(callback)` 当前已接入 WebView EyeDropper 兼容路径，支持时返回 `{ hex, rgb }`，缺少 EyeDropper 或结果非法时返回明确 `screenColorPick unavailable`；它仍不等同 Electron/uTools 原生跨窗口取色器，真实系统级取色体验需具体 WebView 能力和人工回归确认。`desktopCaptureSources(options)` 当前返回 primary screen 兼容源列表，`types:["window"]` 返回空列表，不等同 Electron desktopCapturer 窗口源枚举。
- 插件屏幕显示器读取和 DIP/屏幕坐标转换 API 已接入 WebView 兼容实现；显示器信息基于 `window.screen` 和 `devicePixelRatio`，`getCursorScreenPoint` 返回插件 iframe 最近一次 mousemove 的屏幕坐标，当前不等同 Electron 原生 screen 模块的多显示器完整拓扑或全局鼠标轮询。
- 插件 `onMainPush(callback, onSelect)` / `onPluginDetach(callback)` / `onPluginOut(callback)` 已接入注入桥接事件表面；自动化覆盖 iframe bridge 注册、主推送结果回传、选择回调、标题栏 `分离` 对 `onPluginDetach` 的派发，以及宿主返回/iframe close/Web preview close/onDestroy 对 `onPluginOut` 的 `isKill:false/true` 派发。真实主搜索推送触发、独立分离窗口创建和 `getWindowType() === "detach"` 仍需后续 host 集成或人工回归。
- 插件 `onDbPull` 已接入注入桥接的注册与宿主 `__ipc_db_pull__` 消息派发路径；自动化覆盖 iframe bridge 行为，真实 uTools 云同步拉取触发仍需桌面集成或多设备人工回归。
- 插件 `db.getAttachmentType` 已接入注入桥接的附件元数据读取路径；`db.replicateStateFromCloud` 在 ATools 本地-only 插件 DB 下返回 `null` 表示未开启 uTools 云同步，不代表已接入多设备云同步。
- 插件 `dbStorage` 已接入同步 key/value 桥接，并按插件 ID 命名空间写入 WebView `localStorage`，不可用时退回 iframe 内存态；它覆盖常见插件配置读写兼容性，但不等同 uTools 本地数据库或云同步持久层。
- 插件 `removeSubInput` 已接入宿主输入区移除路径；自动化覆盖 Web 预览宿主消息路径，真实桌面 WebView 中由具体插件触发后的焦点恢复仍需人工回归。
- 插件 `subInputFocus` / `subInputBlur` / `subInputSelect` 已接入宿主焦点和文本选中切换；自动化覆盖 Web 预览宿主消息路径，真实桌面 WebView 焦点和选区行为仍需随具体插件人工回归。
- `readCurrentBrowserUrl` / `getCurrentBrowserUrl` / `readCurrentFolderPath` 已接入插件 iframe native bridge，`getCurrentBrowserUrl` 已同步到共享运行状态能力清单；插件侧 VM 回归覆盖 bridge 调用与结果回传，命令层由自动化 desktop smoke 覆盖：必须返回真实值、明确空结果或明确平台/osascript 错误，不能静默假成功；更完整的浏览器兼容和权限引导仍可增强。
- `shellShowItemInFolder` 的缺失路径错误已由自动化 desktop smoke 覆盖：必须返回带 API 方法名的明确错误，不能只暴露底层 `open` 或静默成功。
- `getCopyedFiles` / `getCopiedFiles` 的插件侧返回值已归一化为官方 `CopiedFile[]` 对象形态（`path` / `name` / `isFile` / `isDiractory`）；当底层宿主只返回路径字符串时，目录判断仅基于已有对象字段或路径尾部斜杠做 best-effort 推断。命令层只读文件列表仍由自动化 desktop smoke 覆盖：必须返回真实路径列表、空列表或带 API 方法名的明确错误，不能静默假成功。
- `screenCapture` 的自动化 smoke 路径已覆盖：`ATOOLS_DESKTOP_SMOKE` 下必须返回明确 no-side-effect guard，不启动交互截图 UI；真实截图权限和交互行为仍需人工验证。
- `copyFile` / `copyImage` 的缺失路径错误已由自动化 desktop smoke 覆盖；`simulateKeyboardTap` 已接入宿主明确 unsupported 错误，避免键盘模拟静默假成功；其他高风险 native bridge API 目前仍应返回明确 unsupported/error，不能静默成功。

## 5. MCP / Agent Smoke

启动 app 后检查：

- [x] Agent/MCP 页面显示 MCP bind 地址、脱敏 token、推荐连接方式和 token 安全提示，不直接展示完整 token。
- [x] Agent/MCP 页面可复制 HTTP MCP 配置和 stdio proxy 配置。
- [x] Agent/MCP 页面可分别复制 `通用 HTTP MCP`、`通用 stdio proxy`、`Claude Desktop / Claude Code`、`Cursor` 模板。
- [x] Agent/MCP 页面每个客户端模板显示目标配置位置、合并步骤和 `可安全合并` 状态，并提供 `复制` 与 `合并到文件...` 操作。
- [x] Agent/MCP 页面已知客户端模板显示建议目标路径：Claude Desktop 为 `~/Library/Application Support/Claude/claude_desktop_config.json`，Cursor 全局配置为 `~/.cursor/mcp.json`。
- [x] Agent/MCP 页面点击 `合并到文件...` 必须先弹出目标 JSON 文件选择；取消选择时不写入，选择已有 JSON 时写入前生成同目录 `*.atools-backup-*`，且只替换或新增 `mcpServers.atools`。
- [x] 设置页 `MCP 服务` 显示脱敏 token、推荐连接方式和 token 安全提示，可复制 MCP 客户端配置。
- [x] 设置页 `MCP 服务` 首屏显示 `MCP 治理概览`，包含 `工具白名单`、`默认权限`、`高风险 Scope`、`待确认请求` 4 张概览卡。
- [x] 设置页 `MCP 服务` 显示 `本地审计链路`，明确 Agent 工具调用会经过权限策略并记录输入输出、权限结果、路径和副作用。
- [x] 设置页 `MCP 服务` 显示 `权限策略`，包含 `权限模式` 下拉和全部 scope 策略行。
- [x] 设置页 `MCP 服务` 的 scope 策略行显示 scope 名称、说明、scope code、`高风险` 标记，以及 `确认` / `阻断` 控制；切换后概览中的高风险阻断数量同步变化。
- [x] 设置页 `MCP 服务` 显示 `待确认请求`，保守确认模式下 pending request 可在这里 `允许一次`、`允许并记住` 或 `拒绝`。
- [x] 设置页 `MCP 服务` 显示 `持久授权`，允许查看客户端/工具授权，并支持 `撤销`。
- [x] 设置页 `MCP 服务` 显示 `最近调用审计`，最近 MCP/Agent 调用记录展示工具、客户端、状态、耗时和简短结果/错误预览。
- [x] 设置页 `MCP 服务` 的 `最近调用审计` 提供 `打开我的数据`，可跳转到完整本地数据/审计概览。
- [x] 设置页 `MCP 服务` 可分别复制上述客户端模板。
- [x] 设置页 `MCP 服务` 每个客户端模板显示目标配置位置、合并步骤和 `可安全合并` 状态，并提供 `复制` 与 `合并到文件...` 操作。
- [x] 设置页 `MCP 服务` 已知客户端模板显示建议目标路径，并在桌面端文件选择器中默认指向该路径。
- [x] 设置页 `MCP 服务` 的配置合并写入必须保留其他 `mcpServers` 和顶层字段；遇到无效 JSON 或非对象 `mcpServers` 时显示错误，不覆盖原文件。
- [x] 设置页 `我的数据` 首屏显示 `数据概览`，包含设置数据、最近使用、剪贴板历史、审计记录、插件数据 5 张概览卡。
- [x] 设置页 `我的数据` 显示 `本地隐私边界`，明确这些数据默认保存在本机，且 `Agent 只能通过授权工具读取` 并写入本地审计。
- [x] 设置页 `我的数据` 显示 `审计数据概览`；无审计时显示空状态，有记录时显示状态分布、Top 工具/客户端、最近记录和异常记录。
- [x] 工具白名单至少显示默认 8 个内置工具，并包含 `ask_ai_model`。
- [x] 已启用插件的 manifest `tools` 会以 `plugin_<plugin>_<tool>` 形式出现在工具白名单中，默认关闭；用户打开后才进入 MCP `tools/list`，插件禁用或卸载后对应工具会从白名单移除。
- [x] 已启用且授权后的插件 manifest tool 会调用插件注册的同步或异步 handler；异步 handler 可 await `utools.dbStorage` 等插件 IPC API；插件 UI/runtime context 未打开时会按 manifest `preload` 懒加载后重试；越界 preload 路径、未注册 handler、Promise rejection 或超时返回明确错误；真实第三方兼容和更多客户端实测仍需回归。
- [x] `ask_ai_model` 显示 `network` scope；保守确认模式下调用会先进入权限确认，不应静默发送 prompt。
- [x] `ask_ai_model` 调用成功后审计记录可见 prompt 和模型输出，但不展示 AI API Key。
- [x] `find_local_files` 支持 `ignore_dirs`、`max_depth`、权限错误跳过统计，以及 `ignore_patterns` 通配忽略；`*.tmp` 应忽略文件名，`generated/**` 应跳过相对路径子树。
- [x] 权限模式默认是 `保守确认`。
- [x] 权限区显示所有 scope，支持将高风险 scope 设为 `阻断`，再恢复为 `确认`。
- [x] 将 `执行命令(shell)` 设为阻断后，`open_or_reveal_path` 即使在开发者宽松模式下也被拒绝并写入 denied audit。
- [x] 工具开关能保存。
- [x] 审计列表可刷新、清空、导出 JSONL 到剪贴板。
- [x] 设置页 `我的数据` 显示 `审计保留策略`，可按 90 天 / 最新 1000 条策略调用原生 `prune_audit_entries` 清理旧审计记录；清理前必须经过页内确认弹窗，不能直接删除。
- [x] 设置页 `我的数据` 可将审计记录归档到用户选择的 JSONL 文件；文件名默认包含 `atools-audit-archive`，写入需经过原生 `archive_audit_entries_jsonl` 的确认参数。
- [x] 审计列表支持按关键字、状态、工具、客户端筛选；筛选摘要显示当前匹配数量。
- [x] 审计列表显示 `已加载 x / y 条`；当匹配审计超过首屏页大小时显示 `加载更多`，点击后追加下一页且不清空当前筛选。
- [x] 审计筛选可保存为命名视图；选择已保存视图后可应用 query/status/tool/client，删除后不再出现在 `已保存视图` 下拉，刷新页面后保存结果仍保留。
- [x] 审计列表设置关键字/状态/工具/客户端筛选后，点击“导出”只导出当前筛选结果，成功提示包含“当前筛选”。
- [x] 搜索路径、错误文案或参数片段时能命中对应审计；没有匹配时显示空结果提示。
- [x] 展开审计记录后显示 `回放摘要`，包含权限结果、执行模式、本地副作用、执行结果。
- [x] `rename_files`、`compress_images` 审计详情显示 `副作用 diff`，能看出执行/计划状态和 before -> after。
- [x] 图片压缩审计的 `副作用 diff` 显示原始大小、输出大小和减少比例。
- [x] `compress_images` 传入 `max_bytes` 时返回 `target_size`、`target_met`、`compression_ratio`；未达标时状态为 `target_unmet`，审计 `副作用 diff` 显示目标未达标。
- [x] `compress_images` 传入 `format:"webp"` 时输出 `compressed-<stem>.webp`，结果项包含 `format:"webp"`、WebP 文件魔数和原始/输出大小；当前 WebP 为 lossless 编码，不做有损质量调节。
- [x] `get_current_context` 返回 `browser_url` 字段；若当前没有受支持的前台浏览器 URL，则 `browser_url_reason` 必须是明确不可用或 bridge 错误原因，不能包含 `not implemented`。
- [x] `get_current_context` 返回 `finder_path` 字段；其语义应与 `read_current_folder_path` 命令层 bridge 一致，没有 Finder 窗口时应返回 Desktop fallback 或明确 bridge 错误原因，不能返回旧的“无 Finder 窗口所以无路径”占位。
- [x] `rename_files` / `compress_images` / `open_or_reveal_path` 记录在详情中显示 `路径副作用`，源路径、目标路径和状态不被截断到不可读。
- [x] `保守确认` 模式下调用需要权限的工具时，能创建 pending request，并在拒绝/关闭后写入 denied audit。
- [x] 权限确认弹窗显示客户端、工具名、scope、执行模式和关键参数。
- [x] `rename_files` 等带 `dry_run=true` 的调用显示 `dry-run 预览`，不会被误标成直接执行。
- [x] 文件类调用在弹窗中显示 `涉及路径`，路径列表能横向滚动或换行，不遮挡操作按钮。
- [x] `shell`、`file_write`、`system_settings` 等高/中风险 scope 在弹窗中显示明确风险提示。

自动化桌面 smoke：

```bash
pnpm smoke:tauri-desktop
```

期望输出中的 `permission_smoke` 为：

```json
{
  "permission_required": true,
  "pending_request_created": true,
  "audit_denied_recorded": true,
  "pending_request_dismissed": true,
  "scope_deny_overrides_developer": true,
  "scope_deny_audit_recorded": true,
  "tool_toggle_persisted": true,
  "tool_toggle_restored": true,
  "cleanup_deleted_audits": 2
}
```

说明：该 smoke 使用唯一 client id 调用 `find_local_files` 的 dry-run 参数验证保守确认、pending request、denied audit 和清理链路；随后临时切到 developer mode 并阻断 `shell` scope，调用 `open_or_reveal_path` 验证高风险 scope 阻断优先于开发者模式且写入 denied audit；还会临时翻转 `search_clipboard` 工具启用状态并验证持久化和恢复。上述检查不执行真实文件扫描或打开路径副作用，并会恢复原 permission mode / scope policy / tool enabled 状态、删除临时审计记录。

期望输出中的 `plugin_runtime_smoke` 为：

```json
{
  "feature_activated": true,
  "sample_plugin_id": "任意已索引插件 id",
  "sample_plugin_name": "任意已索引插件名称",
  "sample_feature_code": "任意已索引 feature code",
  "main_url": "index.html",
  "main_exists": true,
  "plugin_path_exists": true,
  "expand_height_valid": true,
  "preload_checked": true,
  "data_bridge_checked": true,
  "data_roundtrip_checked": true,
  "bulk_docs_checked": true,
  "attachment_checked": true,
  "data_cleanup_checked": true,
  "native_bridge_checked": true,
  "dialog_guard_checked": true,
  "system_path_checked": true,
  "shell_target_checked": true,
  "context_bridge_checked": true,
  "browser_context_checked": true,
  "finder_context_checked": true,
  "shell_show_item_error_checked": true,
  "copied_files_read_checked": true,
  "screen_capture_guard_checked": true,
  "native_error_checked": true,
  "copy_file_error_checked": true,
  "copy_image_error_checked": true,
  "calculator_search_enter_checked": true,
  "timestamp_search_enter_checked": true
}
```

说明：该 smoke 从真实桌面数据库中选择一个可用插件 feature，验证 feature lookup、插件目录、入口 HTML、声明的 preload 文件、ZTools 插件窗口高度上限、插件数据文档读写、bulkDocs、attachment 读回、临时数据清理、`计算`/`calculator` 搜索进入计算器、`时间戳` 搜索进入时间戳，以及无副作用 native bridge 基线（dialog open/save 自动化 no-side-effect guard、系统路径查询、shell-open 目标分类、browser/Finder context 读取返回形态、getCopyedFiles 命令层只读文件列表返回形态、screenCapture 自动化 no-side-effect guard、shellShowItemInFolder/copyFile/copyImage 缺失路径明确报错）。它不替代 JSON/颜色等其它插件的人工交互 smoke，后者仍需验证输出列表、插件侧 `CopiedFile[]` 对象细节、真实 dialog 选择/取消、真实截图权限和插件内 UI 行为。

期望输出中的 `data_debug_smoke` 为：

```json
{
  "runtime_diagnostics_ready": true,
  "clipboard_export_json_valid": true,
  "audit_export_jsonl_valid": true,
  "audit_filtered_export_checked": true,
  "audit_filtered_export_count_checked": true,
  "crash_log_readable": true,
  "mcp_status_consistent": true,
  "mcp_ping_ok": true,
  "mcp_initialized_notification_ok": true,
  "mcp_discovery_lists_ok": true,
  "mcp_resources_ok": true,
  "mcp_prompts_ok": true,
  "mcp_batch_ok": true,
  "mcp_notification_ok": true
}
```

说明：该 smoke 读取运行诊断、剪贴板历史导出 JSON、审计导出 JSONL 和崩溃日志列表；filtered audit export 会写入唯一临时审计记录并按 client/tool/status/query 导出匹配结果，随后删除这些临时审计记录，不清空或改写用户真实数据。MCP protocol smoke 会通过真实 HTTP `/mcp` 请求验证 `ping`、`notifications/initialized`、空 resource templates discovery、内置 resource catalog / `resources/read`、内置 prompt catalog / `prompts/get`、混合 JSON-RPC batch 中 request 有响应/notification 无响应，以及 id-less `tools/call` notification 返回 `204 No Content` 且不静默执行工具的行为。

设置页 `调试日志` 手动复制诊断包时，应确认：

- `kind` 为 `atools_diagnostic_bundle`。
- `runtime.mcp.bind` 可见，但 token 不应出现。
- `settings.aiApiKey` 和 `settings.webdavPassword` 为 `<redacted>` 或空字符串。
- `warnings` 能提示 Tauri 未连接、MCP 未启动、审计拒绝/失败、崩溃日志等排查信号。

期望输出中的 `system_settings_smoke` 为：

```json
{
  "hotkey_reregistered": true,
  "tray_visibility_applied": true,
  "launch_agent_plist_valid": true,
  "launch_agent_write_checked": true,
  "launch_agent_cleanup_checked": true,
  "floating_ball_window": true,
  "super_panel_window": true,
  "settings_preserved": true
}
```

说明：该 smoke 会重新注册当前已配置快捷键、按当前设置重放托盘可见性，并校验自启 LaunchAgent plist 内容；写入/删除检查只使用系统临时目录下的隔离 plist，不会写入真实 `~/Library/LaunchAgents`，也不会改写 `settings-general`。

HTTP MCP 手动请求：

```bash
curl -s http://127.0.0.1:<PORT>/health
```

期望：

```json
{"ok":true,"server":"atools-mcp"}
```

初始化：

```bash
curl -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

工具列表：

```bash
curl -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

资源和提示 discovery：

```bash
curl -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":21,"method":"resources/list","params":{}}'

curl -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":22,"method":"resources/templates/list","params":{}}'

curl -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":23,"method":"prompts/list","params":{}}'
```

期望 `resources/list` 至少包含 `uri:"atools://agent/tools"`、`name:"agent_tools"` 和 `mimeType:"application/json"`；`resources/templates/list` 返回 `result.resourceTemplates: []` 且不包含 `nextCursor`。`prompts/list` 应至少包含 `name:"atools_agent_tool_guide"`、`description:"Guide for choosing ATools local Agent tools"` 和可选参数 `task`。

资源读取：

```bash
curl -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":25,"method":"resources/read","params":{"uri":"atools://agent/tools"}}'
```

期望 `result.contents[0].uri` 为 `atools://agent/tools`，`mimeType` 为 `application/json`，文本包含 `find_local_files`、`search_clipboard` 和 `inputSchema`。

提示获取：

```bash
curl -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":24,"method":"prompts/get","params":{"name":"atools_agent_tool_guide","arguments":{"task":"summarize clipboard"}}}'
```

期望 `result.description` 为 `Guide for choosing ATools local Agent tools`，`result.messages[0].role` 为 `user`，文本包含 `find_local_files`、`search_clipboard` 和传入的 `summarize clipboard`。

Ping：

```bash
curl -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"ping"}'
```

期望 `result` 为 `{}`。

initialized notification：

```bash
curl -i -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

期望 HTTP 状态为 `204 No Content`，无 JSON 响应体。stdio proxy 下同一 notification 不应向 stdout 写响应行。

JSON-RPC batch：

```bash
curl -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '[{"jsonrpc":"2.0","id":31,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":32,"method":"prompts/list"}]'
```

期望返回数组只包含 `id:31` 和 `id:32` 两个响应，`notifications/initialized` 不产生响应项，`id:32` 的 `prompts` 数组包含 `atools_agent_tool_guide`。空 batch `[]` 应返回 `-32600 Invalid Request`。

id-less notification：

```bash
curl -i -s http://127.0.0.1:<PORT>/mcp \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"find_local_files","arguments":{"query":"invoice","limit":1}}}'
```

期望 HTTP 状态为 `204 No Content`，无 JSON 响应体；服务端不应静默执行该 id-less `tools/call`。

限制：

- 保守确认模式下，工具调用会生成 pending request，并通过全局确认弹窗或 Agent 页处理。
- `search_clipboard` 已接入本地剪贴板历史；历史采集依赖桌面端剪贴板轮询。
- `find_local_files` 的 `ignore_patterns` 是轻量通配匹配，不等同完整 `.gitignore` 解析；大规模索引化搜索仍可继续增强。
- `compress_images` 支持 `format:"webp"` lossless WebP 输出；`max_bytes` 对 WebP 仍是 best-effort 达标报告，不等同有损压缩器。
- `get_current_context` 会尝试读取受支持前台浏览器的当前 URL；macOS Automation 权限、非受支持浏览器或无前台浏览器时仍可能返回 `browser_url:null` 和明确原因。
- `get_current_context` 的 `finder_path` 复用命令层 Finder folder bridge；macOS Automation 权限或 Finder AppleScript 错误时仍可能返回 `finder_path:null` 和明确原因。
- `ocr_image` 依赖本机 OCR 服务端点，端点不可用时应返回明确错误。

## 6. Release Smoke

发布 readiness：

```bash
pnpm release:check:macos
pnpm test:release-bundle-budget
```

期望：

- 本地开发环境可接受 `status="warn"`。
- 发布前必须消除 `signing-identity` 和 `notarization-credentials` 的 warning；`updater-config` 必须保持为 `ok`，并指向 `TheLastSheep/atools` 的 HTTPS 稳定版清单。
- `bundle-identifier` 应为 `ok`，不能以 `.app` 结尾。
- `entitlements` 应为 `ok`，配置文件位于 `src-tauri/Entitlements.plist`。
- `crash-recovery` 应为 `ok`，panic 会追加写入 `~/.atools/crashes.log`。
- `crash-log-ui` 应为 `ok`，设置页“调试日志”可查看、复制和清空本地崩溃日志。
- release bundle budget 应为通过；`index.html` 首屏 JS 不超过 560KB，且不得直接加载或 modulepreload `plugin-panel-*` / `pinyin-engine-*` lazy chunk。
- 当前 release split 基线：首屏 JS 约 384KB；`PluginPanel` 约 275KB 和 `pinyin-pro` 约 302KB 均为按需 JS chunk。

构建：

```bash
pnpm tauri build
pnpm smoke:macos-release-app
```

检查项：

- [x] `.app` 可以启动；`pnpm smoke:macos-release-app` 通过 LaunchServices 启动 `target/release/bundle/macos/ATools 3.0.app` 并观测到 release app 进程。
- [x] 首次启动不崩溃；release app smoke 观测到进程存活 1500ms 以上，并在验证后清理该进程。
- [x] `Option+Z`、设置页、插件页、Agent/MCP 页可打开。
- [x] 签名状态检查：当前本地构建为 ad-hoc 签名，`codesign` 可读取签名状态且退出码为 0。

```bash
codesign -dv --verbose=4 "target/release/bundle/macos/ATools 3.0.app"
```

- [ ] Gatekeeper 检查：

```bash
spctl --assess --type execute --verbose "target/release/bundle/macos/ATools 3.0.app"
```

当前发布限制：

- 自动更新未完成。
- 公证流程未完成。
- 签名 identity 未配置；本地构建目前是 ad-hoc 签名，entitlements 会在正式签名时应用。
- 当前本地 `spctl --assess` 仍失败，原因是 `code has no resources but signature indicates they must be present`；需完成正式签名/资源封装/公证后再勾选 Gatekeeper。
- 崩溃日志已接入设置页“调试日志”，支持本地查看、复制和清空；仍未做崩溃后自动重启或远程上传。
- Windows smoke 不阻塞 macOS 首版。
