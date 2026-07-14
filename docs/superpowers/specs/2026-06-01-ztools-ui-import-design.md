# ZTools 主程序体验还原与插件导入设计

## 目标

ATools 当前已经有 Tauri/Svelte 主窗口、搜索、插件 iframe、Agent 面板和基础插件安装命令，但和 ZTools 主程序体验相比仍偏“技术验证版”：入口不够像命令中心，插件管理弱，插件导入需要手动选择单个目录，导入前没有兼容性预检，导入后没有报告和下一步动作。

本设计把下一阶段拆成两条可独立验收的产品线：

1. **ZTools 主程序体验还原**：重做主窗口的信息结构、命令面板、结果列表、插件运行壳层、管理入口和 Agent 入口，让用户感知接近 ZTools/uTools 类工具，而不是普通网页面板。
2. **一键导入 ZTools 插件**：提供从 ZTools 插件目录或用户选择目录批量扫描、预检、导入、报告和修复提示的闭环。

## 设计原则

- 保留 Tauri + Rust core + Svelte/TS UI，不改插件 HTML/JS iframe 生态。
- UI 还原先做主程序壳层，不重写每个插件内部 UI。
- 插件导入必须先预检再复制，避免静默失败。
- 导入报告要告诉用户：导入了什么、跳过了什么、失败原因、哪些 API 需要兼容补齐。
- Agent/MCP 面板保留，但降为主程序的一个系统工具入口，不抢占命令面板的主视觉。

## 现状依据

当前 ATools 关键文件：

- `/Users/harris/Desktop/atools/src/App.svelte`：主窗口状态、搜索、欢迎态、插件打开态。
- `/Users/harris/Desktop/atools/src/components/SearchBar.svelte`：搜索输入。
- `/Users/harris/Desktop/atools/src/components/ResultsList.svelte`：命令结果列表。
- `/Users/harris/Desktop/atools/src/components/PluginPanel.svelte`：插件 iframe 壳层和 utools/ztools bridge。
- `/Users/harris/Desktop/atools/src/components/AgentPanel.svelte`：Agent/MCP 管理面板。
- `/Users/harris/Desktop/atools/src-tauri/src/commands.rs`：已有 `install_plugin`，但只有单目录安装，没有批量扫描/导入报告。

本机可用 ZTools 插件样本：

- `/Users/harris/Desktop/ztools-image-batch-studio/plugin.json`
- `/Users/harris/Desktop/ztools-image-batch-studio/dist/plugin.json`

该插件使用 ZTools schema、`title`、`platform`、`pluginSetting`、`features[].cmds` 中的 `img/files/directory` 类型，可作为首批导入兼容样本。

## 目标体验

### 主窗口

ATools 打开后应该像一个轻量本地命令中心：

- 默认窗口更贴近 Spotlight/uTools/ZTools：紧凑、半透明、信息密度高。
- 顶部搜索栏是绝对主角，支持命令、插件、最近使用、文件/图片触发来源。
- 空态不再是营销式卡片网格，而是最近使用、推荐命令、插件管理、导入 ZTools 插件的实用入口。
- 搜索结果按组展示：命令、插件、最近、系统/Agent。
- 结果列表要有图标、标题、说明、来源、匹配原因和快捷键提示，但不能过度装饰。

### 插件运行壳层

插件打开后应该像 ZTools 插件被宿主承载：

- 顶部保留插件标题、当前 feature、关闭/返回、设置、分离窗口。
- `setSubInput` 形成宿主级二级输入区，位置稳定，不挤压 iframe。
- iframe 区域占据主要空间，避免插件 UI 被外层过多边框/卡片包裹。
- 插件输出列表作为宿主结果层展示时要和搜索结果视觉一致。

### 系统管理入口

主窗口内增加系统工具入口：

- 插件管理
- 导入 ZTools 插件
- Agent/MCP
- 审计/权限

这些入口可以放在底部 toolbar 或空态快捷入口，不做完整独立设置页的重型导航。

## 一键导入 ZTools 插件

### 导入入口

入口放在：

- 空态底部：`导入 ZTools 插件`
- 插件管理面板：`扫描目录`、`导入所选`

首版不依赖自动读取 ZTools 官方安装目录，因为不同版本路径可能不同。提供：

- 用户选择一个父目录，递归查找 `plugin.json`。
- 用户选择单个插件目录。
- 如果未来发现稳定路径，再加“自动发现”。

### 预检规则

扫描到 `plugin.json` 后生成 `ZToolsImportCandidate`：

