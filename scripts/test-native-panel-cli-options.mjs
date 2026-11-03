import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNativePanelCliOptions } from "./lib/native-panel-cli-options.mjs";

test("legacy positional output path remains the only positional argument",()=>{
  assert.deepEqual(parseNativePanelCliOptions(["/tmp/report.json"]),{
    buildProfile:"debug",evidenceDir:null,scenario:"panel",outputPath:"/tmp/report.json",
  });
});

test("no output path defaults cleanly while flags are parsed",()=>{
  assert.deepEqual(parseNativePanelCliOptions(["--inventory-logo","--build-profile","release"]),{
    buildProfile:"release",evidenceDir:null,scenario:"inventory-logo",outputPath:null,
  });
});

test("profile and evidence options work in either order without treating values as output",()=>{
  const expected={buildProfile:"release",evidenceDir:"/tmp/evidence",scenario:"pasteboard-pro-native-image",outputPath:"/tmp/report.json"};
  assert.deepEqual(parseNativePanelCliOptions(["/tmp/report.json","--build-profile","release","--evidence-dir","/tmp/evidence","--pasteboard-pro-native-image"]),expected);
  assert.deepEqual(parseNativePanelCliOptions(["--evidence-dir","/tmp/evidence","--pasteboard-pro-native-image","--build-profile","release","/tmp/report.json"]),expected);
});

test("Image-Toolbox original entry scenario parses alongside profile and evidence",()=>{
  assert.deepEqual(parseNativePanelCliOptions(["--image-toolbox-original","--build-profile","debug","--evidence-dir","/tmp/evidence"]),{
    buildProfile:"debug",evidenceDir:"/tmp/evidence",scenario:"image-toolbox-original",outputPath:null,
  });
});

test("missing values, duplicate profile, invalid profile, extra positional, and unknown options fail closed",()=>{
  for(const args of [
    ["--build-profile"],
    ["--build-profile","release","--build-profile","debug"],
    ["--build-profile","optimized"],
    ["--evidence-dir"],
    ["one.json","two.json"],
    ["--unexpected"],
    ["--inventory-logo","--pasteboard-pro-native-image"],
    ["--image-toolbox-original","--inventory-logo"],
    ["--image-toolbox-original","--image-toolbox-original"],
  ])assert.throws(()=>parseNativePanelCliOptions(args));
});

test("FileTree HEAD scenario is mutually exclusive and preserves other CLI defaults",()=>{
  assert.deepEqual(parseNativePanelCliOptions(["--file-tree-head","--build-profile","debug"]),{
    buildProfile:"debug",evidenceDir:null,scenario:"file-tree-head",outputPath:null,
  });
  assert.throws(()=>parseNativePanelCliOptions(["--file-tree-head","--inventory-logo"]));
});


test("FileTree HEAD scenario is explicit and mutually exclusive",()=>{
  assert.deepEqual(parseNativePanelCliOptions(["--file-tree-head","/tmp/file-tree.json"]),{
    buildProfile:"debug",evidenceDir:null,scenario:"file-tree-head",outputPath:"/tmp/file-tree.json",
  });
  assert.throws(()=>parseNativePanelCliOptions(["--file-tree-head","--image-toolbox-original"]));
});

test("Developer Codec Tools HEAD scenario is explicit and cannot combine with other panel profiles",()=>{
  assert.deepEqual(parseNativePanelCliOptions(["--developer-codec-tools-head","--build-profile","debug"]),{
    buildProfile:"debug",evidenceDir:null,scenario:"developer-codec-tools-head",outputPath:null,
  });
  assert.throws(()=>parseNativePanelCliOptions(["--developer-codec-tools-head","--file-tree-head"]));
  assert.throws(()=>parseNativePanelCliOptions(["--developer-codec-tools-head","--developer-codec-tools-head"]));
});
