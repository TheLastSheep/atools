import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
const publishWorkflow = await readFile(new URL(".github/workflows/publish-macos.yml", root), "utf8");

assert.equal(packageJson.packageManager, "pnpm@11.7.0");
assert.equal(
  packageJson.scripts["release:check:macos:unsigned"],
  "node scripts/check-macos-release-readiness.mjs --expect-signing-free",
);

assert.match(workflow, /^name:\s*CI$/m);
assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
assert.match(workflow, /pull_request:/);
assert.match(workflow, /push:/);
assert.match(workflow, /runs-on:\s*macos-latest/g);
assert.equal(workflow.match(/dtolnay\/rust-toolchain@1\.97\.0/g)?.length, 4);
assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain@stable/);
assert.match(workflow, /pnpm install --frozen-lockfile/);
assert.match(workflow, /cargo fmt --all -- --check/);
assert.match(workflow, /cargo clippy --workspace --all-targets -- -D warnings/);
assert.match(workflow, /::error title=Clippy diagnostics::\$diagnostic/);
assert.match(workflow, /::error title=Fast-tier diagnostics::\$diagnostic/);
assert.match(workflow, /::error title=Browser-tier diagnostics::\$diagnostic/);
assert.match(workflow, /::error title=Desktop-tier diagnostics::\$diagnostic/);
assert.match(workflow, /tr '\\r' '\\n' < test-desktop\.log/);
assert.ok(workflow.includes("perl -pe 's/\\e\\[[0-9;?]*[ -\\/]*[@-~]//g'"));
assert.ok(workflow.includes("<snapshot omitted; validation result follows>"));
assert.ok(workflow.includes("awk '/Running `.*target\\/debug\\/atools`/ { runtime = 1 } runtime'"));
assert.match(workflow, /tail -n 24/);
assert.match(workflow, /cargo test --workspace/);
assert.match(workflow, /pnpm test:fast/);
assert.match(workflow, /pnpm check/);
assert.match(workflow, /pnpm build/);
assert.match(workflow, /pnpm test:browser/);
assert.match(workflow, /pnpm test:desktop/);
assert.match(workflow, /pnpm test:node-runtime-compressed-bundle/);
assert.match(workflow, /pnpm test:node-runtime-compressed-payload/);
assert.equal(packageJson.scripts["test:node-runtime-compressed-payload"], "node --test scripts/test-node-runtime-compressed-payload.mjs");
assert.equal(packageJson.scripts["test:node-runtime-compressed-bundle"], "node scripts/test-node-runtime-compressed-release-bundle.mjs");
assert.match(workflow, /ATOOLS_DESKTOP_SMOKE_TIMEOUT_MS: 600000/);
assert.match(workflow, /pnpm release:check:macos:unsigned/);
assert.match(workflow, /pnpm benchmark:database:ci/);
assert.match(workflow, /database-performance-\$\{\{ github\.sha \}\}/);
assert.match(workflow, /^  runtime-performance-evidence:/m);

