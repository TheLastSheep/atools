import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

/** A fixture owns these directories. This is environment isolation, not an OS sandbox. */
export async function createFixtureEnvironment() {
  const root = await mkdtemp("/private/tmp/atools-fixture-environment-");
  const folders = Object.fromEntries(["home", "config", "data", "cache", "state", "runtime", "tmp", "appdata", "localappdata"]
    .map(name => [name, join(root, name)]));
  await Promise.all(Object.values(folders).map(folder => mkdir(folder, { mode: 0o700 })));
  // Never spread process.env: credentials, ADMIN_*, NODE_OPTIONS and user app
  // configuration must not reach the fixture or its normally inheriting children.
  const env = {
    PATH: [...new Set([dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter),
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "UTC", USER: "atools-fixture", LOGNAME: "atools-fixture",
    HOME: folders.home, USERPROFILE: folders.home, HOMEPATH: folders.home, HOMEDRIVE: "",
    XDG_CONFIG_HOME: folders.config, XDG_CONFIG_DIRS: folders.config,
    XDG_DATA_HOME: folders.data, XDG_DATA_DIRS: folders.data,
    XDG_CACHE_HOME: folders.cache, XDG_STATE_HOME: folders.state, XDG_RUNTIME_DIR: folders.runtime,
    APPDATA: folders.appdata, LOCALAPPDATA: folders.localappdata,
    TMPDIR: folders.tmp, TMP: folders.tmp, TEMP: folders.tmp,
  };
  let cleaned = false;
  return {
    env, root,
    evidence: { environmentKeys: Object.keys(env).sort(), inheritedAmbientEnvironment: false,
      privateConfigurationAndTempDirectories: true, scope: "Environment only; hardcoded absolute paths and native networking require separate source screening." },
    async cleanup() {
      if (!cleaned) { await rm(root, { recursive: true, force: true }); cleaned = true; }
      return { isolatedEnvironmentRemoved: true };
    },
  };
}
