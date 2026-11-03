# R78 Original updater — closed Native contract

Status: implementation contract; no network, install, restart or GUI acceptance claimed.
Fixed upstream: 9b15fb1a2a9f3ec886016632761c7bb21e39557a. Original UpdateWindow template/CSS retained.

## Wire types

All request objects below have exactly the listed fields. Unknown fields/operations reject.
IDs are 32 lowercase hexadecimal UUIDs, opaque to pages. Integers are nonnegative JS-safe integers.
Error is exactly `{code:string,message:string}`; fixed Native catalogue messages, encoded <=2KiB, no raw URLs/paths/provider details.
Unknown/provider details normalize to bounded internal; raw model field ceilings remain unchanged, they are not dynamic popup-message allowances.
Metadata is exactly `{candidateId,currentVersion,version,date:null|string,body:null|string}`.
Version/currentVersion/date each <=128 UTF8 bytes; body <=48KiB. Candidate is validated before caching/returning.
Entire encoded snapshot/status <=64KiB. This is a retained/returned-data budget, NOT a network read bound.
Snapshot is exactly:
`{version:1,sequence,phase,candidate:null|Metadata,checked,operationId:null|ID,progress:{downloaded,total:null|integer},error:null|Error}`.
phase is one of idle/checking/not-available/available/downloading/downloaded/installing/install-unknown/restart-pending/restarting/error.
`downloaded` means a real retained, signature-verified archive for that exact candidate; never inferred from progress.
`install-unknown` means an attempted install failed and the installed version may have changed.
`restart-pending` means installation succeeded; later confirmation retries restart only, NEVER installation.
`operationId` identifies ownership of the actual confirmation permit, not an IPC awaiter. Dropping an IPC awaiter cannot release a live worker or its permit. Only when the worker reaches its real terminal state may its original owner clear `operationId` and advance `sequence`; release the permit before publishing that terminal snapshot.
`restarting` retains its existing close sentinel. Close eligibility must still check phase and cannot be inferred from `operationId:null`.

## Main principal and commands

`renderer_updater_main({request:{op:"status"|"check"|"show"|"startup"}})`.
Status/check/startup return Snapshot. Show returns exactly `{windowId:ID}` after owned window/source creation succeeds.
Only actual original Main Webview+parent+trusted local source may call this command.
Status is read-only; check is an explicit user action, single-flight.
Startup registers once, returns immediately, schedules one 3s background check without blocking search.
Native reads settings-general.autoCheckUpdate (missing=true, invalid value skips); Svelte had no field read,
so this explicitly preserves the existing General preference, rather than inventing a generic setting API.
Managed/private or release-smoke profiles cannot use the real network provider (including explicit check).
R78 isolation may only inject a Fake provider or explicitly authorized debug loopback provider; old QA stays offline.
Show does not implicitly check/download/install. With no candidate it rejects no_update and creates NO window (fixed upstream behavior). Restart-pending retains a real candidate and may reopen.
If a later check clears a candidate, existing popup authorization is cleared and snapshot says candidate:null; it cannot install an old ID and remains closable.
Repeated show focuses the same live owned window; no second popup. Main never supplies candidate/package URL/path/bytes.

## Popup principal and commands

