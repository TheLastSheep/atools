export type PluginDesktopCaptureSource = {
  id: string;
  name: string;
  type: "screen";
  display_id: string;
  thumbnail: null;
  appIcon: null;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
};

type ScreenLike = {
  width?: unknown;
  height?: unknown;
  availLeft?: unknown;
  availTop?: unknown;
  availWidth?: unknown;
  availHeight?: unknown;
};

export function desktopCaptureSourcesForDisplay(
  options: unknown,
  screenInfo: ScreenLike | null | undefined,
  devicePixelRatio: unknown,
): PluginDesktopCaptureSource[] {
  if (!captureSourceTypes(options).includes("screen")) {
    return [];
  }

  const width = screenNumber(screenInfo?.width, 0);
  const height = screenNumber(screenInfo?.height, 0);
  const workX = screenNumber(screenInfo?.availLeft, 0);
  const workY = screenNumber(screenInfo?.availTop, 0);
  const workWidth = screenNumber(screenInfo?.availWidth, width);
  const workHeight = screenNumber(screenInfo?.availHeight, height);

  return [{
    id: "screen:1",
    name: "Primary Display",
    type: "screen",
    display_id: "1",
    thumbnail: null,
    appIcon: null,
    bounds: { x: 0, y: 0, width, height },
    workArea: { x: workX, y: workY, width: workWidth, height: workHeight },
    scaleFactor: screenScaleFactor(devicePixelRatio),
  }];
}

function captureSourceTypes(options: unknown): string[] {
  const record = options && typeof options === "object" ? options as Record<string, unknown> : {};
  if (!Array.isArray(record.types)) return ["screen"];
  const types = record.types.filter((type): type is string => typeof type === "string");
  return types.length > 0 ? types : ["screen"];
}

function screenNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function screenScaleFactor(value: unknown): number {
  const ratio = screenNumber(value, 1);
  return ratio > 0 ? ratio : 1;
}
