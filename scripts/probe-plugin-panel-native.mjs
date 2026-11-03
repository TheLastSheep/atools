import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { buildNativeSmokeWithProfile, nativeSmokeBuildPlan, runNativeProcess } from "./lib/native-smoke-process.mjs";
import { parseNativePanelCliOptions } from "./lib/native-panel-cli-options.mjs";
import { createFixtureEnvironment } from "./lib/legacy-node-environment.mjs";
import { stageNativeSmokeApp } from "./lib/native-smoke-app-bundle.mjs";
import { createNodePageFixturePackages } from "./lib/native-node-page-package.mjs";
import { preparePasteboardProConsumerFixture } from "./lib/pasteboard-pro-consumer-fixture.mjs";
import { prepareImageToolboxNativeFixture } from "./lib/image-toolbox-native-fixture.mjs";
import { retainImageToolboxExport } from "./lib/native-image-toolbox-evidence.mjs";
import { prepareHeadFileTreeFixture, verifyHeadFileTreeFixture } from "./lib/head-file-tree-fixture.mjs";
import { prepareHeadDeveloperCodecToolsFixture, verifyHeadDeveloperCodecToolsFixture } from "./lib/head-developer-codec-tools-fixture.mjs";

export const repositoryRoot=resolve(new URL("../",import.meta.url).pathname);

export function pluginPanelNativeFixtureDefines(dialogAcceptance=false,pageDocument=false,webStorageAcceptance=false,nodePageAcceptance=false,childNodeAcceptance=false,fileTreeHeadAcceptance=false,developerCodecToolsHeadAcceptance=false) {
  if(pageDocument&&!dialogAcceptance)throw Error("Page documents require the dedicated native dialog fixture");
  if(webStorageAcceptance&&(dialogAcceptance||pageDocument))throw Error("Web Storage acceptance is isolated from dialog and page-document fixtures");
  if(nodePageAcceptance&&(dialogAcceptance||pageDocument||webStorageAcceptance))throw Error("Page-only Node acceptance is isolated from other panel fixtures");
  if(childNodeAcceptance&&(dialogAcceptance||pageDocument||webStorageAcceptance||nodePageAcceptance))throw Error("Child-only Node acceptance is isolated from other panel fixtures");
  return {
    "import.meta.env.VITE_ATOOLS_DESKTOP_SMOKE":JSON.stringify(developerCodecToolsHeadAcceptance?"false":"true"),
    "import.meta.env.VITE_ATOOLS_NATIVE_DIALOG_ACCEPTANCE":JSON.stringify(dialogAcceptance?"true":"false"),
    "import.meta.env.VITE_ATOOLS_PLUGIN_PAGE_DOCUMENT":JSON.stringify(pageDocument?"true":"false"),
    "import.meta.env.VITE_ATOOLS_WEB_STORAGE_ACCEPTANCE":JSON.stringify(webStorageAcceptance?"true":"false"),
    "import.meta.env.VITE_ATOOLS_NODE_PAGE_ACCEPTANCE":JSON.stringify(nodePageAcceptance?"true":"false"),
    "import.meta.env.VITE_ATOOLS_CHILD_NODE_ACCEPTANCE":JSON.stringify(childNodeAcceptance?"true":"false"),
    "import.meta.env.VITE_ATOOLS_FILE_TREE_HEAD_ACCEPTANCE":JSON.stringify(fileTreeHeadAcceptance?"true":"false"),
  };
}

export async function createPanelFixtureEnvironment(root=repositoryRoot) {
  const fixture=await createFixtureEnvironment();
  try {
    const pin=JSON.parse(await readFile(join(root,"resources/node-runtime/pin.json"),"utf8"));
    const target=process.arch==="arm64"?"aarch64-apple-darwin":process.arch==="x64"?"x86_64-apple-darwin":null;
    if(!target)throw Error("Pinned panel Node runtime does not support "+process.arch);
    const binary=join(root,"src-tauri/binaries/node-"+target);
    const digest=createHash("sha256").update(await readFile(binary)).digest("hex");
    if(digest!==pin.targets[target].binarySha256)throw Error("Pinned panel Node runtime checksum mismatch");
    fixture.env.ATOOLS_NODE_BINARY=binary;
    fixture.evidence.nodeRuntime={version:pin.version,target,binarySha256:digest,binaryBytes:(await stat(binary)).size,
      inheritedBySmoke:true,nestedPathBehavior:"legacy_node::SidecarLaunchSpec prepends the selected binary directory to the sanitized child PATH"};
    return fixture;
  } catch(error) {
    await fixture.cleanup();throw error;
  }
}

