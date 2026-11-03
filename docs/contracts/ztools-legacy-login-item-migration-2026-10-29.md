# Legacy macOS login item migration contract

**Status: R60 production integration, strict Settings build and scoped original-Vue browser checks are verified; Native/OS acceptance remains pending.** Emitted resources are 790,459 bytes, exactly 6,144 bytes above the frozen baseline and within the unchanged budget. The browser fixture uses synthetic RPC replies. This document narrows ticket 38; it does not authorize changing the current user's LaunchAgents data.

## Scope and evidence

The product direction keeps the pinned ZTools renderer during migration and does not change the local-first desktop boundary ([North Star, sections 2.1-2.2](../superpowers/specs/2026-07-14-atools-product-engineering-north-star.md#21-2026-07-22-架构方向调整), [DESIGN.md, scope update](../../DESIGN.md#scope-update--2026-10-26)). Ticket 38 says the R49 backend only detects and preserves the legacy configuration; close/migrate behavior remains required work ([ticket 38](../../.scratch/original-main-native/issues/38-legacy-login-item-migration.md)).

Current implementation facts:

- `login_items::spec::legacy_path` names `~/Library/LaunchAgents/com.atools.desktop.plist`; `legacy_configuration_present` only detects whether an entry exists. It does not validate ownership or parse its contents ([spec.rs](../../src-tauri/src/general_settings_runtime/login_items/spec.rs#L28), [login_items/mod.rs](../../src-tauri/src/general_settings_runtime/login_items/mod.rs#L289)).
- The old plist helper emits `RunAtLoad=true` and no `KeepAlive` key ([spec.rs](../../src-tauri/src/general_settings_runtime/login_items/spec.rs#L46)). The local macOS SDK `launchd.plist(5)` says `RunAtLoad` starts a job once when loaded (default false), while omitted `KeepAlive` defaults to false (SDK man page, lines 269-285 and 332-336).
- The R49 transaction established `SMAppService.mainAppService` ownership and readback verification ([service.rs](../../src-tauri/src/general_settings_runtime/login_items/service.rs#L74), [transaction.rs](../../src-tauri/src/general_settings_runtime/login_items/transaction.rs#L15)). At that stage, detection rejected a legacy-path entry without migrating it ([login_items/mod.rs](../../src-tauri/src/general_settings_runtime/login_items/mod.rs#L289)); R60 adds a separate explicit inspect/resolve path below.

On this machine, the relevant SDK header is `MacOSX27.0.sdk/System/Library/Frameworks/ServiceManagement.framework/Versions/A/Headers/SMAppService.h`: `unregisterAndReturnError` says a running LaunchAgent is killed, but a running **main application** continues and is prevented from launching at a future login (lines 175-193). `statusForLegacyURL` only queries a legacy plist URL under `/Library/LaunchDaemons`, `/Library/LaunchAgents`, or the current user's `~/Library/LaunchAgents`; its stated use is observing legacy-service authorization, not removing it or proving process survival (lines 251-270). See [Apple's unregister documentation](https://developer.apple.com/documentation/servicemanagement/smappservice/unregister%28%29?language=objc) and [legacy status documentation](https://developer.apple.com/documentation/servicemanagement/smappservice/statusforlegacyplist%28at%3A%29?language=objc).

These facts do **not** prove that simply moving a loaded legacy plist has a particular next-login outcome. The local `launchctl(1)` page says `bootout` removes service definitions (lines 90-100); it does not promise that a running app remains alive. Its newer command output is explicitly not a stable automation API (lines 676-684). Do not parse `launchctl print` or treat unlinking alone as verified migration.

## R60 current integration status

Production startup recovery is connected through `recover_for_startup`; login-item reads and changes run under the shared operation lock and call `recover_locked` before operating. Production paths use the fixed `~/.atools/login-item-recovery` location and the installed app identifier/NSBundle matcher. The Main and Child expose strict read, legacy-inspect and resolve RPCs, and the operation lock is held through terminal completion.

The pinned Vue General view uses a staged host compatibility patch, and the Svelte fallback uses the shared controller. Unknown state disables the ordinary checkbox. The Vue host row shows an explicit visible unknown label while hiding its custom slider; the input retains DOM/a11y indeterminate state. Only a verified legacy result offers the explicit turn-off, migrate and defer choices. CAS, approval-required and legacy rejections invalidate cached state before an explicit fresh read. The pinned upstream source, stylesheet bytes and default product entry remain unchanged.

Root verified 154 General tests and 131 Child tests with one pre-existing ignored test. The accepted-resource workspace check passed with 262 warnings. The final focused frontend suite passed 41/41; earlier broader Settings regression passed 154/154 (overlapping suites, not additive). The compatibility-patch check, strict TypeScript build and `svelte-check` 0 errors/0 warnings passed. The final browser run passed 14/14 checks across five original-Vue pages, including explicit choices, CAS/revision rejection, fresh reads and visible unknown state; source/dist hashes stayed stable and the owned loopback server closed. These are synthetic-RPC browser checks, not Rust IPC or OS acceptance. See [R60 verification](../../output/renderer-legacy-login-integration-2026-10-29/verification.md).

Builder extraction and pure diagnostic-call elimination preserve argument side effects and warn/error output. Shared DTO validation, error messages and controller transactions reduce duplicated runtime code. The final budget has no incremental headroom; further changes must continue to pass the same gate. No threshold was raised. A read-only session check at 2026-10-29 13:13:52 UTC confirmed the desktop was locked; no Native GUI app was launched in R60.

No real user LaunchAgent was read, changed or migrated. Real Native GUI behavior, a disposable OS LaunchAgent migration, next-login behavior and cleanup are still unverified; ticket 38 remains in progress.

## R52 implementation boundary (historical checkpoint)

The statements in this section describe the R52 checkpoint. The durable adapter and R60 production/UI integration recorded later supersede its not-yet-connected status.

The R52 checkpoint added a port-driven pure migration policy and a strict configuration inspector. The policy used the shared modern-service state classifier: `NotFound` and `NotRegistered` both mean disabled for decision-making, while the recovery journal needed to retain the original raw status (implemented in R59). The inspector validates a bounded private file, rejects unknown or duplicate plist keys, and preserves its original bytes, hash, and identity. Its tests use private fixtures; no real LaunchAgents path is read or changed.

Inspection during a read still compares the complete identity, including ctime. A separate rename comparison checks device/inode/owner/group/mode/length/mtime and intentionally omits ctime; that comparison alone is not proof of a safe migration. The private-file rename test checks the preserved bytes/hash and absent source, then verifies a permitted mode change fails the comparison.

At R52, these pieces did not yet implement durable filesystem staging, journal persistence or startup recovery, explicit user selection, a command/UI path, or an actual OS migration. Port/fake tests and private-file tests are not OS acceptance. Do not describe that checkpoint as accepted or close ticket 38 on its evidence.

## Required behavior

1. Offer two explicit user choices when a verified legacy item is found: **turn off login launch** or **migrate to the modern main-app login item**. Do not silently choose either action. If modern and legacy registrations coexist, never add a second modern registration; reconcile both to the selected outcome.
2. Preserve the current ATools process and its in-memory/unsaved work. Never call `launchctl bootout` on the legacy job as part of this UI operation. The documented non-termination guarantee for `SMAppService.mainAppService.unregister` applies only to the modern main application, not a legacy LaunchAgent.
3. Fail closed on unknown status, approval-required state, malformed configuration, identity mismatch, filesystem race, or unavailable API. Do not convert these states to disabled or successful cleanup.

## Legacy file ownership gate

Before changing anything, serialize through the existing login-item OS operation lock ([mod.rs](../../src-tauri/src/general_settings_runtime/login_items/mod.rs#L18)). Validate the exact expected path using `symlink_metadata`; require a regular non-symlink file, current-user ownership, restrictive permissions, a bounded size (16 KiB maximum), and a successfully parsed plist. Require the fixed legacy `Label`, `Program`/`ProgramArguments` resolving to this installed ATools executable, and only an allowlisted launch configuration: `RunAtLoad=true`, with no `KeepAlive` or other restart/watch behavior. Reject unrecognized keys or a different executable instead of rewriting them.

Capture the original bytes, SHA-256, device/inode, owner, group, and mode. Recheck identity immediately before moving the file. Keep the original inode/metadata where possible by atomically renaming it to a private same-volume recovery area outside the LaunchAgents scan directory; if this cannot be done safely, stop before mutation. Never use a caller-supplied path, label, or executable.

## Candidate transaction and compensation

Write a durable, private, versioned recovery record before the first mutation. It records the selected operation, validated legacy identity and backup location, the observed modern `SMAppService` status, and the current transaction phase. Flush the record and directory before proceeding. The record is recovery evidence, not proof that either OS state changed.

Version 1 uses a single derivable location instead of deserializing paths from the record: the trusted host supplies the recovery directory, whose fixed transaction files are `transaction.json`, `transaction.pending` and `legacy-login-item.plist`, plus `.login-item-migration.lock`; the source basename is fixed to `com.atools.desktop.plist`. The recovery directory must be private, canonical, on the same device and outside the source directory. An exclusive descriptor-held lock permits only one transaction for that directory. Production must derive both directories itself; neither UI nor journal may supply a source or backup path. Private tests may supply their own isolated directories. These rules fulfill the backup-location requirement without accepting a journal-controlled path.

1. **Stage legacy:** atomically move the validated plist out of the LaunchAgents directory; verify the original path is absent and the staged bytes/metadata still match. Do not call `bootout`.
2. **Turn off:** if the modern main-app service was enabled, unregister it and read back `NotRegistered`. If it was already unregistered, do not call unregister. Keep the staged legacy file until all checks pass.
3. **Migrate:** if the modern service was not enabled, register `mainAppService` and read back `Enabled`. If it was already enabled, retain that state. A pending approval or unknown result is failure, not success.
4. **Commit:** verify the legacy source path remains absent and the modern status matches the user's choice. Durably mark the forward commit in the journal first; then delete the staged backup and sync its directory; delete the journal last and sync its directory. If cleanup fails, retain enough durable forward-recovery evidence to resolve the committed state.
5. **Compensate on failure:** restore the exact prior modern state using `mainAppService` and verify it; atomically restore the staged legacy file and verify its bytes/metadata. If either restoration is uncertain, keep the recovery record and backup, return a stable recovery-failed result, and block further toggles until recovery is resolved. Never claim rollback succeeded from an API call's return value alone.

On next startup, inspect any recovery record before projecting the setting. Reconcile only when the staged file identity and structured modern status make one outcome unambiguous; otherwise preserve evidence and surface a recovery error. Record the original raw modern status even though `NotFound` and `NotRegistered` share the disabled decision state. This journal is needed because a process crash can occur between legacy staging and modern registration/verification.

The restart coordinator must not register or unregister the modern service. If the original file is intact, no backup exists and the modern status still equals its original state, finish rollback and report that outcome. If the source is absent and the backup matches, the currently confirmed target state permits forward commit; the original state permits restoring the file and finishing rollback. When the original state already equals the target, only the staged-backup case prefers forward commit; an untouched source remains a rollback. A `ForwardCommitted` record permits cleanup only with an absent source and a confirmed modern target. Re-read modern status before the final file action; unknown status, drift or conflicting/missing files preserve recovery evidence and block normal toggles. A rollback outcome is not completion of the user's requested migration.

## R59 filesystem and restart implementation (historical checkpoint)

This section records the R59 filesystem/restart result before R60 connected the production recovery hook, RPCs and UI choices.

`DurableLegacy` now implements the existing `LegacyPort` using descriptor-relative I/O, exact file identity/hash checks, same-device non-replacing rename and file/directory sync. Named-directory identity is checked against both the held descriptor and captured device/inode/uid/gid/mode. The fixed lock name is also bound to its held descriptor; replacement or identity loss fences further mutation. An uncertain forward-publication attempt fences the current adapter from rollback and requires reopening from disk before another mutation.

Version 1 records are private canonical JSON bounded to 4 KiB; legacy content remains bounded to 16 KiB. A valid `Prepared` pending record without a published journal can be published only while the exact original source is intact and backup absent. With an existing journal, a pending phase advance must belong to the same transaction and have exactly one validated source/backup. The unpublished pending is removed, while the published journal remains authoritative. This includes interruption after the source has already been restored but before rollback cleanup. Invalid or ambiguous pending evidence is retained and rejected. Rollback removes a validated pending before deleting its published journal.

Root verified 137 General-settings tests, including 60 legacy tests, and the default workspace compilation check. A new restored-source/pending regression first failed on the real recovery path. A controlled replay of the old directory guard made two of four actual filesystem regressions fail; the correct source was restored byte-for-byte before the final green run. Independent review found no remaining P1/P2 within this filesystem scope. See [R59 verification](../../output/renderer-legacy-login-durable-2026-10-29/verification.md).

The tests use real private files with a fake modern service and per-instance publication/commit interruption points. They do not prove power-loss behavior, real LaunchAgent registration, next-login behavior or visible UI. At the R59 checkpoint, normal toggles still rejected a legacy item and no public migration command or user-facing choice was enabled; R60 adds those production connections without changing the OS acceptance boundary.

## Acceptance boundary

Unit tests should cover strict file validation, duplicate modern/legacy state, both user choices, each mutation/readback failure, successful compensation, and uncertain compensation with the journal retained. They must use private fixtures, never the user's LaunchAgents data.

OS acceptance requires a disposable signed app bundle and an isolated test user or explicitly approved QA LaunchAgents directory. The legacy-status API only accepts the documented Library paths; do not pass a temporary arbitrary path and call it a successful API query. Verify the same app PID and an in-memory unsaved-work sentinel survive each choice, exact file identity and modern status reach the requested state, failures restore the prior state, and cleanup leaves no test registration. To claim “disabled for the next login,” prove the behavior in a disposable login session; file absence or `statusForLegacyURL` alone is not that proof. Do not use the real product plist as a destructive fixture.

The durable adapter has been exercised only with private fixtures. No real LaunchAgent operation has been performed under this contract. The `mainAppService` API facts above come from SDK/API documentation; they are not an end-to-end OS behavior test for the legacy plist path.
