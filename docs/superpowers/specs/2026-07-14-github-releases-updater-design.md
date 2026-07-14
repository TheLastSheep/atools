# ATools 3.0 GitHub Releases Updater Design

Date: 2026-07-14  
Status: Approved design, awaiting written-spec review  
Repository: `https://github.com/harris/atools` (public)  
Initial stable version: `3.0.0`

## 1. Objective

Deliver a signed, user-confirmed macOS update path for ATools 3.0 using public GitHub Releases. The first production release is `v3.0.0`. Future stable releases are discovered after startup, shown to the user, downloaded only after explicit confirmation, verified with Tauri updater signatures, installed, and followed by an application restart.

The release system must support Apple Silicon and Intel macOS, keep incomplete releases invisible to clients, and keep Apple signing credentials and the Tauri updater private key out of the repository and application bundle.

## 2. Decisions

- Hosting: public GitHub Releases in `harris/atools`.
- Version: `3.0.0` for the first stable release.
- Trigger: pushes of stable `vX.Y.Z` tags.
- Architectures: `aarch64-apple-darwin` and `x86_64-apple-darwin`.
- Channel: stable only; drafts and prereleases are excluded.
- Client policy: check once, 3,000 ms after application initialization.
- Download policy: never download silently.
- Install policy: the user clicks `更新并重启`, then ATools downloads, verifies, installs, and restarts.
- Publication policy: build into one Draft Release and publish it only after both architectures and the updater manifest pass verification.

## 3. Architecture

### 3.1 Native updater boundary

ATools registers `tauri-plugin-updater` in the Rust application. The frontend does not receive the plugin's broad default capability. A dedicated Rust updater coordinator exposes only the operations the product needs:

- check for a newer stable version;
- return normalized update metadata;
- download and install the selected update with progress reporting;
- restart only after installation succeeds;
- report the current operation state.

The coordinator verifies that calls originate from the `main` or `settings` window. It serializes operations so startup checking, manual checking, and installation cannot race. The coordinator depends on an updater-backend interface so unit tests can use a fake backend without network or application mutation.

The application continues to use the existing process plugin, but updater-triggered restart is initiated by the native coordinator after successful installation. The frontend cannot request an updater install with an arbitrary URL, version, signature, or artifact.

### 3.2 Stable trust configuration

The production Tauri configuration contains:

- `bundle.createUpdaterArtifacts: true`;
- the public updater verification key generated during the key bootstrap ceremony;
- exactly one production endpoint:
  `https://github.com/harris/atools/releases/latest/download/latest.json`.

The production configuration does not enable insecure updater transport and does not accept runtime endpoint overrides. The updater private key is never stored in the repository, `.env`, app data, WebDAV backups, build artifacts, or application logs.

Apple Developer ID signing and Tauri updater signing are separate trust systems. Apple signing proves publisher identity to macOS; the updater key proves update continuity to installed ATools clients.

### 3.3 Frontend state and UI

A shared frontend updater model has these states:

`idle -> checking -> up-to-date | available -> downloading -> installing -> restarting`

Any active state may transition to `error`; a retry returns to `checking`. Only one operation exists at a time.

The About page shows:

- current version;
- last check time;
- current updater status;
- `检查更新`;
- available version, publication date, and release notes when applicable;
- download progress or an indeterminate progress state;
- retry feedback after a failure.

When a newer release is found, the main window displays a non-blocking prompt with `稍后` and `更新并重启`. It does not steal focus. Release notes render as text, not executable HTML.

### 3.4 GitHub release pipeline

A new publish workflow runs only for stable tags matching `vX.Y.Z`. Its jobs are:

1. `validate-version`
   - Parse the tag without the leading `v`.
   - Require an exact match with `package.json`, `src-tauri/tauri.conf.json`, the Rust workspace version, and all local entries in `Cargo.lock`.
   - Reject prerelease SemVer values.
   - Run `cargo fmt --all -- --check`, strict workspace Clippy, workspace Rust tests, `pnpm test:fast`, `pnpm test:browser`, `pnpm check`, `pnpm build`, the version-consistency test, and signing-aware macOS release readiness.