One borderless transparent 500x450 window; URL exactly atools-updater://localhost/{windowId}/updater.html, independently verified updater bundle.
Window/Webview label is exactly `renderer-updater-${windowId}`.
Native injects immutable `window.__ATOOLS_UPDATER_WINDOW_ID__` before the original updater entry loads.
`renderer_updater_window({request:{op:"ready"|"status"|"close",windowId:ID}})`.
`renderer_updater_window({request:{op:"open-link",windowId:ID,candidateId:ID,href:string}})` returns `{opened:true}`.
Open-link requires current displayed candidate/window generation; href <=8192 UTF8 bytes, standard URL parsing,
only http/https, no credentials, C0/DEL/NUL. It uses audited system-browser open_url, never package download,
shell or page navigation. No extra Markdown-link-set parser; sanitized clicks use this op, fixture uses FakeOpener.
`renderer_updater_window({request:{op:"drag",windowId:ID}})` returns `{started:true}` after exact owned source/generation validation and only that window.start_dragging; no coordinates/generic window API.
ready/status return Snapshot. close returns exactly `{closed:true}` or rejects while download/install/restart is busy.
`renderer_updater_window({request:{op:"start"|"install-downloaded",windowId:ID,candidateId:ID}})` returns Snapshot.
Start promise resolves only at actual operation terminal (not merely spawned/accepted); progress events carry intermediate state.
Start is original download+install+restart composition; install-downloaded requires an actual retained archive.
Only exact live owned popup Webview/parent/local URL/windowId is authorized; plugin/Settings/other labels reject.
Native binds the candidate displayed at ready/status/event enqueue, checks supplied ID against that binding,
then revalidates popup generation and candidate under the shared operation permit immediately before work.
A stale window/candidate or concurrent second confirmation rejects; it never silently acts on a newer candidate.
Close/destroy/navigation revokes that window generation. Same-window navigation/new-window attempts are denied.
No generic Electron IPC, generic external-open capability, page-provided expected version, bytes or cache path is accepted.

## Event and original UI mapping

Targeted event `renderer-updater-state`: exactly `{windowId:ID,snapshot:Snapshot}` to that popup only.
The ready handshake follows subscription; its authoritative snapshot wins over older sequence events.
Progress coalesces to <=10Hz per operation, terminal transitions enqueue immediately; safe monotonic sequence.
Main may subscribe to `renderer-updater-main-state`, payload exactly Snapshot (no per-chunk IPC).
The popup bridge maps snapshots to the original closed channels only:
`update-info`: `{version,changelog,manualDownloadRequired:false,downloadStatus:{status}}`.
`update-download-start`: no payload; `update-download-progress`: `{transferred,total,percent}`.
`update-downloaded`: no payload; `update-download-failed`: `{error}`.
Bridge maps original window-ready/close-window/startUpdate/installDownloadedUpdate to the commands above.
Original action returns `{success:true}` or `{success:false,error:string}`; Native rejects are caught and mapped.
Original Enter/Escape/busy state remains; reopening hydrates actual phase/verified archive/restart pending state.
Remote notes must be sanitized by the frontend safe Markdown renderer; plain metadata is not trusted HTML.
R78 does not introduce a manual-download URL mode: current ATools package updater has configured signed packages.
Unsupported package/platform/architecture returns a real error, never a fake portable/manual flow.

## Popup appearance (separate from updater business state)

`renderer_updater_window({request:{op:"appearance",windowId:ID}})` and targeted `renderer-updater-appearance`
return exactly `{windowId,sequence,platform,material,nativeMaterial,materialApplied,theme,effectiveTheme,opacity,opacityApplied,acrylicOpacity:{light,dark},error}`.
Platform darwin/win32/linux; material none/acrylic/mica/tabbed; nativeMaterial none/fullscreen-ui; theme system/light/dark;
effectiveTheme light/dark; actual opacity null|0..1 (null when no getter), configured General target.3..1; acrylic percentages integer0..100.
Missing General defaults are the existing production system/none/1/78/50. Unknown keys ignored; bad known fields reject.
Only real Native facts may set applied flags/material/effectiveTheme/readback opacity; unsupported effects report none/false/error.
Mac original popup applies/reads FullScreenUI independently of the Windows material selector. General commit and actual theme
changes refresh at low frequency; old-generation callbacks do not affect a reopened popup. Hidden private profiles stay hidden/nonpersistent.
Original getWindowMaterial/onUpdateWindowMaterial/onUpdateAcrylicOpacity map this projection, with all subscriptions released.

## Shared coordinator and legacy Svelte compatibility

