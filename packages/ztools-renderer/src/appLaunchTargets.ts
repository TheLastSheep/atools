import { invalidRendererArgument } from "./errors";
import type { AppIdentity } from "./appStateProtocol";
import type { RendererLocalShortcut } from "./localShortcuts";

export interface RendererAppLaunchRequest {
  path?: unknown;
  type?: unknown;
  subType?: unknown;
  name?: unknown;
  featureCode?: unknown;
  cmdType?: unknown;
  param?: unknown;
}

export interface RendererAppLaunchTargets {
  launch(options: RendererAppLaunchRequest): Promise<unknown>;
  revealInFinder(path: unknown): Promise<unknown>;
}

export interface RendererAppLaunchTargetsOptions {
  resolveApp(path: string): Promise<{ path: string; name: string } | undefined>;
  getLocalShortcuts(): Promise<RendererLocalShortcut[]>;
  launch(target: AppIdentity): Promise<unknown>;
  revealApp(path: string): Promise<unknown>;
  openAppShortcuts?(app: { path: string; name: string; subType: "app" }): Promise<unknown>;
  revealLocal(target: AppIdentity): Promise<unknown>;
  rejectUnsupported(method: string): Promise<never>;
  ensureActive(): void;
}

const isApplicationType = (v: unknown) => v === "app" || v === "direct";
const validSubType = (v: unknown): v is undefined | "app" | "local-shortcut" =>
  v === undefined || v === "app" || v === "local-shortcut";
const validStr = (v: unknown): v is string => typeof v === "string" && !!v && !v.includes("\0");
const exactObj = (v: unknown, keys: string): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === keys;
const localIdentity = (s: RendererLocalShortcut): AppIdentity => ({
  path: s.path,
  name: s.alias || s.name,
  subType: "local-shortcut",
});

export function createRendererAppLaunchTargets(
  options: RendererAppLaunchTargetsOptions,
): RendererAppLaunchTargets {
  async function findLocalShortcut(path: string): Promise<RendererLocalShortcut | undefined> {
    const shortcuts = await options.getLocalShortcuts();
    options.ensureActive();
    return shortcuts.find((shortcut) => shortcut.path === path);
  }

  async function launch(target: RendererAppLaunchRequest): Promise<unknown> {
    options.ensureActive();
    if (target.type === "plugin" && target.featureCode === "ui.router?router=Shortcuts") {
      const app = exactObj(target.param, "payload") ? target.param.payload : null;
      if (target.name !== "快捷键" || target.cmdType !== "text" || !validStr(target.path) ||
        !exactObj(app, "name,path,subType") || app.subType !== "app" || !validStr(app.path) ||
        !validStr(app.name) || !options.openAppShortcuts) {
        return options.rejectUnsupported("launch(shortcuts-intent)");
      }
      const resolved = await options.resolveApp(app.path);
      options.ensureActive();
      return resolved
        ? options.openAppShortcuts({ path: resolved.path, name: app.name, subType: "app" })
        : options.rejectUnsupported("launch(unlisted-app-path)");
    }
    if (!validSubType(target.subType)) throw invalidRendererArgument("Invalid renderer launch subtype.");
    if (!isApplicationType(target.type) || !validStr(target.path)) {
      return options.rejectUnsupported(`launch(${String(target.type ?? "unknown")})`);
    }

    if (target.subType === "local-shortcut") {
      const shortcut = await findLocalShortcut(target.path);
      options.ensureActive();
      return shortcut ? options.launch(localIdentity(shortcut)) : options.rejectUnsupported("launch(unregistered-local-shortcut)");
    }

    const app = await options.resolveApp(target.path);
    options.ensureActive();
    if (app) {
      return options.launch({
        path: app.path,
        name: typeof target.name === "string" && target.name ? target.name : app.name,
      });
    }
    if (target.subType === "app" || target.type === "app") {
      return options.rejectUnsupported("launch(unlisted-app-path)");
    }

    const shortcut = await findLocalShortcut(target.path);
    options.ensureActive();
    return shortcut ? options.launch(localIdentity(shortcut)) : options.rejectUnsupported("launch(unlisted-app-path)");
  }

  async function revealInFinder(pathValue: unknown): Promise<unknown> {
    options.ensureActive();
    if (!validStr(pathValue)) throw invalidRendererArgument("Invalid renderer launch path.");
    const app = await options.resolveApp(pathValue);
    options.ensureActive();
    if (app) return options.revealApp(app.path);

    const shortcut = await findLocalShortcut(pathValue);
    options.ensureActive();
    return shortcut ? options.revealLocal(localIdentity(shortcut)) : options.rejectUnsupported("revealInFinder(unlisted-app-path)");
  }

  return { launch, revealInFinder };
}
