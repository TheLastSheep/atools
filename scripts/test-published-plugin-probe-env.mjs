import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedPluginProbeEnvironment } from "./lib/published-plugin-probe-env.mjs";

const GENERAL = "import.meta.env.VITE_ATOOLS_DESKTOP_SMOKE";
const DEEPREAD_FILES = "import.meta.env.VITE_ATOOLS_DEEPREAD_FILES_SMOKE";
const IMAGE_STITCH_FILES = "import.meta.env.VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE";

test("DeepRead fixture opts into only its dedicated gate and disables ambient VITE inputs", () => {
  assert.deepEqual(publishedPluginProbeEnvironment("converted-deepread-source"), {
    envFile: false,
    envPrefix: [],
    define: { [GENERAL]: '"false"', [DEEPREAD_FILES]: '"true"', [IMAGE_STITCH_FILES]: '"false"' }
  });
});

test("the Image Stitch head case opts into only its exact files gate", () => {
  assert.deepEqual(publishedPluginProbeEnvironment("local-image-stitch-head"), {
    envFile: false,
    envPrefix: [],
    define: { [GENERAL]: '"false"', [DEEPREAD_FILES]: '"false"', [IMAGE_STITCH_FILES]: '"true"' }
  });
});

test("every other published case explicitly keeps all smoke gates closed", () => {
  for (const caseId of ["converted-my-calculator-source", "converted-tetris-source", "unknown-case"]) {
    assert.deepEqual(publishedPluginProbeEnvironment(caseId), {
      envFile: false,
      envPrefix: [],
      define: { [GENERAL]: '"false"', [DEEPREAD_FILES]: '"false"', [IMAGE_STITCH_FILES]: '"false"' }
    });
  }
});
