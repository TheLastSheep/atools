# R38：原版主程序插件目录契约

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`；固定只读上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。沿用 North Star、ADR-0002、原 Vue/CSS、Rust 核心与按需 Node，默认入口保持。

## 缺口及复现

生产 setup 异步登记内置 metadata；list_plugins 直接读取当前数据库。原 Main host adapter 永久 memoize 成功列表，且 onPluginsChanged 未接通。原 App 在 initializeData 完成后才订阅该回调，存在晚订阅窗口。

已用真实 host adapter 注入 transport 保存 RED：先成功读取空列表，发出现有 builtin-plugins-loaded，再次读取仍为空，无法看到 timestamp；日志为 `output/renderer-plugin-inventory-2026-10-28/frontend-red.log`。它证明 adapter 缺少失效路径，不是物理窗口或 Native 端到端复现。新适配使用下述定向事件，不把旧 app-wide bus 加入 renderer transport。

## 原生语义

list_plugins 的第一次成功读取应发生在本次 builtin metadata 登记完成之后。就绪是可等待的持久状态，不依赖订阅一次瞬时事件，不通过 UI 轮询补救；等待不阻塞 Tauri 主线程。登记失败、取消或等待超时返回明确错误，不能缓存部分列表假成功。仅登记元数据，不执行 UI、preload 或 Node。

新通知为 `atools://renderer-plugins-changed`，严格 null payload，只投递 main Webview；不传插件路径、manifest 或用户内容。启动登记完成、成功的插件生命周期变更及有效动态 feature 变更通知目录失效。Reset 是变更前清理通知，不可当成最终已提交的新目录。

已有 Svelte/插件生命周期通知继续保留，不依赖新增 app-wide renderer 订阅。没有新 IPC 写命令、定时扫描或常驻进程。

## Main 消费

getAllPlugins/getDisabledPlugins 共用一个监听、缓存和在途查询。首次读取先确认监听就绪；监听失败不得形成稳定缓存，后续调用可重试。每次合法失效推进 generation，旧在途成功或失败不得覆盖当前代，当前调用需获得新代结果。返回结构独立复制，调用者不能修改缓存。

原版 onPluginsChanged 接到真实刷新；如变化发生于公共回调订阅之前，需要有界补发刷新，防止 initializeData 的旧 store 留存。缓存仍有效时不因补发增加 Native 读取；回调异常彼此隔离。dispose 释放监听、拒绝在途消费，晚到的监听或读取不得重建缓存。

## 验收与预算

先验证可稳定失败的缓存用例，再覆盖并发、旧代读成功/失败、监听失败与恢复、晚订阅、非法 payload、拷贝隔离和释放。原生测试覆盖实际 DB 登记与就绪顺序、失败/drop/超时，真实隔离 Native 流程应观察原 Main 搜索变化。严格区分模块测试、Native 功能和可见画面；不将前两者升级为完整 UI 验收。

R37 当前 Main592149B、Settings782503B。实施先沿用 Main 有效593272B/绝对593920B、Settings有效783560B/绝对786432B，测量后再记录成本；不得静默抬高预算或删除必要检查。全应用 RSS/延迟/发行仍需独立实测。

## R38实际验收

最终run `4552318caa734ae1af4925fa98e3d7d4` 通过：首个真实list处于Pending，登记后通过共享生产completion/publish释放，Main收到启动事件1次、总读取2次；随后生产toggle使timestamp结果1→0→1、app始终1，事件与读取分别每次+1。原12/17/10门禁、来源/receipt稳定和退出回收通过。Main593860B（+1711B），本轮只更新阶段基线，593920B绝对上限保持，余60B。可见画面、其它生命周期端到端和完整生产app_setup仍未验收。详见 [验收证据与失败历史](/Users/harris/Desktop/atools/output/renderer-plugin-inventory-2026-10-28/verification.md)。