const runtimeJob = workflow.slice(workflow.indexOf("  runtime-performance-evidence:"));
assert.match(runtimeJob, /Prepare raw developer-profile Node runtime for diagnostics/);
assert.match(runtimeJob, /Build raw Node developer-profile app for diagnostic measurement/);
const prepareRuntime = runtimeJob.indexOf('node scripts/prepare-node-runtime.mjs --target "$target"');
const stageRuntime = runtimeJob.indexOf("node scripts/prepare-builtin-runtime-resources.mjs --write --apply-candidate-rules");
const composeRuntime = runtimeJob.indexOf('node scripts/prepare-node-runtime-benchmark-config.mjs --target "$target" --stage-id "$stage_id"');
const buildRuntime = runtimeJob.indexOf('pnpm tauri build --bundles app --config "$RUNNER_TEMP/tauri.node-runtime-benchmark.conf.json"');
const pdfSmokeStart = runtimeJob.indexOf("      - name: Exercise staged PDF merge inputs");
const pdfSmokeCommand = runtimeJob.indexOf('node scripts/test-builtin-runtime-staging-pdf.mjs --staged-root "$staged_root" --owned-temp-parent "$pdf_temp_parent"');
const verifyBuiltin = runtimeJob.indexOf('node scripts/verify-builtin-runtime-bundle.mjs --app "$app_path" --target "$target"');
const verifyRuntime = runtimeJob.indexOf('node scripts/verify-node-runtime-bundle.mjs --app "$app_path" --target "$target"');
const measureRuntime = runtimeJob.indexOf('pnpm run benchmark:runtime:ci -- --app "$ATOOLS_RUNTIME_BENCHMARK_APP"');
assert.ok(prepareRuntime >= 0 && prepareRuntime < stageRuntime && stageRuntime < composeRuntime && composeRuntime < buildRuntime);
assert.ok(stageRuntime >= 0 && pdfSmokeStart > stageRuntime && pdfSmokeStart < buildRuntime && pdfSmokeCommand > pdfSmokeStart,
  "the staged PDF merge smoke must run after the exact target stage and before the measured app build");
const pdfSmokeStep = runtimeJob.slice(pdfSmokeStart, buildRuntime);
assert.ok(pdfSmokeStep.includes('staged_root="$repo_root/target/builtin-runtime-staging/$stage_id/$target"'));
assert.ok(pdfSmokeStep.includes('pdf_temp_parent="$(mktemp -d "$runner_temp/atools-pdf-stage-smoke.XXXXXX")"'));
assert.ok(pdfSmokeStep.includes("trap cleanup_pdf_temp EXIT") && pdfSmokeStep.includes("stat -f '%d:%i:%u:%Lp'"));
assert.ok(pdfSmokeStep.includes('rm -rf "$pdf_temp_parent"') && pdfSmokeStep.includes('current_identity'));
assert.ok(pdfSmokeStep.includes('rmdir "$pdf_temp_parent"') && pdfSmokeStep.includes('if ! current_identity='));
assert.doesNotMatch(pdfSmokeStep, /continue-on-error/);
assert.ok(buildRuntime < verifyBuiltin && verifyBuiltin < verifyRuntime && verifyRuntime < measureRuntime);
assert.ok(runtimeJob.includes(`target="$(rustc -vV | sed -n 's/^host: //p')"`));
assert.match(runtimeJob, /--output "target\/builtin-runtime-staging\/\$stage_id\/\$target" --target-platform darwin --target-arch "\$arch"/);
assert.match(runtimeJob, /prepare-node-runtime-benchmark-config\.mjs --target "\$target" --stage-id "\$stage_id" \\\n\s+> "\$RUNNER_TEMP\/tauri\.node-runtime-benchmark\.conf\.json"/);
assert.doesNotMatch(runtimeJob, /Build unsigned release app for measurement|--config '\{"bundle":\{"createUpdaterArtifacts":false\}\}'/);
assert.match(runtimeJob, /pnpm run benchmark:runtime:ci -- --app/);
assert.match(packageJson.scripts["benchmark:runtime:ci"], /--bundle-threshold-mib 100/);
assert.match(packageJson.scripts["benchmark:runtime:ci"], /--fail-on-threshold/);
assert.match(workflow, /macos-runtime-performance-\$\{\{ github\.sha \}\}/);
const runtimeUpload = runtimeJob.slice(runtimeJob.indexOf("- name: Upload reproducible runtime report"));
assert.match(runtimeUpload, /if: always\(\) && hashFiles\('artifacts\/performance\/macos-runtime\.json'\) != ''/);
assert.match(runtimeUpload, /path: artifacts\/performance\/macos-runtime\.json/);
assert.match(runtimeUpload, /if-no-files-found: error/);
assert.doesNotMatch(runtimeUpload, /continue-on-error/);
assert.ok(runtimeJob.indexOf("- name: Record package, launch, and resource evidence") < runtimeJob.indexOf("- name: Upload reproducible runtime report"));
assert.ok(
  workflow.indexOf("- run: pnpm build") < workflow.indexOf("cargo clippy --workspace --all-targets -- -D warnings"),
  "quality CI should create frontendDist before Tauri macros run under Clippy",
);
assert.doesNotMatch(
  workflow,
  /node_modules|ATOOLS_PLUGIN_MARKET_TRUSTED_PUBLIC_KEYS|TAURI_SIGNING_PRIVATE_KEY|APPLE_CERTIFICATE|APPLE_PASSWORD|KEYCHAIN_PASSWORD|APPLE_SIGNING_IDENTITY|APPLE_TEAM_ID|APPLE_ID/,
  "ordinary CI must stay credential-free",
);
assert.equal(workflow.indexOf("prepare-node-runtime-compressed-release.mjs"), -1,
  "ordinary CI keeps its explicit raw developer diagnostic lane; signed compressed preparation is publish-only");

