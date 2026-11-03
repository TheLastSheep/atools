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

function isApplicationType(value: unknown): boolean {
  return value === "app" || value === "direct";
}

function validSubType(value: unknown): value is undefined | "app" | "local-shortcut" {
  return value === undefined || value === "app" || value === "local-shortcut";
}

function localIdentity(shortcut: RendererLocalShortcut): AppIdentity {
  return {
    path: shortcut.path,
    name: shortcut.alias || shortcut.name,
    subType: "local-shortcut",
  };
}

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
      if (target.name !== "快捷键" || target.cmdType !== "text" || typeof target.path !== "string" || !target.path || target.path.includes("\0"))
        return options.rejectUnsupported("launch(shortcuts-intent)");
      const param = target.param;
      if (!param || typeof param !== "object" || Array.isArray(param) ||
        Object.keys(param).sort().join(",") !== "payload") return options.rejectUnsupported("launch(shortcuts-intent)");
      const app = (param as { payload?: unknown }).payload;
      if (!app || typeof app !== "object" || Array.isArray(app) ||
        Object.keys(app).sort().join(",") !== "name,path,subType") return options.rejectUnsupported("launch(shortcuts-intent)");
      const candidate = app as Record<string, unknown>;
      if (candidate.subType !== "app" || typeof candidate.path !== "string" || !candidate.path || candidate.path.includes("\0") ||
        typeof candidate.name !== "string" || !candidate.name || candidate.name.includes("\0") || !options.openAppShortcuts)
        return options.rejectUnsupported("launch(shortcuts-intent)");
      const resolved = await options.resolveApp(candidate.path);
      options.ensureActive();
      if (!resolved) return options.rejectUnsupported("launch(unlisted-app-path)");
      return options.openAppShortcuts({ path: resolved.path, name: candidate.name, subType: "app" });
    }
    if (!validSubType(target.subType)) throw invalidRendererArgument("Invalid renderer launch subtype.");
    if (!isApplicationType(target.type) || typeof target.path !== "string" || !target.path
      || target.path.includes("\0")) {
      return options.rejectUnsupported(`launch(${String(target.type ?? "unknown")})`);
    }

    if (target.subType === "local-shortcut") {
      const shortcut = await findLocalShortcut(target.path);
      options.ensureActive();
      if (shortcut) return options.launch(localIdentity(shortcut));
      return options.rejectUnsupported("launch(unregistered-local-shortcut)");
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
    if (shortcut) return options.launch(localIdentity(shortcut));
    return options.rejectUnsupported("launch(unlisted-app-path)");
  }

  async function revealInFinder(pathValue: unknown): Promise<unknown> {
    options.ensureActive();
    if (typeof pathValue !== "string" || !pathValue || pathValue.includes("\0")) {
      throw invalidRendererArgument("Invalid renderer launch path.");
    }
    const app = await options.resolveApp(pathValue);
    options.ensureActive();
    if (app) return options.revealApp(app.path);

    const shortcut = await findLocalShortcut(pathValue);
    options.ensureActive();
    if (shortcut) return options.revealLocal(localIdentity(shortcut));
    return options.rejectUnsupported("revealInFinder(unlisted-app-path)");
  }

  return { launch, revealInFinder };
}
