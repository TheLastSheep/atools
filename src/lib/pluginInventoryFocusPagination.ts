import type { PluginInventoryBoundaryDirection } from "./pluginInventoryKeyboard";

export type PluginInventoryFocusPaginationRequest = {
  direction: PluginInventoryBoundaryDirection;
  fromPage: number;
  toPage: number;
  originPluginId: string;
  targetPluginId: string;
};

export type PluginInventoryFocusPaginationToken = Readonly<
  PluginInventoryFocusPaginationRequest & { revision: number }
>;

export type PluginInventoryFocusPaginationController = ReturnType<
  typeof createPluginInventoryFocusPaginationController
>;

export type PluginInventoryFocusPaginationNavigation = {
  controller: PluginInventoryFocusPaginationController;
  direction: PluginInventoryBoundaryDirection;
  originPluginId: string;
  originButton: HTMLButtonElement;
  rows: readonly { id: string }[];
  currentPage: number;
  pageCount: number;
  pageSize: number;
  setPage: (page: number) => void;
  afterRender: () => Promise<unknown>;
  getCurrentPage: () => number;
  getVisiblePluginIds: () => readonly string[];
  getList: () => HTMLElement | undefined;
  getActiveElement: () => Element | null;
};

export function createPluginInventoryFocusPaginationController() {
  let revision = 0;
  let pending: PluginInventoryFocusPaginationToken | null = null;

  function invalidate(): void {
    revision += 1;
    pending = null;
  }

  function begin(request: PluginInventoryFocusPaginationRequest): PluginInventoryFocusPaginationToken | null {
    if (pending) return null;
    const directionIsAdjacent = request.direction === "next"
      ? request.toPage === request.fromPage + 1
      : request.toPage === request.fromPage - 1;
    if (!directionIsAdjacent || request.fromPage < 1 || request.toPage < 1
      || !request.originPluginId || !request.targetPluginId
      || request.originPluginId === request.targetPluginId) return null;

    const token = Object.freeze({ ...request, revision: ++revision });
    pending = token;
    return token;
  }

  function complete(
    token: PluginInventoryFocusPaginationToken,
    currentPage: number,
    visiblePluginIds: readonly string[],
    focusStillOwned: boolean,
  ): string | null {
    if (pending !== token) return null;
    pending = null;
    if (token.revision !== revision || currentPage !== token.toPage || !focusStillOwned
      || !visiblePluginIds.includes(token.targetPluginId)) return null;
    return token.targetPluginId;
  }

  return {
    begin,
    complete,
    invalidate,
    isPending(token: PluginInventoryFocusPaginationToken): boolean {
      return pending === token && token.revision === revision;
    },
    get pendingTargetPluginId(): string | null {
      return pending?.targetPluginId ?? null;
    },
  };
}

export function navigatePluginInventoryFocusAcrossPage(
  input: PluginInventoryFocusPaginationNavigation,
): boolean {
  const expectedIndex = input.direction === "next"
    ? input.currentPage * input.pageSize - 1
    : (input.currentPage - 1) * input.pageSize;
  if (input.rows[expectedIndex]?.id !== input.originPluginId) return false;
  const targetRow = input.rows[expectedIndex + (input.direction === "next" ? 1 : -1)];
  const targetPage = input.currentPage + (input.direction === "next" ? 1 : -1);
  if (!targetRow || targetPage < 1 || targetPage > input.pageCount) return false;
  const token = input.controller.begin({
    direction: input.direction, fromPage: input.currentPage, toPage: targetPage,
    originPluginId: input.originPluginId, targetPluginId: targetRow.id,
  });
  if (!token) return false;

  input.setPage(targetPage);
  void input.afterRender().then(() => {
    if (!input.controller.isPending(token)) return;
    const target = Array.from(input.getList()?.querySelectorAll<HTMLButtonElement>("[data-plugin-detail-id]") ?? [])
      .find(button => button.dataset.pluginDetailId === token.targetPluginId);
    const active = input.getActiveElement();
    const focusStillOwned = active === input.originButton
      || (active === document.body && !input.originButton.isConnected);
    const claimedTarget = input.controller.complete(token, input.getCurrentPage(), input.getVisiblePluginIds(), focusStillOwned);
    if (!claimedTarget || !target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
  });
  return true;
}