const publishStart = publishWorkflow.indexOf("  publish-macos:");
const verifyStart = publishWorkflow.indexOf("  verify-bundle:", publishStart);
const promoteStart = publishWorkflow.indexOf("  promote-release:", verifyStart);
assert.ok(publishStart >= 0 && verifyStart > publishStart && promoteStart > verifyStart);
const publishJob = publishWorkflow.slice(publishStart, verifyStart);
const verifyJob = publishWorkflow.slice(verifyStart, promoteStart);
const stage = publishJob.indexOf("node scripts/prepare-builtin-runtime-resources.mjs --write --apply-candidate-rules");
const compressedPrepare = publishJob.indexOf('node scripts/prepare-node-runtime-compressed-release.mjs --target "$target" --stage-id "$stage_id"');
const tauriAction = publishJob.indexOf("uses: tauri-apps/tauri-action@v0");
assert.ok(stage >= 0 && stage < compressedPrepare && compressedPrepare < tauriAction,
  "publish must stage built-ins before preparing the signed compressed Node overlay, then invoke Tauri");
assert.equal(publishJob.indexOf('node scripts/prepare-node-runtime.mjs --target "$target"'), -1,
  "release publishing must not prepare the raw Node developer profile");
assert.match(publishJob, /--output "target\/builtin-runtime-staging\/\$stage_id\/\$target" --target-platform darwin --target-arch "\$arch"/);
assert.match(publishJob, /prepare-node-runtime-compressed-release\.mjs --target "\$target" --stage-id "\$stage_id"/);
assert.match(publishJob, /args: --target \$\{\{ matrix\.target \}\} --features compressed-node-runtime --bundles app,dmg --config \$\{\{ runner\.temp \}\}\/tauri\.node-runtime-release\.conf\.json/);
const verifyCompressed = verifyJob.indexOf('node scripts/verify-compressed-node-runtime-bundle.mjs --app "$app_path" --target ${{ matrix.target }} --team-id "$APPLE_TEAM_ID" --execute');
const verifyPublishedBundleSize = verifyJob.indexOf('node scripts/verify-builtin-runtime-bundle.mjs --app "$app_path" --target ${{ matrix.target }} --enforce-100mib');
assert.ok(verifyCompressed >= 0 && verifyCompressed < verifyPublishedBundleSize,
  "signed compressed Node verification must pass before the unchanged strict app-tree size gate");
assert.match(verifyJob, /node scripts\/verify-builtin-runtime-bundle\.mjs --app "\$app_path" --target \$\{\{ matrix\.target \}\} --enforce-100mib/);
assert.ok(promoteStart > verifyStart && publishWorkflow.slice(promoteStart).includes("needs: [prepare-draft, verify-release, verify-bundle]"),
  "release promotion must remain downstream of signed bundle verification and the app-size gate");
assert.doesNotMatch(verifyJob, /RUNNER_TEMP|target\/builtin-runtime-staging/,
  "the later verification job must consume the signed app's embedded manifest, not a prior runner temp tree");
assert.match(publishWorkflow.slice(promoteStart), /needs: \[prepare-draft, verify-release, verify-bundle\]/);
