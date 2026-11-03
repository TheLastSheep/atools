# 01: 已覆盖的纯路径插件不启动侧车

**What to build:** 保守识别只使用本地已实现路径方法的 CommonJS preload，使原始代码正常执行且无需准备 Node；未知用法继续原有兼容流程。

**Blocked by:** None (can start immediately).

**Status:** done

- [x] 安全子集完整图执行不调用 Node 准备接口。
- [x] 不支持、动态、逃逸、遮蔽、超预算及兄弟模块的 Node 全局依赖保留兼容回退。
- [x] 预加载副作用仅执行一次，pagehide/plugin-out 后本地函数失效。

主 agent 审查并执行生产 preload/VM、原有生命周期与路径回归；证据见同日 output 的 native-api-frontend-tests.log。仅静态可识别的 CommonJS POSIX 子集；Windows、ESM 和未知用法保留 Node。

