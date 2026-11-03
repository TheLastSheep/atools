# R25 launch-return native report schema

This document freezes the JSON report consumed by the independent Node verifier for
`--journey launch-return`. It supplements
[`ztools-renderer-hidden-launch-return-2026-10-27.md`](ztools-renderer-hidden-launch-return-2026-10-27.md).

## Top-level object

The report is a closed object with exactly these keys:

```text
schemaVersion, journey, scope, runId, identifier, root, pid, passed, errors,
metadata, clipboard, stages, probes
```

Required fixed values:

```json
{
  "schemaVersion": 1,
  "journey": "launch-return",
  "scope": "hidden-original-vue-real-launch-return",
  "metadata": {
    "ownedFixture": true,
    "catalogItems": 2,
    "windowPolicy": "hidden-no-foreground",
    "dataStorePersistent": false,
    "backgroundOnly": true,
    "autoClear": "never"
  },
  "clipboard": { "reads": 0, "writes": 0, "pastes": 0 }
}
```

`runId` is the 32-character lowercase UUID used by the fixture owner and both probes;
`identifier` is the isolated Tauri bundle identifier; `root` is the private fixture
root; `pid` is the positive process ID of this host. `errors` is an array of bounded,
sanitized error codes. The verifier rejects additional fields, incorrect constants,
invalid identities, and any nonzero clipboard count.

The Native receipt protocol accepts at most 64 KiB of serialized JSON. It is a closed
object with `schemaVersion`, `token`, `stage`, `nonce`, `caller`, and `dom` fields;
unknown or extra fields, invalid stage order, an invalid nonce, and malformed nested
adapter snapshots are rejected.

## Stage records

`stages` contains exactly seven records in this order:

```text
baseline, pasted, denied, direct-return, typed, keyboard-return, disposed
```

Each record is a closed object:

```text
{ name, status, dom, native }
```

`status` is one of `observed`, `failed`, or `not_run`. The `dom` and `native` objects
have the exact shape below. `null` means the value was not measured. A successful
report must have `status:"observed"` for every phase and must contain every
phase-required measurement; null is never accepted as evidence for `passed:true`.
Known empty DOM text is represented by `""`; a known absent selection is represented
by `selectedTitle:""`. The verifier rejects missing/extra fields and invalid status
values.

`actions.*DefaultPrevented` records the retained KeyboardEvent's value after its
original page transition settles (Meta+F after the pasted DOM state, ArrowDown after
the selection changes, Enter after launch/hide settles). It is not sampled
synchronously at `dispatchEvent`, because the original async handler can call
`preventDefault()` after awaiting native state.

`inputFocused` records whether the DOM search input is `document.activeElement`. It
must be an observed boolean for a passing report, but either value is valid: the
hidden, unfocused WebView can retain the original Vue search input as its active
element. This field does not establish OS window focus. The hidden/unfocused gate
remains `visibility:"hidden"`, `documentHasFocus:false`, Native
`window.focused:false`, and `focusGainedEvents:0`.

