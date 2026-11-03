import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebStorageFixturePackages, reviewedStorageSources } from "./lib/native-web-storage-package.mjs";
import { validateWebStorageOutcome } from "./probe-plugin-web-storage-native.mjs";
import { treeHash } from "./probe-plugin-panel-native.mjs";

const root=new URL("../",import.meta.url).pathname;
function validOutcome(){return {passed:true,temporaryDataRemoved:true,allTaskRunsTerminal:true,dataRuntimeDrained:true,
  dataset:{kind:"synthetic-search-metadata-plus-generated-packages",originalPlugins:0,originalFeatures:0,
    generatedPlugins:2,generatedFeatures:2,syntheticFeatures:1200,totalFeatures:1202},
  webStorageEventStoreDrained:true,dialogRuntimeDrained:true,pathRuntimeDrained:true,originalSourcesUnchanged:true,
  pageDocumentMode:false,pageDocumentsAfterCleanup:0,resourceLeasesAfterCleanup:0,taskRuns:1,reviewedOriginalClassesOnly:true,
  checks:{complete:true},dataRuntimeAfterCleanup:{webStorageEvents:0,webStorageEventBytes:0},observations:{
    originalClassChecks:{themeApplied:true,radioChecked:true,sidebarCollapsed:true,sidebarStored:true},
    peerStorageEvent:{present:true,keyMatches:true,oldMatches:true,newMatches:true,urlMatches:true,storageAreaMatches:true},
    persistence:{themeApplied:true,themeRadioChecked:false,sidebarRestored:true,iconRestored:true},
    persistedKeys:{theme:true,sidebar:true,namespace:true},reopenAfterB:{theme:true,sidebar:true,namespace:true},
    activeSessionCounts:{dataSessions:2,webStorageEventEmitMismatches:0},
    sameValueEventWindow:{quietWindowMs:250,targetEvents:0,nativeEventsBefore:6,nativeEventsAfter:6,
      nativeBytesBefore:384,nativeBytesAfter:384,evictionsBefore:0,evictionsAfter:0},
    boundedEnumeration:{syntheticKeys:128,enumeratedSyntheticKeys:128,entriesCalls:1,elapsedMs:1},
  }};}
const scratch=await mkdtemp(join(tmpdir(),"atools-native-web-storage-test-"));
try {
  await validateWebStorageOutcome(validOutcome());
  const overBudget=validOutcome();overBudget.observations.boundedEnumeration.entriesCalls=65;
  await assert.rejects(()=>validateWebStorageOutcome(overBudget));
  const mislabeled=validOutcome();mislabeled.dataset.originalPlugins=2;
  await assert.rejects(()=>validateWebStorageOutcome(mislabeled));
  const fixture=await createWebStorageFixturePackages(root,scratch);
  assert.deepEqual(fixture.packageIds,["file-tree","char-transform"]);
  for(const id of fixture.packageIds){
    const directory=join(fixture.directory,id),manifest=JSON.parse(await readFile(join(directory,"plugin.json"),"utf8"));
    assert.equal(manifest.version,"0.0.0-synthetic");assert.equal(manifest.preload,undefined);
    assert.equal(await stat(join(directory,"preload.js")).catch(()=>null),null);
    assert.deepEqual((await readdir(directory)).sort(),["index.html","plugin.json"]);
    assert.equal((await treeHash(directory)).length,64);
  }
  const [theme,ui]=await Promise.all([readFile(join(root,reviewedStorageSources.theme.path),"utf8"),
    readFile(join(root,reviewedStorageSources.ui.path),"utf8")]);
  const a=await readFile(join(fixture.directory,"file-tree/index.html"),"utf8");
  const b=await readFile(join(fixture.directory,"char-transform/index.html"),"utf8");
  assert.ok(a.includes(theme),"A embeds the complete hash-pinned original ThemeManager source");
  assert.ok(a.includes(ui),"A embeds the complete hash-pinned original UIManager source");
  assert.ok(a.includes("sidebarCollapseBtn")&&a.includes("theme_preference"),"A has only the minimal DOM needed by the reviewed original methods");
  assert.ok(!b.includes(theme)&&!b.includes(ui),"B contains no reviewed original class");
  assert.ok(b.includes("localStorage"),"B is a generated independent localStorage namespace fixture");
  console.log("Native Web Storage fixture passed: both generated packages are synthetic/no-preload; A embeds only the complete fixed-hash classes with minimal DOM; B remains separate");
} finally {await rm(scratch,{recursive:true,force:true});}
