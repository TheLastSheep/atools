import assert from "node:assert/strict";
import {validatePanelDataset,describe} from "./benchmark-plugin-panel-native.mjs";
const dataset={kind:"synthetic-search-metadata-plus-original-plugin-business",syntheticPlugins:2,syntheticFeatures:1200,originalPlugins:2,originalFeatures:2,totalFeatures:1202,
  groups:[{pluginId:"a",query:"甲组",featureCount:600,originalQueryMatches:1,expectedQueryResults:601},{pluginId:"b",query:"乙组",featureCount:600,originalQueryMatches:1,expectedQueryResults:601}],scope:"Synthetic search scale with original over-rule matches; two original business plugins only"};
const performance={dataset,launcherReadyMs:1,firstSearchAfterLauncherReady:{elapsedMs:2},warmSearch:Array.from({length:20},(_,index)=>{
  const group=dataset.groups[index%2];return {pluginId:group.pluginId,featureId:group.pluginId,query:group.query,resultCount:group.expectedQueryResults,renderedRows:12,elapsedMs:3};
}),resources:[],quietIdleWindows:[],focusRestore:[]};
const outcome={dataset,syntheticMetadataNeverActivated:true,observations:{performance}};
assert.equal(validatePanelDataset(outcome),dataset);
assert.deepEqual(describe([outcome]).dataset,dataset);
assert.equal(describe([outcome]).warmSearchReadyMs.sampleCount,20);
for(const mutate of [value=>value.dataset.syntheticFeatures=2,value=>value.dataset.originalPlugins=1200,
  value=>value.syntheticMetadataNeverActivated=false,value=>value.observations.performance.warmSearch[1].pluginId="a",
  value=>value.observations.performance.warmSearch[0].resultCount=600,value=>value.observations.performance.warmSearch[0].renderedRows=33,
  value=>value.dataset.groups[0].originalQueryMatches=3,value=>value.dataset.groups[0].expectedQueryResults=600]) {
  const invalid=structuredClone(outcome);mutate(invalid);assert.throws(()=>validatePanelDataset(invalid));
}
console.log("Native panel dataset validation passed: 1200 synthetic features, two original business plugins, exact 600+1 original-over query results, bounded DOM");