```text
dom: {
  inputValue: string|null,
  pastedText: string|null,
  selectedTitle: string|null,
  visibility: string|null,
  documentHasFocus: boolean|null,
  inputFocused: boolean|null,
  actions: {
    metaFDefaultPrevented: boolean|null,
    launchRejected: boolean|null,
    launchResolved: boolean|null,
    arrowDownDefaultPrevented: boolean|null,
    enterDefaultPrevented: boolean|null
  },
  adapter: {
    launchCalls: integer|null,
    outstandingNativeCalls: integer|null,
    listeners: {
      focusEvents: FocusEventsSnapshot,
      appState: AppStateSnapshot,
      appCatalog: AppCatalogSnapshot,
      appLaunched: AppLaunchedSnapshot,
      contextMenu: ContextMenuSnapshot,
      settingsView: SettingsViewSnapshot,
      generalPreferenceEvents: GeneralPreferenceSnapshot
    },
    windowDrag: WindowDragSnapshot
  }
}

The `listeners` properties are the corresponding unmodified objects returned by the
production adapter's `snapshot()` method. Their exact closed shapes are:

```text
FocusEventsSnapshot = {
  subscribers, listenerState, deliveredEvents, registrationErrors, callbackErrors,
  registrationsPending, lateListenerUnlistens, cleanupPending, cleanupErrors,
  windowContextAvailable: false
}
AppStateSnapshot = {
  version: 1, revision: integer|null, historySubscribers, pinnedSubscribers,
  listenerState, eventSource: EventSourceSnapshot, queuedMutations, acceptedReplies,
  acceptedEvents, stalePayloads, invalidPayloads, mutationFailures, applyErrors,
  callbackErrors, disposed
}
AppCatalogSnapshot = {
  cachedApps, readPending, invalidations, eventSource: EventSourceSnapshot
}
AppLaunchedSnapshot = { invalidPayloads, eventSource: EventSourceSnapshot }
ContextMenuSnapshot = {
  version: 1, subscribers, showInFlight, whitelistedCommands, showRequests,
  showFailures, acceptedCommands, ignoredEvents, invalidEvents, callbackErrors,
  eventSource: EventSourceSnapshot, disposed
}
SettingsViewSnapshot = {
  version: 1, listenerState, activePhase: string|null, pendingOpen, openFailures,
  closeFailures, invalidPayloads, registrationErrors, lateListenerUnlistens,
  cleanupErrors
}
GeneralPreferenceSnapshot = {
  version: 1, invalidPayloads, notifiedFields: { placeholder }
}
EventSourceSnapshot = {
  subscribers, listenerState, deliveredEvents, registrationErrors, callbackErrors,
  registrationsPending, lateListenerUnlistens, cleanupPending, cleanupErrors
}
WindowDragSnapshot = {
  disposed, pending, queued, inFlight: string|null, pendingPositionReads, queuedMoves,
  queuedLocks, positionReads, moveRequests, lockRequests, dispatchedPositions,
  dispatchedMoves, dispatchedLocks, coalescedMoves, rejectedOperations, failures,
  cancelledReads, droppedAfterDispose
}
```

The general preference adapter snapshot intentionally does not claim callback counts,
subscriber counts, or listener registration/cleanup status. The settings view snapshot
intentionally does not claim subscribers, callback errors, or delivered-event counts.
The adapter window-drag snapshot intentionally does not expose the native size-lock
state; that value is observed only through the native host state below. The Node
verifier checks only measurements that these production snapshots actually expose.
The seven snapshot groups remain separate; R24 browser evidence covers their complete
registration/disposal lifecycle where R25's production diagnostics do not expose it.

native: {
  window: {
    visible: boolean|null,
    focused: boolean|null,
    sizeLocked: boolean|null,
    bounds: { x: number, y: number, width: number, height: number }|null
  },
  focusGainedEvents: integer|null,
  childWebviews: integer|null,
  activeChildLayouts: integer|null,
  wkStorePersistent: boolean|null,
  taskRuns: { total: integer|null, cancelled: integer|null, succeeded: integer|null },
  audits: { denied: integer|null, confirmed: integer|null },
  history: {
    items: integer|null,
    firstUseCount: integer|null,
    secondUseCount: integer|null
  },
  appLaunchedWitness: {
    targetLabel: "main"|null,
    deliveredEvents: integer|null,
    payloadIsNull: boolean|null
  },
  probes: {
    started: integer|null,
    exited: integer|null,
    liveProcesses: integer|null,
    pendingLaunches: integer|null
  }
}
```

`native.appLaunchedWitness` is an independent native listener registered against the
`main` Webview target; a window/app-wide/any-target event count does not satisfy it.
`targetLabel` is null if registration against `main` was not verified. Its delivered count must
match the phase cumulative launch count, and every delivered raw payload must be
JSON null (`payloadIsNull:true`). `native.window.visible`, `focused`, and `sizeLocked`
are direct native observations. `wkStorePersistent` comes from the actual main WK
Webview's data store. `childWebviews` counts Webviews outside `main` registered on
the app, and `activeChildLayouts` is the actual current child-layout registry count.
They are not historical window-creation or layout-change counters. In builds without
the multiwebview feature, `activeChildLayouts` is unknown (`null`); it is required to
be observed on the accepted combined-feature run.

The native size-lock value is observed from the real host's window-drag state after
the adapter operation has settled and after each production launch. It is never
derived from the adapter's request queue or snapshot.

## Probe receipts

`probes` contains exactly two closed records, ordered `first`, `second`:

