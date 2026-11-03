# R80 Native wire annex (frozen v1)

Worktree `/Users/harris/Desktop/atools`, branch `codex/atools-ztools-parity`.
This is an interface contract, not an acceptance receipt.

## Ownership

Native owns new `src-tauri/src/app_global_shortcuts/` (typed registry, queue,
transaction, snapshot tokens, restore), `renderer_settings_view/app_global_shortcuts.rs`
and `app_shortcuts_intent.rs`; minimal edits to general settings owned Port/lease,
Settings module/commands, context menu, app lifecycle, updater restart, lib setup.
Launch guard/service and TaskRun chain belong to the other Native owner.
Core store and all frontend files belong to their assigned owners.

## Child operations

Only current compiled, ready Child on `#/shortcuts` may call:
- `readAppGlobalShortcuts`, payload exactly `{}`.
- `mutateAppGlobalShortcut`, payload exactly `{revision,mutation}`.
`revision` is opaque lower-case 32hex, bound to the entire Core raw snapshot.
Any raw change invalidates prior tokens. A stale token returns revision conflict.

Snapshot exact keys: `{version:1,revision,rows,bindings,runtime}`.
`rows` is a read-only presentation projection, one object per public row in original
order (including legacy/plugin rows). Only independently typed display fields
`id/shortcut/target/enabled/autoCopy/configurable/configKey/preScreenshotOptimization`
are projected; invalid fields are omitted, no editable ID is fabricated. Unknown
extensions and raw numeric tokens remain losslessly in Core, never roundtripped.
`bindings` is an array of `{rowId,target:{kind:'app',path,name},shortcut,enabled}`.
`runtime` is an array of `{rowId,state,error}`; state is one of
`registered|disabled|missing|conflict|unavailable`, error is string or null.
No private launch grant, raw SQL authority, or internal numeric revision is exposed.

Mutation closed forms (exact keys):
- `{kind:'create',shortcut,target:{kind:'app',path,name},enabled,autoCopy}`
- `{kind:'update',rowId,shortcut,target:{kind:'app',path,name},enabled,autoCopy}`
- `{kind:'adopt',rowId,shortcut,target:{kind:'app',path,name},enabled,autoCopy}`
- `{kind:'remove',rowId}`
- `{kind:'setEnabled',rowId,enabled}`
`autoCopy` must be false; true returns unsupported before any effect.
IDs are Native-generated; target name is display-only; exact current catalog path
is revalidated. Missing target/duplicate key/reserved CmdOrCtrl W/Q/V rejects.

Receipt exact keys:
`{version:1,persisted,changed,runtimeApplied,notificationDelivered,error,snapshot}`.
`persisted`, `changed`, `runtimeApplied`, `notificationDelivered` are boolean or null;
null denotes unknown. `error` is null or `{code,message}`; snapshot is the actual
post-operation Snapshot or null if reread could not establish it.
A persisted success plus notification failure is never replayed as a create.
CAS failure is `SETTINGS_REVISION_CONFLICT`; reread before another mutation.
Closed/payload/authority errors use the existing bridge error envelope.

## Main intent

New Tauri command `open_renderer_app_shortcuts` receives exactly
`{app:{path,name,subType:'app'}}` and validates actual Main plus current catalog.
It opens/reuses fixed Settings Child; no arbitrary route/payload is accepted.
Fixed Native eval receiver `window.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__`
is installed synchronously by compiled bootstrap before ready and accepts
exactly `{version:1,id,sessionId,sequence,target:{kind:'app',path,name}}`.
`id` and `sessionId` are lower-case 32hex; `sequence` is a safe integer.
Child operation `readAppGlobalShortcuts` response does not alter General/ready.
Native owns each open until ready/delivery; a latest sequence discards superseded
opens. The main-thread closure rechecks current session/document/bundle/origin
and calls only that fixed receiver with JSON-encoded data. No event ACL is added;
Child consumes each id once and discards when closed/navigated away.
The frontend must route only this intent to original Shortcuts/global editor.
No generic route forwarding or plugin launch relaxation is permitted.

## Native worker boundary

64 bindings, 64 queued compact events, one app worker. Pressed latches once;
Released resets unconditionally. Generation checked after lease admission.
`AppLaunchFence` from launch owner is the only spawn/stop fence.
Movable shared `HotkeyOperationLease` covers prepare/apply/commit/publish/recovery
and actual launch terminal. stop invalidates pending and then drains accepted work.

## Intent consumption ACK revision (Root required; Native implementation pending)

The fixed receiver submission is not proof of prefill consumption. Add one narrow
Child operation `ackAppShortcutIntent`, exact payload
`{id,sequence,accepted}`: lower-case32hex id, safe-integer sequence, boolean accepted.
Native takes session/document from the real current compiled Child, never payload;
accepted=true additionally requires the actual Shortcuts route. accepted=false may
report a routing failure from another current compiled Settings route.
Only the current pending id/sequence is affected; stale/duplicate/closed ACK cannot
complete or invalidate a newer request. Pending capacity is one per session.
Main open awaits actual accepted ACK for at most10s; refusal, timeout, close or
invalidated authority rejects, rather than reporting successful consumption.
Frontend keeps O(1) latest/last id+sequence (no lifetime256-intent ceiling), and ACKs
true only after the original editor really shows the unique selected App path.
The latest sequence is allocated at Main admission, before asynchronous lookup;
all async boundaries and the final Native commit recheck source epoch and latest.
General and Intent opens share cancellation-safe claims and successful adoption;
unobserved cleanup must neither leak when all callers leave nor close an adopted
session. These Native lifecycle fixes remain open in the R80 review record.