There is one coordinator, one real operation permit, one popup and at most one retained verified archive.
Legacy startup_app_update() returns legacy UpdateStatus immediately and registers the SAME Native startup singleton;
Svelte replaces its JS timer with this call. Legacy check_app_update returns Metadata (now includes candidateId); get_app_update_status keeps its existing
`{operation,update,checked,lastError}` shape, with Metadata carrying the same opaque candidateId.
Legacy install_app_update requires `{expectedVersion:string,expectedCandidateId:ID}` and actual main/settings
principal. It revalidates both after acquiring the permit. Missing/old candidate confirmation rejects.
Svelte appUpdater carries that ID from the displayed check result and keeps its “update and restart” composition.
Legacy low-frequency app-update-status sends the same UpdateStatus to exact main/settings; subscribe before startup.
Legacy app-update-progress remains compatible; no new Svelte UI. Legacy metadata/status projections stay bounded.
A check cannot replace a candidate during an active install/download. Re-checking identical trusted metadata
may preserve its candidate; any changed candidate invalidates old presentation authorization and old archive.

## Provider, verified archive and operation lifecycle

Keep tauri-plugin-updater2.10.1. No fork, proxy, fabricated signed artifact or frontend-supplied endpoint.
Manifest/package streaming in this locked plugin has NO hard instantaneous memory bound. State this limitation.
Only production `Update.download().await == Ok(bytes)` can construct private VerifiedArchive: that return follows
signature verification. The plugin download-finish callback runs BEFORE signature verification and is not proof.
After successful verification enforce <=256MiB retained/install admission, store in anonymous private tempfile
with length+SHA256 and the SAME Update object, drop Vec; bounded readback verifies length/digest before install.
256MiB is NOT a bound on the plugin's transient download Vec. Failed verification is never cached or installed.
Blocking archive/install workers retain the operation permit until actual join, even if a page closes, command
awaiter drops or a cancellation notification occurs. Closing a view never frees a still-running worker slot.
Installation failure => install-unknown, preserve verified archive only for explicit confirmed retry; no promise
that current version is unchanged. Installation success + restart failure => restart-pending; retry only restart.
Errors distinguish stale_candidate/forbidden_window/busy/no_update/not_downloaded/invalid_manifest/
invalid_signature/archive_too_large/archive_integrity/download_failed/install_unknown/restart_pending/internal.
No implicit install/restart on show/ready/status/reopen. Exit revokes popup/event delivery; process lifetime
and installation semantics must remain truthful, no post-exit cleanup success invented.

## Build and validation boundaries

Independent root output `dist-ztools-updater`; provenance owner/role must be updater-specific and source-bound.
Budgets: JS baseline104330/max120714; all resources baseline284598/max300982 (logo170073 included).
Main baseline609908/max614004. Settings803857/max804189 unchanged. No weakening existing readers.
All authored files <=500 lines; preserve actual dirty preimages, frozen diff/hashes and actual command exits.
Targeted caller/provider tests cover first candidate validation, signed-return-only archive construction,
length/digest/oversize denial, old candidate/window generation/double confirmation and actual worker retention,
install-vs-restart failure, and progress coalescing. FakeError tests are not real signature verification evidence.
No App, network check/download/install, restart or OS input during implementation; fresh/runtime separately authorized.

Windows uses builder default HTTP rewrite http://atools-updater.localhost/{windowId}/updater.html; fixed localhost and exact nonce path remain mandatory, no remote capability.

## Integration clarifications

External-link acceptance is linearized at successful current popup/source/candidate authorization plus raw/normalized URL admission. It captures immutable windowId/candidateId/href and owns one shared TaskRun/audit execution even if the popup subsequently closes or the candidate changes. It never re-reads/repoints that href; closing revokes new requests and late UI replies, not the accepted click. Host shutdown retains the existing global task-cancellation boundary. No sync lock spans audit.await.
Legacy check/status/install/startup accept the same trusted local Native Main in either original Vue or Svelte entry, plus the exact local Settings root. This does not expose install in original window.ztools; popup/plugin/remote/non-root principals remain denied.
Managed startup never auto-checks, regardless of loopback environment. Existing generic managed smoke has no production provider grant. Normal provider construction requires actual AppState, non-managed identity and the private SDK-registration host marker. Missing host/SDK yields provider_unavailable before SDK state access; a future specialized managed SDK fixture requires separate verified registration, not an environment-only grant.
Locked Tauri AppHandle.restart never returns a launch result. restart-pending/restart-only provider semantics are covered by caller tests; production OS relaunch failure observation and successful relaunch remain unverified, not fabricated from a Fake restart error.
