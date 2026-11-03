# R17 原版 renderer 资源余量回收

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。R16 属于有效进展：真实设置和共用多视图已验；完整主程序还原目标继续，默认 Svelte 与插件后置/Harris 优先保持。

## 交付范围

后续原版交互需要资源空间，当前 main JS586,513、setting全运行资源765,455 bytes，固定有效上限586,528 /765,490。此次通过集中既有重复逻辑回收空间，不修改上游Vue模板/CSS、构建压缩策略、依赖或预算基线。没有以资源回收代替后续功能交付。

1. Main callbackRegistry 模块统一四处 recipient快照/调用/错误隔离逻辑。原 subscription 的注册世代检查、app-state与context-menu的逐recipient disposal检查、各模块错误计数归属保持。删除/取消的回调跳过，当前派发中新加回调不进入当前快照，同步抛错、Promise/thenable拒绝继续隔离并计数；既有registry调用接口不变。
2. setting childBridgeApi 的两层 Proxy 共用同一get handler。symbol和own属性使用Reflect.get并保持receiver；then返回undefined；继承属性不暴露，未知方法沿用明确unsupported拒绝。错误normalize链、session/CAS/严格schema和32准入不变。

不实施调查中的JSON clone抽取或二次错误normalize删除：前者收益小且可能增加读写模块耦合，后者的反射/克隆未知异常仍需要原错误映射。只回收有清晰语义的重复实现，不手工混淆代码或删除诊断/校验。

## 分工与验收

Luna实施Main四模块及focused测试、setting API及focused测试；不派生。主Agent审查关键diff，独立运行Main全回归/严格TS、child行为/协议测试、正式原设置两项目strict/Vite和Main构建。独立reviewer只读核对派发时序和Proxy receiver/then/unsupported契约。

两侧正式产物必须小于R16实际值且保持固定双预算；记录真实收益，不预设减少量。以新产物更新Native runner的精确来源pin，保持权限和成功条件不变。现有已绑定Native二进制仅在源码摘要未变且原生fixture兼容时复用，两个设置偏好及共用多视图须以新dist运行，运行前后来源稳定，临时进程/目录/bundle归零；不因只有JS改变重复无关Rust测试。

本批不新增可写字段，也不宣称RSS/CPU/时延改善；所有13项设置、单通知与现有真实Native验收仍保持。后续完整设置、系统动作、实际指令执行、物理键盘/IME、像素/材质、跨平台及性能测量继续开放。