2. `prepare-draft`
   - Create a Draft Release for the tag, or reuse only the matching existing Draft Release during a retry.
   - Fail if the tag already has a published Release.
   - Expose the Release ID to later jobs.

3. `publish-macos`
   - Use a two-entry architecture matrix with `max-parallel: 1`.
   - Install Node 24, pnpm 11.7.0, Rust, and the required Rust target.
   - Restore dependency caches and install with the frozen lockfile.
   - Import the Apple certificate into an ephemeral keychain.
   - Inject Apple notarization credentials and Tauri updater signing secrets only into the build step.
   - Use the official `tauri-apps/tauri-action` to build, sign, notarize, and upload the DMG and updater assets to the prepared Draft Release.
   - Upload/update `latest.json` sequentially so architecture entries cannot overwrite one another concurrently.

4. `verify-release`
   - Download `latest.json` and every referenced macOS asset from the Draft Release.
   - Require complete `darwin-aarch64` and `darwin-x86_64` entries.
   - Require HTTPS URLs, non-empty signature content, matching uploaded assets, and version equality with the tag.
   - Inspect both bundles for the expected identifier and version.
   - Verify code signing, notarization/stapling, release smoke, and updater-asset integrity.

5. `promote-release`
   - Run only after every previous job succeeds.
   - Change the Release from Draft to published, non-prerelease, and latest stable.

Any failure before promotion leaves the Release as a Draft, which is not returned by the production `/releases/latest/` endpoint.

## 4. Key Bootstrap and Secret Custody

Before updater configuration is merged, an operator performs one Tauri CLI updater-key generation ceremony on a trusted machine:

1. Generate a password-protected updater keypair outside the repository.
2. Put the public key content into the production Tauri configuration.
3. Store the private key content in GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`.
4. Store the password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
5. Store a second encrypted offline backup of both values under independently controlled recovery access.
6. Confirm the repository contains no private-key material before the first tag is pushed.

The GitHub repository also receives the macOS release secrets required by Tauri's signing and notarization flow:

- `APPLE_CERTIFICATE`;
- `APPLE_CERTIFICATE_PASSWORD`;
- `APPLE_SIGNING_IDENTITY`;
- `APPLE_ID`;
- `APPLE_PASSWORD`;
- `APPLE_TEAM_ID`;
- `KEYCHAIN_PASSWORD`, used only for the workflow's ephemeral macOS keychain.

Secret values are never printed, transformed into workflow outputs, uploaded as artifacts, or passed to frontend build variables.

Losing the updater private key blocks future trusted updates. Signature verification must never be disabled. Key rotation uses two releases: an old-key-signed transition release ships the new public key, and only subsequent releases use the new private key.

## 5. Client Data Flow

### 5.1 Startup check

1. ATools finishes initializing the main application state.
2. After 3,000 ms, the frontend requests one update check.
3. The coordinator fetches and validates `latest.json` through the updater plugin.
4. No update: the application records the check time and remains silent.
5. Update available: the coordinator returns normalized metadata and the UI displays a non-blocking prompt.
6. Check failure: the application records a redacted runtime event and keeps normal functionality available.

### 5.2 Manual check

The About page uses the same coordinator. If a startup check is already active, the manual request observes that operation instead of starting a second network request. A manual request always produces visible feedback: current, available, or retryable error.

### 5.3 Install and restart

1. The user clicks `更新并重启`.
2. The coordinator downloads the artifact selected by the updater plugin for the current architecture.
3. Progress events report downloaded and total bytes when the total is known; otherwise the UI stays indeterminate.
4. The updater verifies the mandatory signature.
5. Verification or installation failure stops the flow and does not restart.
6. Successful installation transitions to `restarting` and initiates a native application restart.

Choosing `稍后` closes the prompt and performs no download. The available update remains visible on the About page for the current session.

## 6. Error Handling

- Startup network failures do not interrupt launch or display a modal.
- Manual failures distinguish network, invalid manifest, missing architecture, invalid signature, download, installation, and restart errors.
- Invalid or incomplete manifests fail closed even if their version is newer.
- Same-version and older-version responses are not installable.
- Interrupted or corrupted downloads never transition to installation.
- Duplicate check/install requests never create parallel native operations.
- An error clears the active operation and permits an explicit retry.
- Logs include operation stage and a safe error category, but exclude credentials, certificate content, tokens, private keys, and unredacted sensitive paths.
- Published release assets are immutable. A broken published release is fixed with a higher version, never by overwriting its updater files.

## 7. Testing Strategy

### 7.1 Static configuration and workflow tests

Automated tests verify:

- updater dependency and plugin registration;
- absence of broad updater frontend permission;
- production endpoint, public key, and updater artifact configuration;
- absence of insecure production transport;
- exact version consistency;
- stable-tag-only workflow trigger;
- Draft preparation, sequential dual-architecture matrix, verification, and promotion dependencies;
- least-required GitHub workflow permissions;
- all required secret names without checking or exposing their values.

### 7.2 Rust coordinator tests

A fake backend covers:

- no update;
- newer stable update;
- same version and downgrade rejection;
- active-operation serialization;
- progress forwarding;
- network and manifest errors;
- missing architecture;
- invalid signature;
- download and installation failure;
- restart only after successful installation;
- error cleanup and retry.

### 7.3 Frontend tests

Vitest and Svelte Testing Library cover:

- one delayed startup check;
- manual check joining an active check;
- current, available, downloading, installing, restarting, and error views;
- no download after `稍后`;
- install only after `更新并重启`;
- plain-text release notes;
- determinate and indeterminate progress;
- retry behavior and duplicate-action disabling.

### 7.4 Disposable packaged-upgrade smoke

A test-only configuration and temporary directory exercise the real plugin without changing `/Applications`, production user settings, or production keys:

1. Build a lower-version baseline bundle and a `3.0.0` candidate updater bundle.
2. Sign updater fixtures with a dedicated test keypair.
3. Serve test manifests and assets from a local fixture server allowed only by the test configuration.
4. Verify no update, missing architecture, invalid signature, and valid update cases.
5. Launch the baseline from a temporary application copy.
6. Download, install, and restart into the candidate.
7. Assert the restarted bundle reports `3.0.0`.
8. Remove all temporary processes, applications, keys, and server data.

The production configuration remains HTTPS-only.

### 7.5 First production Release acceptance

The real `v3.0.0` run is accepted only when:

- both architectures build successfully;
- both bundles have identifier `dev.atools.desktop` and version `3.0.0`;
- Developer ID signing, notarization, and stapling pass;
- both release app smokes pass;
- both DMGs, updater archives, and signatures exist;
- `latest.json` contains valid Apple Silicon and Intel entries;
- every manifest URL downloads the expected immutable asset;
- updater signatures validate against the public key shipped in ATools;
- the Release remains a Draft until all checks pass;
- the published Release is stable and selected by `/releases/latest/`.

## 8. Operational Boundaries

The current workspace has no `.git` metadata or configured GitHub remote. Implementation can create code, configuration, tests, and workflows locally, but a real workflow run requires the project to exist in the public `harris/atools` repository with the specified secrets configured.

The initial `v3.0.0` client cannot demonstrate an update from an earlier public release because none exists. The disposable packaged-upgrade smoke proves the mechanism before publication. The next stable release must additionally verify a real upgrade from the published `v3.0.0` artifact before promotion.

Real Apple signing, notarization, Gatekeeper acceptance, and GitHub Release publication remain external acceptance gates until valid credentials and repository access are available.

## 9. Out of Scope

- Windows and Linux installers or updater entries.
- Beta, nightly, prerelease, or staged rollout channels.
- Private GitHub Releases or authenticated download proxies.
- Silent download or silent installation.
- Automatic rollback after a newly installed application starts.
- In-app updater-key rotation UI.
- Telemetry about update checks or installations.

## 10. Completion Criteria

Implementation is complete when the native coordinator, frontend UX, production updater configuration, version/tag validation, two-stage GitHub workflow, automated tests, disposable packaged-upgrade smoke, and updated delivery documentation are present and pass locally or in CI as applicable.

Production delivery is complete only after the real `v3.0.0` Draft Release passes dual-architecture signing, notarization, manifest, asset, Gatekeeper, and release-smoke checks and is promoted to the latest stable GitHub Release.