```text
{
  probeId: "first"|"second",
  bundleName: "AToolsOwnedProbeFirst.app"|"AToolsOwnedProbeSecond.app",
  backgroundOnly: boolean|null,
  marker: {
    started: boolean|null,
    exiting: boolean|null,
    runIdMatched: boolean|null,
    probeIdMatched: boolean|null,
    pid: positive integer|null,
    processTerminal: boolean|null
  }
}
```

The plist observation must be `backgroundOnly:true` for each probe. Marker identity
must match report `runId`, `probeId`, and marker PID. `processTerminal:true` requires
an independent `ESRCH` observation for that PID; marker content or an `open` command
return code alone cannot prove process termination. Before a probe starts, its marker
fields remain null until independently observed absent/present according to the
phase; the report must not synthesize false/zero values for unavailable evidence.

## Required cumulative phase evidence

The independent verifier checks these values against the complete ordered stage
ledger:

Native acceptance also checks each expected audit's private `TaskRun.audit_id`
link against the exact path, client, tool, input and status. Denied requires First's
Denied pair; `direct-return`/`typed` additionally require First's Confirmed pair;
`keyboard-return`/`disposed` additionally require Second's Confirmed pair. The
serialized report keeps its aggregate counters and does not disclose internal IDs.

| Phase | Required evidence |
| --- | --- |
| `baseline` | `inputValue`, `pastedText`, and `selectedTitle` are empty strings; no launch calls/event/TaskRun/audit/history; both probes are independently observed absent; hidden/unfocused main window, persistent WK store false, no child window. |
| `pasted` | The real input setter plus `InputEvent` enters `AToolsOwnedProbeFirst`; a `Meta+F` KeyboardEvent is dispatched through the original page handler. The observed result is empty query, `pastedText` containing First, empty selection, and `metaFDefaultPrevented:true`. Production `setWindowSizeLock(true)` settles and native lock is true; main stays hidden/unfocused. |
| `denied` | One direct `window.ztools.launch({type:"app",path,name})` adapter attempt rejects; query stays empty, pasted text remains First and native size lock remains true; no launch event, First marker or history; exactly one matching Cancelled TaskRun and Denied audit. |
| `direct-return` | The same adapter API successfully launches First through the production command/permission/TaskRun path; one main-Webview null-payload event; query and pasted content are observed empty; production hide releases the native lock without a manual unlock and main remains hidden/unfocused; one matching Succeeded TaskRun and Confirmed audit; First history/use count is exactly one. |
| `typed` | Original query results select the DOM item title `AToolsOwnedProbeSecond` (no `.app` suffix) with ArrowDown; selected title and non-empty query are observed; production size lock is true while hidden/unfocused. |
| `keyboard-return` | Original DOM Enter path launches Second; cumulative two main-Webview null-payload events; query/paste clear and production hide unlocks without a manual unlock; exactly three matching TaskRuns (one Cancelled, two Succeeded), one Denied and two Confirmed audits, two history entries with each use count one; both started probes have matching exit markers and terminal PIDs. |
| `disposed` | Adapter and independent front-end witness disposed; all available pending/in-flight counts zero; no new event/call after disposal; both marker pairs match and both PIDs independently terminal. R24 browser evidence covers the seven listener groups' full registration/disposal lifecycle. |

Expected cumulative launch/lock/event/probe counts by phase are fixed: adapter
`launchCalls=[0,0,1,2,2,3,3]`, window-drag `lockRequests` and `dispatchedLocks`
`[0,1,1,1,2,2,2]`, native size lock
`[false,true,true,false,true,false,false]`, native app-launched delivery
`[0,0,0,1,1,2,2]`, and native started/exited/live/pending probes
`[(0,0,0,0),(0,0,0,0),(0,0,0,0),(1,1,0,0),(1,1,0,0),(2,2,0,0),(2,2,0,0)]`.
The native app-launched `payloadIsNull` is null when no event was delivered, true
after one or more valid null payloads, and false if any payload was not null. Every
lock request is `true`; only production `hide_main_window` clears the native lock.

For a `passed:true` report, every exposed error counter must be zero, all stage
statuses must be `observed`, all phase-required fields must be measured, all expected
native false values must be explicitly observed as false, and probe terminal evidence
must be complete. Measurements unavailable from a production snapshot are not
represented by fabricated fields or synthesized zero values. A failure report may
contain null observations, but cannot claim `passed:true`.
