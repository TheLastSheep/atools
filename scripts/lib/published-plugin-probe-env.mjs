const GENERAL_SMOKE_FLAG = "import.meta.env.VITE_ATOOLS_DESKTOP_SMOKE";
const DEEPREAD_FILES_FLAG = "import.meta.env.VITE_ATOOLS_DEEPREAD_FILES_SMOKE";
const IMAGE_STITCH_FILES_FLAG = "import.meta.env.VITE_ATOOLS_IMAGE_STITCH_FILES_SMOKE";

/** Keeps Vite built-ins while excluding .env and ambient VITE_* fixture modes. */
export function publishedPluginProbeEnvironment(caseId) {
  return {
    envFile: false,
    envPrefix: [],
    define: {
      [GENERAL_SMOKE_FLAG]: JSON.stringify("false"),
      [DEEPREAD_FILES_FLAG]: JSON.stringify(caseId === "converted-deepread-source" ? "true" : "false"),
      [IMAGE_STITCH_FILES_FLAG]: JSON.stringify(caseId === "local-image-stitch-head" ? "true" : "false")
    }
  };
}