export async function treeHash(directory) {
  const hash=createHash("sha256");
  async function walk(current) {
    for(const entry of (await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const item=join(current,entry.name);
      if(entry.isDirectory())await walk(item);
      else if(entry.isFile()){hash.update(relative(directory,item));hash.update(await readFile(item));}
      else throw Error("Original fixture contains unsupported symlink: "+item);
    }
  }
  await walk(directory);return hash.digest("hex");
}

function pathWithin(parent, child) {
  const relation=relative(resolve(parent),resolve(child));
  return relation===""||(!isAbsolute(relation)&&relation!==".."&&!relation.startsWith(`..${sep}`));
}

export async function buildPluginPanelNativeFixture(root=repositoryRoot,scratch=null,{dialogAcceptance=false,pageDocument=false,webStorageAcceptance=false,nodePageAcceptance=false,childNodeAcceptance=false,scenario="panel",pluginSourcesRoot,nodePagePaths,buildProfile="debug"}={}) {
  const buildPlan=nativeSmokeBuildPlan(buildProfile);
  if(!["panel","page-navigation","browser-window","web-storage","node-page","child-node","inventory-logo","pasteboard-pro-native-image","image-toolbox-original","file-tree-head","developer-codec-tools-head"].includes(scenario))throw Error("Unknown native panel fixture scenario");
  if(scenario==="pasteboard-pro-native-image"&&(dialogAcceptance||pageDocument||webStorageAcceptance||nodePageAcceptance||childNodeAcceptance||pluginSourcesRoot||nodePagePaths))
    throw Error("PasteboardPro native image scenario is isolated from other panel fixtures");
  if(scenario==="image-toolbox-original"&&(dialogAcceptance||pageDocument||webStorageAcceptance||nodePageAcceptance||childNodeAcceptance||pluginSourcesRoot||nodePagePaths))
    throw Error("Image-Toolbox original-entry scenario is isolated from other panel fixtures");
  if(scenario==="file-tree-head"&&(dialogAcceptance||pageDocument||webStorageAcceptance||nodePageAcceptance||childNodeAcceptance||pluginSourcesRoot||nodePagePaths))
    throw Error("FileTree HEAD scenario is isolated from other panel fixtures");
  if(scenario==="developer-codec-tools-head"&&(dialogAcceptance||pageDocument||webStorageAcceptance||nodePageAcceptance||childNodeAcceptance||pluginSourcesRoot||nodePagePaths))
    throw Error("Developer codec HEAD scenario is isolated from other panel fixtures");
  if(scenario==="page-navigation"&&(!dialogAcceptance||!pageDocument||!pluginSourcesRoot))
    throw Error("Page navigation requires explicit document acceptance and synthetic plugin sources");
  if(scenario==="browser-window"&&(dialogAcceptance||pageDocument||!pluginSourcesRoot))
    throw Error("Browser window acceptance requires its generated opaque plugin sources");
  if(scenario==="web-storage"&&(dialogAcceptance||pageDocument||!pluginSourcesRoot))
    throw Error("Web Storage acceptance requires its generated pure-Web plugin sources");
  if(scenario==="node-page"&&(dialogAcceptance||pageDocument||!pluginSourcesRoot||!nodePagePaths?.outputPath))
    throw Error("Page-only Node acceptance requires generated sources and fixed private paths");
  if(scenario==="child-node"&&(dialogAcceptance||pageDocument||!pluginSourcesRoot))
    throw Error("Child-only Node acceptance requires its generated opaque parent packages");
  scratch??=await mkdtemp(join(tmpdir(),"atools-full-panel-build-"));
  const plugins=pluginSourcesRoot?resolve(pluginSourcesRoot):join(root,"ZTools-plugins/plugins");
  const before={};
  if(!["inventory-logo","pasteboard-pro-native-image","image-toolbox-original","file-tree-head","developer-codec-tools-head"].includes(scenario))for(const id of ["char-transform","file-tree"])before[id]=await treeHash(join(plugins,id));
  const nativeFixtureRoot=join(scratch,"native-fixture");
  const pasteboardConsumer=scenario==="pasteboard-pro-native-image"
    ? await preparePasteboardProConsumerFixture({repositoryRoot:root,scratch,fixtureRoot:nativeFixtureRoot}) : null;
  const imageToolboxConsumer=scenario==="image-toolbox-original"
    ? await prepareImageToolboxNativeFixture({repositoryRoot:root,scratch,fixtureRoot:nativeFixtureRoot}) : null;
  const headFileTreeConsumer=scenario==="file-tree-head"?await prepareHeadFileTreeFixture({repositoryRoot:root,temporaryParent:await realpath(scratch)}):null;
  if(headFileTreeConsumer)before["file-tree"]=await treeHash(join(headFileTreeConsumer.fixture.pluginSourcesRoot,"file-tree"));
  const headDeveloperCodecToolsConsumer=scenario==="developer-codec-tools-head"?await prepareHeadDeveloperCodecToolsFixture({repositoryRoot:root,temporaryParent:await realpath(scratch)}):null;
  if(headDeveloperCodecToolsConsumer)before["developer-codec-tools"]=await treeHash(join(headDeveloperCodecToolsConsumer.fixture.pluginSourcesRoot,"developer-codec-tools"));
  const inventoryLogoSource=scenario==="inventory-logo"?join(root,"ZTools-plugins/plugins/calculation-paper/logo.png"):null;
  const inventoryLogoSourceSha256=inventoryLogoSource?createHash("sha256").update(await readFile(inventoryLogoSource)).digest("hex"):null;
  const bundle=join(scratch,"panel");await mkdir(bundle);
  await build({configFile:false,logLevel:"error",root,
    define:pluginPanelNativeFixtureDefines(dialogAcceptance,pageDocument,scenario==="web-storage",scenario==="node-page",scenario==="child-node",scenario==="file-tree-head",scenario==="developer-codec-tools-head"),
    plugins:[svelte({emitCss:false,compilerOptions:{css:"injected"}})],
    build:{outDir:bundle,minify:"esbuild",target:"safari14",cssCodeSplit:false,
      lib:{entry:join(root,"tests/components",scenario==="developer-codec-tools-head"?"nativePluginDeveloperCodecToolsSmoke.ts":scenario==="pasteboard-pro-native-image"?"nativePluginPasteboardProSmoke.ts":scenario==="image-toolbox-original"?"nativePluginImageToolboxSmoke.ts":scenario==="file-tree-head"?"nativePluginFileTreeHeadSmoke.ts":scenario==="inventory-logo"?"nativePluginInventoryLogoSmoke.ts":scenario==="child-node"?"nativePluginChildNodeSmoke.ts":scenario==="node-page"?"nativePluginNodePageSmoke.ts":scenario==="web-storage"?"nativePluginWebStorageSmoke.ts":scenario==="browser-window"?"nativePluginBrowserWindowSmoke.ts":scenario==="page-navigation"?"nativePluginPageNavigationSmoke.ts":dialogAcceptance?"nativePluginDialogSmoke.ts":"nativePluginPanelSmoke.ts"),formats:["iife"],name:"NativeProductionPanel",fileName:()=>"panel.js"},
      rollupOptions:{output:{inlineDynamicImports:true}}}});
  const cssFiles=(await readdir(bundle)).filter(name=>name.endsWith(".css"));
  const css=join(scratch,"panel.css");await writeFile(css,(await Promise.all(cssFiles.map(file=>readFile(join(bundle,file),"utf8")))).join("\n"));
  const nativeBuild=await buildNativeSmokeWithProfile(root,{profile:buildPlan.profile});
  const builtExecutable=nativeBuild.executable;
  const appBundle=dialogAcceptance?await stageNativeSmokeApp(builtExecutable,scratch):undefined;
  const executable=appBundle?.executable??builtExecutable;
  return {root,scratch,plugins:headDeveloperCodecToolsConsumer?.fixture.pluginSourcesRoot??headFileTreeConsumer?.fixture.pluginSourcesRoot??((pasteboardConsumer?.pluginRoot||imageToolboxConsumer?.pluginRoot)?join(scratch,"plugin-sources"):plugins),before,bundle,css,executable,pageDocument,scenario,inventoryLogoSource,inventoryLogoSourceSha256,pasteboardConsumer,imageToolboxConsumer,headFileTreeConsumer,headDeveloperCodecToolsConsumer,nativeFixtureRoot,nativeBuild,
    appBundle,
    probe:join(root,"tests/components",scenario==="developer-codec-tools-head"?"nativeOriginalDeveloperCodecToolsHeadFrameOperations.js":scenario==="child-node"?"nativePluginChildNodeFrameProbe.js":scenario==="node-page"?"nativePluginNodePageFrameProbe.js":scenario==="web-storage"?"nativePluginWebStorageFrameProbe.js":scenario==="browser-window"?"nativePluginBrowserWindowFrameProbe.js":scenario==="page-navigation"?"nativePluginPageNavigationFrameProbe.js":scenario==="file-tree-head"?"nativeOriginalFileTreeHeadFrameOperations.js":dialogAcceptance?"nativePluginDialogFrameOperations.js":"nativePluginFrameProbe.js")};
}

export async function runPluginPanelNativeFixture(fixture,{output,fixtureRoot,env,stdio="inherit",timeoutMs=90000,observeNavigation=false,onProcessStarted,evidenceDir=null}={}) {
  if(!output || !fixtureRoot || !env)throw Error("Native panel probe requires output, fixtureRoot, and isolated env");
  if(fixture.scenario==="pasteboard-pro-native-image"&&(!fixture.nativeFixtureRoot||resolve(fixtureRoot)!==resolve(fixture.nativeFixtureRoot)||!fixture.pasteboardConsumer?.pluginRoot))
    throw Error("PasteboardPro fixture root or generated source package does not match the isolated build fixture");
  if(fixture.scenario==="image-toolbox-original"&&(!fixture.nativeFixtureRoot||resolve(fixtureRoot)!==resolve(fixture.nativeFixtureRoot)||!fixture.imageToolboxConsumer?.pluginRoot||!fixture.imageToolboxConsumer?.originalPluginSource||!fixture.imageToolboxConsumer?.originalInputSource||!fixture.imageToolboxConsumer?.stagedInputSource||!fixture.imageToolboxConsumer?.fixtureEntryPath))
    throw Error("Image-Toolbox original source, staged entry, or fixture root does not match the isolated build fixture");
  if(fixture.scenario==="file-tree-head"&&(!fixture.nativeFixtureRoot||resolve(fixtureRoot)!==resolve(fixture.nativeFixtureRoot)
    ||!fixture.headFileTreeConsumer?.fixture?.pluginRoot||resolve(fixture.plugins)!==resolve(fixture.headFileTreeConsumer.fixture.pluginSourcesRoot)))
    throw Error("FileTree HEAD package or fixture root does not match the isolated build fixture");
  if(fixture.scenario==="developer-codec-tools-head"&&(!fixture.nativeFixtureRoot||resolve(fixtureRoot)!==resolve(fixture.nativeFixtureRoot)
    ||!fixture.headDeveloperCodecToolsConsumer?.fixture?.pluginRoot||resolve(fixture.plugins)!==resolve(fixture.headDeveloperCodecToolsConsumer.fixture.pluginSourcesRoot)))
    throw Error("Developer codec HEAD package or fixture root does not match the isolated build fixture");
  if(fixture.scenario==="image-toolbox-original"&&!evidenceDir)throw Error("Image-Toolbox export evidence requires a retained evidence directory");
  if(fixture.scenario==="image-toolbox-original") {
    const scratchPath=await realpath(fixture.scratch);
    const outputParent=await realpath(dirname(resolve(output)));
    const evidenceParent=await realpath(dirname(resolve(evidenceDir)));
    if(pathWithin(scratchPath,outputParent)||pathWithin(scratchPath,evidenceParent))throw Error("Image-Toolbox reports and retained evidence must be outside the disposable scratch tree");
    try { await lstat(evidenceDir); throw Error("Image-Toolbox evidence directory must be fresh"); }
    catch(error) { if(error?.code!=="ENOENT")throw error; }
  }
  const panelJs=join(fixture.bundle,"panel.js");
  await stat(panelJs);
  let failure, processEvidence;
  try {
    processEvidence = await runNativeProcess(fixture.executable,["--panel-ui",panelJs,"--panel-css",fixture.css,
      "--panel-probe",fixture.probe||join(fixture.root,"tests/components/nativePluginFrameProbe.js"),
      "--plugin-root",fixture.plugins,"--output",output,"--fixture-root",fixtureRoot,
      ...(fixture.scenario==="inventory-logo"?["--inventory-logo-ui","--inventory-logo-source",fixture.inventoryLogoSource]:[]),
      ...(fixture.scenario==="pasteboard-pro-native-image"?["--pasteboard-pro-native-image-ui","--pasteboard-plugin-source",fixture.pasteboardConsumer.pluginRoot]:[]),
      ...(fixture.scenario==="image-toolbox-original"?["--image-toolbox-original-ui","--image-toolbox-plugin-source",fixture.imageToolboxConsumer.originalPluginSource,"--image-toolbox-input-source",fixture.imageToolboxConsumer.originalInputSource,"--image-toolbox-fixture-entry",fixture.imageToolboxConsumer.fixtureEntryPath]:[]),
      ...(fixture.scenario==="file-tree-head"?["--file-tree-head-ui"]:[]),
      ...(fixture.scenario==="developer-codec-tools-head"?["--developer-codec-tools-head-ui"]:[]),
      ...(fixture.pageDocument?["--atools-plugin-page-document-smoke"]:[]),
      ...(fixture.scenario==="page-navigation"?[observeNavigation?"--atools-page-navigation-observe":"--atools-page-navigation-revoke"]:[]),
      ],
    {cwd:fixture.root,timeoutMs,stdio,env,onProcessStarted});
  } catch(error){failure=error;processEvidence={processObserver:error?.processObserver??null,processObserverError:error?.processObserverError??null};}
  let report;
  try{report=JSON.parse(await readFile(output,"utf8"));}
  catch(error){throw failure || error;}
  if (onProcessStarted) {
    report.processResources = processEvidence?.processObserver ?? null;
    report.processResourceObservationError = processEvidence?.processObserverError ?? null;
  }
  report.nativeBuild={profile:fixture.nativeBuild.profile,cargoArgs:fixture.nativeBuild.cargoArgs,
    targetDirectory:fixture.nativeBuild.targetDirectory,artifactRelativePath:fixture.nativeBuild.artifactRelativePath};
  let sourcesUnchanged = true;
  for(const id of Object.keys(fixture.before)) {
    if(fixture.before[id]!==await treeHash(join(fixture.plugins,id)))sourcesUnchanged=false;
  }
  if(["node-page","child-node"].includes(fixture.scenario)){
    report.generatedPackageHashes=fixture.before;
    report.generatedPackagesUnchanged=sourcesUnchanged;
  }else if(fixture.scenario==="file-tree-head"){
    report.stagedHeadPackageHashes=fixture.before;
    report.stagedHeadPackageUnchanged=sourcesUnchanged;
  }else{
    report.originalSourceHashes=fixture.before;
    report.originalSourcesUnchanged=sourcesUnchanged;
  }
  if(!sourcesUnchanged)report.passed=false;
  if(fixture.scenario==="file-tree-head") {
    report.scope="Pinned HEAD FileTree package activated through the real App media activation and TaskRun path; original scan, ignore refresh, and hidden-file control use a fixture-owned directory.";
    report.limitations=["Programmatic fixture activation and DOM controls, not physical keyboard, drag/drop, or whole-plugin UX acceptance","Only the registered FileTree package revision and fixed fixture directory were exercised; the Node grant is broader than that directory","No OS file picker, save dialog, clipboard operation, arbitrary user files, global filesystem/network sandbox, or ecosystem-wide compatibility claim"];
    report.sourceBoundOriginalPlugin=true;
    report.fileTreeInputPathKind="fixture-owned-directory";
  }
  if(fixture.scenario==="inventory-logo") {
    const afterLogo=createHash("sha256").update(await readFile(fixture.inventoryLogoSource)).digest("hex");
    report.inventoryLogoSourceSha256=fixture.inventoryLogoSourceSha256;
    report.inventoryLogoSourceUnchanged=afterLogo===fixture.inventoryLogoSourceSha256;
    if(!report.inventoryLogoSourceUnchanged)report.passed=false;
  }
  if(fixture.scenario==="pasteboard-pro-native-image") {
    report.originalConsumerSourcePins=fixture.pasteboardConsumer.sourcePins;
    if(evidenceDir) {
      await mkdir(evidenceDir,{recursive:false});
      await writeFile(join(evidenceDir,"panel.js"),await readFile(panelJs),{flag:"wx"});
      await writeFile(join(evidenceDir,"panel.css"),await readFile(fixture.css),{flag:"wx"});
      await writeFile(join(evidenceDir,"consumer-page.html"),await readFile(fixture.pasteboardConsumer.pagePath),{flag:"wx"});
      await writeFile(join(evidenceDir,"consumer-ja-class.js"),fixture.pasteboardConsumer.originalJaClass,{flag:"wx"});
      await writeFile(join(evidenceDir,"consumer-image.png"),await readFile(fixture.pasteboardConsumer.sourceImage),{flag:"wx"});
      report.retainedEvidence = ["panel.js","panel.css","consumer-page.html","consumer-ja-class.js","consumer-image.png"];
    }
  }
  if(fixture.scenario==="file-tree-head") {
    const verified=await verifyHeadFileTreeFixture(fixture.headFileTreeConsumer.fixture,fixture.root);
    report.headFileTreeSource={caseId:fixture.headFileTreeConsumer.profile.caseId,sourceCommit:verified.sourceCommit,sourceTree:verified.sourceTree,directorySha256:verified.directorySha256,fileCount:verified.fileCount,expandedBytes:verified.expandedBytes,fixtureBytesMatchPinnedSource:verified.fixtureBytesMatchPinnedSource,sourceRevisionFromGitHead:true};
    report.headFileTreeSourceUnchanged=fixture.before["file-tree"]===await treeHash(join(fixture.plugins,"file-tree"));
    if(!report.headFileTreeSource.fixtureBytesMatchPinnedSource||!report.headFileTreeSourceUnchanged)report.passed=false;
  }
  if(fixture.scenario==="developer-codec-tools-head") {
    const verified=await verifyHeadDeveloperCodecToolsFixture(fixture.headDeveloperCodecToolsConsumer.fixture,fixture.root);
    report.developerCodecToolsHeadSource={caseId:fixture.headDeveloperCodecToolsConsumer.profile.caseId,sourceCommit:verified.sourceCommit,
      sourceTree:verified.sourceTree,directorySha256:verified.directorySha256,fileCount:verified.fileCount,expandedBytes:verified.expandedBytes,
      fixtureBytesMatchPinnedSource:verified.fixtureBytesMatchPinnedSource,sourceRevisionFromGitHead:verified.sourceRevisionFromGitHead};
    report.developerCodecToolsHeadSourceUnchanged=fixture.before["developer-codec-tools"]===await treeHash(join(fixture.plugins,"developer-codec-tools"));
    report.scope="One exact Git-HEAD original Developer Codec Tools package activated through production launcher search, TaskRun, and PluginPanel; Unicode Base64 encode/decode plus malformed-input recovery in its own page.";
    report.sourceBoundOriginalPlugin=true;
    report.limitations=["One exact pinned plugin revision; programmatic keyboard/DOM events, not physical user input","Activation is covered by one TaskRun; original in-page transformations do not emit separate TaskRuns","Clipboard controls, OS dialogs, Node file access, and outbound network were not invoked; no global permission sandbox is claimed","Manifest provenance and this fixed workflow do not imply whole-plugin or ecosystem-wide compatibility"];
    if(!verified.fixtureBytesMatchPinnedSource||!report.developerCodecToolsHeadSourceUnchanged)report.passed=false;
  }
  if(fixture.scenario==="image-toolbox-original") {
    report.originalImageToolboxSourcePins=fixture.imageToolboxConsumer.sourcePins;
    if(evidenceDir) {
      await mkdir(evidenceDir,{recursive:false});
      report.retainedEvidence=[];
      const retained=await retainImageToolboxExport({nativeReportPath:output,evidenceDir,artifact:report.writtenPngArtifact});
      report.retainedImageExportEvidence=retained.passed?{passed:true,...retained.evidence}:retained;
      if(retained.passed)report.retainedEvidence.push(retained.evidence.file);
      else report.passed=false;
      await writeFile(join(evidenceDir,"panel.js"),await readFile(panelJs),{flag:"wx"});
      await writeFile(join(evidenceDir,"panel.css"),await readFile(fixture.css),{flag:"wx"});
      await writeFile(join(evidenceDir,"image-toolbox-entry.html"),await readFile(fixture.imageToolboxConsumer.entryPath),{flag:"wx"});
      await writeFile(join(evidenceDir,"image-toolbox-fixture-entry.html"),await readFile(fixture.imageToolboxConsumer.fixtureEntryPath),{flag:"wx"});
      await writeFile(join(evidenceDir,"image-input.png"),await readFile(fixture.imageToolboxConsumer.stagedInputSource),{flag:"wx"});
      report.retainedEvidence.push("panel.js","panel.css","image-toolbox-entry.html","image-toolbox-fixture-entry.html","image-input.png");
      if(report.geometryPassed!==true||report.writtenPngArtifact?.passed!==true||report.retainedImageExportEvidence?.passed!==true)report.passed=false;
    }
  }
  await writeFile(output,JSON.stringify(report,null,2));
  if(failure || !report.passed) {
    const error=failure || Error("Production Panel acceptance did not pass");
    error.panelReport=report;
    throw error;
  }
  return report;
}

async function main() {
  const cli=parseNativePanelCliOptions(process.argv.slice(2));
  nativeSmokeBuildPlan(cli.buildProfile);
  const output=resolve(cli.outputPath??join(repositoryRoot,"output/legacy-node-2026-10-15/production-plugin-panel-native.json"));
  const scratch=await mkdtemp(join(tmpdir(),"atools-full-panel-build-"));
  const scenario=cli.scenario;
  let isolated,fixture;
  try {
    fixture=await buildPluginPanelNativeFixture(repositoryRoot,scratch,{scenario,buildProfile:cli.buildProfile});
    isolated=await createPanelFixtureEnvironment(repositoryRoot);
    const evidenceDir=cli.evidenceDir?resolve(cli.evidenceDir):null;
    const report=await runPluginPanelNativeFixture(fixture,{output,fixtureRoot:fixture.nativeFixtureRoot??join(scratch,"native-fixture"),env:isolated.env,
      timeoutMs:scenario==="pasteboard-pro-native-image"?150000:scenario==="image-toolbox-original"||scenario==="developer-codec-tools-head"?120000:90000,evidenceDir});
    report.environment=isolated.evidence;
    await writeFile(output,JSON.stringify(report,null,2));
    console.log(JSON.stringify({output,...report},null,2));
  } finally {if(isolated)await isolated.cleanup();if(typeof fixture!=="undefined"&&fixture?.headFileTreeConsumer)await fixture.headFileTreeConsumer.cleanup();if(typeof fixture!=="undefined"&&fixture?.headDeveloperCodecToolsConsumer)await fixture.headDeveloperCodecToolsConsumer.cleanup();await rm(scratch,{recursive:true,force:true});}
}

if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
