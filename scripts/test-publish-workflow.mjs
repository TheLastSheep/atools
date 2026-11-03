import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { validateReleaseTag } from "./validate-release-tag.mjs";
import { normalizeStableReleaseTag } from "./version-contract.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const workflow = await readFile(new URL(".github/workflows/publish-macos.yml", root), "utf8");
assert.equal(workflow.match(/dtolnay\/rust-toolchain@1\.97\.0/g)?.length, 2);
assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain@stable/);
assert.match(workflow, /::error title=Clippy diagnostics::\$diagnostic/);
assert.match(workflow, /::error title=Fast-tier diagnostics::\$diagnostic/);
assert.match(workflow, /::error title=Browser-tier diagnostics::\$diagnostic/);
const ciWorkflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
assert.ok(
  workflow.indexOf("- run: pnpm build") < workflow.indexOf("cargo clippy --workspace --all-targets -- -D warnings"),
  "release validation should create frontendDist before Tauri macros run under Clippy",
);

assert.equal(
  packageJson.scripts["test:publish-workflow"],
  "node scripts/test-publish-workflow.mjs",
);
assert.match(workflow, /^name:\s*Publish macOS$/m);
assert.match(workflow, /tags:\s*\n\s+- ["']v\*["']/);
assert.match(workflow, /permissions:\s*\n\s+contents:\s*write/);
assert.match(workflow, /validate-version:/);
assert.match(workflow, /prepare-draft:/);
assert.match(workflow, /publish-macos:/);
assert.match(workflow, /max-parallel:\s*1/);
assert.match(workflow, /runs-on:\s*\$\{\{ matrix\.runner \}\}/);
assert.match(workflow, /runner:\s*macos-15\b/);
assert.match(workflow, /runner:\s*macos-15-intel\b/);
assert.match(workflow, /aarch64-apple-darwin/);
assert.match(workflow, /x86_64-apple-darwin/);
assert.match(workflow, /releaseId:/);
assert.match(workflow, /verify-release:/);
assert.match(workflow, /verify-bundle:/);
assert.match(workflow, /promote-release:/);
assert.match(workflow, /tauri-apps\/tauri-action@v0/);
const publishStart = workflow.indexOf("  publish-macos:");
const verifyReleaseStart = workflow.indexOf("  verify-release:", publishStart);
const verifyBundleStart = workflow.indexOf("  verify-bundle:", verifyReleaseStart);
const promoteStart = workflow.indexOf("  promote-release:", verifyBundleStart);
assert.ok(publishStart >= 0 && verifyReleaseStart > publishStart && verifyBundleStart > verifyReleaseStart && promoteStart > verifyBundleStart);
const publishJob = workflow.slice(publishStart, verifyReleaseStart);
const verifyBundleJob = workflow.slice(verifyBundleStart, promoteStart);
const certificateImport = publishJob.indexOf("uses: apple-actions/import-codesign-certs@v3");
const prepareStart = publishJob.indexOf("      - name: Stage and pin built-in plugin resources");
const compressedPrepare = publishJob.indexOf("      - name: Sign, compress, verify, and configure the pinned Node payload");
const pdfSmokeStart = publishJob.indexOf("      - name: Exercise staged PDF merge inputs");
const actionStart = publishJob.indexOf("      - name: Build, sign, notarize, and upload", prepareStart);
assert.ok(certificateImport >= 0 && prepareStart > certificateImport && pdfSmokeStart > prepareStart && compressedPrepare > pdfSmokeStart && actionStart > compressedPrepare);
const pdfSmokeStep = publishJob.slice(pdfSmokeStart, compressedPrepare);
assert.ok(pdfSmokeStep.includes('staged_root="$repo_root/target/builtin-runtime-staging/$stage_id/$target"'));
assert.ok(pdfSmokeStep.includes('pdf_temp_parent="$(mktemp -d "$runner_temp/atools-pdf-stage-smoke.XXXXXX")"'));
assert.ok(pdfSmokeStep.includes('node scripts/test-builtin-runtime-staging-pdf.mjs --staged-root "$staged_root" --owned-temp-parent "$pdf_temp_parent"'));
assert.ok(pdfSmokeStep.includes("trap cleanup_pdf_temp EXIT") && pdfSmokeStep.includes("stat -f '%d:%i:%u:%Lp'"));
assert.ok(pdfSmokeStep.includes('rm -rf "$pdf_temp_parent"') && pdfSmokeStep.includes('current_identity'));
assert.ok(pdfSmokeStep.includes('rmdir "$pdf_temp_parent"') && pdfSmokeStep.includes('if ! current_identity='));
assert.doesNotMatch(pdfSmokeStep, /continue-on-error/);
assert.match(publishJob, /p12-file-base64: \$\{\{ secrets\.APPLE_CERTIFICATE \}\}/);
assert.match(publishJob, /p12-password: \$\{\{ secrets\.APPLE_CERTIFICATE_PASSWORD \}\}/);
const prepareStep = publishJob.slice(prepareStart, compressedPrepare);
assert.match(prepareStep, /target="\$\{\{ matrix\.target \}\}"/);
assert.match(prepareStep, /stage_id="\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/);
assert.match(prepareStep, /aarch64-apple-darwin\) arch=arm64 ;;[\s\S]*x86_64-apple-darwin\) arch=x64 ;;/);
assert.match(prepareStep, /--output "target\/builtin-runtime-staging\/\$stage_id\/\$target" --target-platform darwin --target-arch "\$arch"/);
const compressedStep = publishJob.slice(compressedPrepare, actionStart);
assert.match(compressedStep, /APPLE_SIGNING_IDENTITY: \$\{\{ secrets\.APPLE_SIGNING_IDENTITY \}\}/);
assert.match(compressedStep, /APPLE_TEAM_ID: \$\{\{ secrets\.APPLE_TEAM_ID \}\}/);
assert.match(compressedStep, /prepare-node-runtime-compressed-release\.mjs --target "\$target" --stage-id "\$stage_id" \\\n\s+> "\$RUNNER_TEMP\/tauri\.node-runtime-release\.conf\.json"/);
const tauriAction = publishJob.indexOf("uses: tauri-apps/tauri-action@v0", actionStart);
assert.ok(tauriAction > compressedPrepare, "the Tauri action must consume the generated compressed-runtime overlay");
assert.match(publishJob, /args: --target \$\{\{ matrix\.target \}\} --features compressed-node-runtime --bundles app,dmg --config \$\{\{ runner\.temp \}\}\/tauri\.node-runtime-release\.conf\.json/);
const nodePin=JSON.parse(await readFile(new URL("resources/node-runtime/pin.json",root),"utf8"));
const nodeConfig=JSON.parse(await readFile(new URL("src-tauri/tauri.node-runtime.conf.json",root),"utf8"));
assert.deepEqual(nodeConfig.bundle.externalBin,["binaries/node"]);
assert.equal(nodeConfig.bundle.macOS.minimumSystemVersion,nodePin.minimumMacOS);
assert.match(workflow,/node scripts\/verify-compressed-node-runtime-bundle\.mjs --app "\$app_path" --target \$\{\{ matrix\.target \}\} --team-id "\$APPLE_TEAM_ID" --execute/);
assert.match(workflow, /name: Verify signed and notarized bundle\n\s+env:\n\s+APPLE_TEAM_ID: \$\{\{ secrets\.APPLE_TEAM_ID \}\}/);
assert.ok(workflow.indexOf('spctl --assess --type execute "$app_path"')<workflow.indexOf("node scripts/verify-compressed-node-runtime-bundle.mjs"));
const verifyNodeRuntime = verifyBundleJob.indexOf('node scripts/verify-compressed-node-runtime-bundle.mjs --app "$app_path" --target ${{ matrix.target }} --team-id "$APPLE_TEAM_ID" --execute');
const verifyBuiltinRuntime = verifyBundleJob.indexOf('node scripts/verify-builtin-runtime-bundle.mjs --app "$app_path" --target ${{ matrix.target }} --enforce-100mib');
const appSmoke = verifyBundleJob.indexOf("pnpm smoke:macos-release-app -- --app");
const codesignVerify = verifyBundleJob.indexOf('codesign --verify --deep --strict "$app_path"');
const gatekeeperVerify = verifyBundleJob.indexOf('spctl --assess --type execute "$app_path"');
const staplerVerify = verifyBundleJob.indexOf('xcrun stapler validate "$app_path"');
assert.ok(codesignVerify >= 0 && codesignVerify < gatekeeperVerify && gatekeeperVerify < staplerVerify
  && staplerVerify < verifyNodeRuntime && verifyNodeRuntime < verifyBuiltinRuntime && appSmoke > verifyBuiltinRuntime,
"signature, notarization, and Node checks must precede the strict built-in size gate, which must precede smoke");
assert.match(verifyBundleJob, /needs: \[prepare-draft, publish-macos\]/);
assert.match(workflow.slice(promoteStart), /needs: \[prepare-draft, verify-release, verify-bundle\]/,
  "release promotion must depend on the final signed-app size gate");
assert.match(workflow, /uploadUpdaterJson:\s*true/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(workflow, /APPLE_CERTIFICATE/);
assert.match(workflow, /gh release edit "\$GITHUB_REF_NAME" --draft=false --prerelease=false --latest/);
assert.doesNotMatch(workflow, /pull_request:/);

assert.match(ciWorkflow, /permissions:\s*\n\s+contents:\s*read/);
assert.doesNotMatch(
  ciWorkflow,
  /TAURI_SIGNING_PRIVATE_KEY|APPLE_CERTIFICATE|APPLE_PASSWORD|KEYCHAIN_PASSWORD/,
  "ordinary CI must never receive release signing secrets",
);

assert.equal(normalizeStableReleaseTag("v3.0.0"), "3.0.0");
assert.throws(() => normalizeStableReleaseTag("3.0.0"), /stable vX\.Y\.Z/);
assert.throws(() => normalizeStableReleaseTag("v3.0.0-rc.1"), /stable vX\.Y\.Z/);
assert.deepEqual(await validateReleaseTag("v3.0.0", root), { version: "3.0.0" });
await assert.rejects(() => validateReleaseTag("v3.0.1", root), /requested release version/);

console.log("publish workflow contract verified");
