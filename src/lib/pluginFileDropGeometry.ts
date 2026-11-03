export type NativeDropPoint = { xPhysical: number; yPhysical: number; scaleFactor: number };
export type FrameDropPoint = { x: number; y: number; contentWidth: number; contentHeight: number };

/** Map host-window physical coordinates to an axis-aligned iframe content point. */
export function mapPluginFileDropPoint(point: NativeDropPoint, frame: HTMLIFrameElement,
  devicePixelRatio: number, getStyle: (element: Element) => CSSStyleDeclaration = getComputedStyle): FrameDropPoint {
  const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
  const fail = (): never => { throw new Error("ERR_ATOOLS_FILE_DROP_GEOMETRY"); };
  if (!Number.isFinite(point.xPhysical) || !Number.isFinite(point.yPhysical) || !finitePositive(point.scaleFactor)
    || !finitePositive(devicePixelRatio) || Math.abs(point.scaleFactor - devicePixelRatio) > 0.001) return fail();
  const rect = frame.getBoundingClientRect(), width = frame.clientWidth, height = frame.clientHeight;
  if (!finitePositive(width) || !finitePositive(height) || !finitePositive(rect.width) || !finitePositive(rect.height)
    || Math.abs(rect.width - frame.offsetWidth) > 0.5 || Math.abs(rect.height - frame.offsetHeight) > 0.5) return fail();
  let node: Element | null = frame;
  while (node) {
    const style = getStyle(node);
    if ((style.transform && style.transform !== "none") || (style.perspective && style.perspective !== "none")
      || (style.zoom && style.zoom !== "1" && style.zoom !== "normal")) return fail();
    node = node.parentElement;
  }
  const hostX = point.xPhysical / point.scaleFactor, hostY = point.yPhysical / point.scaleFactor;
  const left = rect.left + frame.clientLeft, top = rect.top + frame.clientTop;
  const x = hostX - left, y = hostY - top;
  if (![hostX, hostY, left, top, x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= width || y >= height) return fail();
  return { x, y, contentWidth: width, contentHeight: height };
}
