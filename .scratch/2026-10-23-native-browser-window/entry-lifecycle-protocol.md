# Task12 main-owned entry lifecycle contract

Overall goal remains full ZTools capability parity; unchanged Harris originals first. This slice prepares background startup without implementing a fake registration or hidden resident host. GUI/App/AppleScript/native probes remain deferred. No Rust, dependency, original package, process-budget, git or installed-app mutations.

## Upstream authority and semantic choice

Pinned local official ZTools checkout: `/Users/harris/Desktop/ZTools`, HEAD `9b15fb1a2a9f3ec886016632761c7bb21e39557a`. `resources/preload.js` implements legacy `onPluginReady` by assigning the same `enterCallback` as `onPluginEnter` and replaying an undelivered entry. `pluginManager.preloadPlugin` loads a complete hidden document and preload without dispatching PluginReady/PluginEnter or selecting a feature. ATools must not conflate this legacy alias with current uTools' distinct one-time initialization event. Existing uTools implementation is preserved; this slice does not claim its modern async readiness gate is complete.

## Interface

`PluginBridgeDocumentOptions.entryMode?: "activate" | "preload"` is a trusted compiler-only option. Omitted/other runtime values choose activate. Never infer it from `action`, payload, a plugin-writable window property or messages. Explicit preload takes precedence over mainPush config and window type. The existing DOM-ready next-task executes, but its entry dispatch returns before featureExports.start, mainPush.boot or any synthetic ready/enter event. This changes entry dispatch only; outer HTML and original preload/page scripts remain normally loaded. There is no background scheduler or native session admission in this slice.

The ZTools namespace exposes uTools' public own enumerable members through enumerable/configurable forwarding descriptors, so late provider replacements and assignments retain current member references. `onPluginReady` is the exception: its independent value directly uses `_lifecycleBridge.onPluginEnter`. Both ZTools names share one registration slot: the last valid function wins, one pending unconsumed entry can be delivered asynchronously, consumed entries are not replayed, subsequent real entries carry exact normalized actions. Existing lifecycle disposal cancels late delivery. uTools' separate ready method is unchanged. Namespace object identity is not a supported invariant; member capability and reference identity are preserved. No new authority hook is exposed.

The actual generated CJS preload must preserve these namespaces after loading modules. If the existing namespaces have distinct valid own ready functions, merge extensions excluding onPluginReady and retain their identities; otherwise preserve the existing legacy Object.assign-and-alias behavior, including enumerable Symbols. Compiled-bridge-only tests are insufficient: verify through preparePluginPreload and a later real HostClipboard installer too.

Preload also skips mainPush bridge construction and legacy query/select callback dispatch, and does not install the promote-to-feature listener. This closes independent adapter entry paths while leaving default activate behavior intact. It is not a security sandbox for original page scripts: those still execute and can deliberately call their own functions or local events. The existing selected-feature production test now observes the separate uTools ready callback; registering both ZTools aliases would intentionally replace the previous callback under the corrected contract.

## Ownership and verification

C owns compiler/providers/dynamic-features/raw-template helper/preload-normalization production integration; B independently owns the actual compiled-bridge lifecycle test and RED evidence; A owns pinned-source static audit script and artifact. No overlapping writes, no descendants. Main owns decisions, review, independent regressions/type/build/budget and original hashes. Source audits are not original UI or system-resource acceptance. Task13 owns authorization, registration, scheduling, persistent runtime ownership, foreground reuse and exit cleanup.