- `path`
- `manifest.name`
- `manifest.title`
- `manifest.version`
- `manifest.main`
- `manifest.preload`
- `features_count`
- `platform_supported`
- `main_exists`
- `preload_exists`
- `logo_exists`
- `unsupported_cmd_types`
- `warnings`
- `errors`

首版预检不执行插件代码。

### 导入行为

导入流程：

1. 用户选择目录。
2. Rust 扫描候选插件。
3. UI 显示候选列表和兼容性状态。
4. 用户点击一键导入。
5. Rust 复制插件目录到 ATools 插件目录。
6. 保存 plugin record，索引 features。
7. 返回导入报告。
8. UI 显示成功/跳过/失败，并提供“搜索已导入插件”。

同名插件默认覆盖，但报告里要明确显示。

## 数据与接口

新增 Rust 类型：

```rust
pub struct ZToolsImportCandidate {
    pub path: String,
    pub name: String,
    pub title: Option<String>,
    pub version: String,
    pub features_count: usize,
    pub platform_supported: bool,
    pub main_exists: bool,
    pub preload_exists: bool,
    pub logo_exists: bool,
    pub unsupported_cmd_types: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

pub struct ZToolsImportReport {
    pub imported: Vec<String>,
    pub skipped: Vec<ZToolsImportCandidate>,
    pub failed: Vec<ZToolsImportFailure>,
}
```

新增 Tauri commands：

- `scan_ztools_plugins(root: String) -> Vec<ZToolsImportCandidate>`
- `import_ztools_plugins(paths: Vec<String>, overwrite: bool) -> ZToolsImportReport`

前端类型放在 `/Users/harris/Desktop/atools/src/lib/types.ts`。

## 组件拆分

新增组件：

- `src/components/ShellFrame.svelte`：主窗口壳层、toolbar、状态区。
- `src/components/HomePanel.svelte`：最近使用、推荐命令、导入入口。
- `src/components/SystemPanel.svelte`：插件管理、导入、Agent 入口容器。
- `src/components/ZToolsImportPanel.svelte`：扫描、预检、导入报告。
- `src/lib/uiState.ts`：主 UI tab/panel 状态。

改造组件：

- `App.svelte`：从单文件状态转为 shell 状态编排。
- `SearchBar.svelte`：视觉和键盘提示还原为紧凑命令输入。
- `ResultsList.svelte`：分组、来源、快捷键和密度优化。
- `PluginPanel.svelte`：插件标题栏、subInput、iframe 承载区优化。
- `AgentPanel.svelte`：作为系统面板的一页，不再从欢迎态独立展开。

## 测试策略

Rust：

- 扫描单个插件目录。
- 扫描父目录并找到多个 `plugin.json`。
- 缺失 `main`、缺失 `preload`、不支持平台时给出 warning/error。
- 导入 ZTools 样本插件后 `list_plugins` 和 `search_features` 能看到 feature。

Svelte：

- `pnpm check` 零错误。
- HomePanel、ZToolsImportPanel 的状态逻辑用轻量单元测试或 Playwright 交互验证。

浏览器/视觉：

- `pnpm build` 成功。
- 打开本地 Tauri/Vite 预览，截取主窗口空态、搜索结果态、插件运行态、导入面板态。
- 检查文字不溢出、窗口大小变化不破坏布局。

## 分阶段交付

### Phase 1：导入能力闭环

先做 Rust 扫描/预检/导入和导入面板。这样插件生态迁移能力先可用，也为 UI 还原提供真实数据。

### Phase 2：主程序壳层还原

重构主窗口：ShellFrame、HomePanel、SystemPanel、紧凑搜索、分组结果。

### Phase 3：插件运行态还原

优化 PluginPanel：标题栏、subInput、iframe 容器、宿主结果层。

### Phase 4：视觉验收和修整

用浏览器截图检查各状态，调整字体、间距、颜色、滚动、空态和小窗口表现。

## 明确不做

- 不重写插件内部 UI。
- 不做 Windows 适配。
- 不自动执行或迁移插件本地数据。
- 不暴露 raw Electron/Node API。
- 不把 Agent/MCP 做成主入口，它只是系统工具之一。

## 开放问题

- 是否有完整 ZTools 主程序截图或安装目录可作为像素级参考。如果没有，按 uTools/ZTools 类命令面板体验做“行为和结构还原”，不做像素级复刻。
- 是否需要自动发现 ZTools 插件安装路径。首版建议不做自动发现，只做选择目录和递归扫描。
