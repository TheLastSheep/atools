import { describe, expect, it, vi } from "vitest";
import { focusPluginFrameWhenUnclaimed, type PluginFrameFocusOptions } from "../../src/lib/pluginFrameFocus";

function setup(activeTarget: "body" | "documentElement" | "null" | "other" = "body") {
  const body = {} as HTMLElement;
  const documentElement = {} as HTMLElement;
  const other = {} as HTMLElement;
  const document = {
    body,
    documentElement,
    activeElement: activeTarget === "body" ? body
      : activeTarget === "documentElement" ? documentElement
        : activeTarget === "other" ? other : null,
    hasFocus: vi.fn(() => true),
  } as unknown as Document;
  const node = {
    isConnected: true,
    ownerDocument: document,
    focus: vi.fn(function (this: HTMLIFrameElement) {
      Object.defineProperty(document, "activeElement", { configurable: true, value: this });
    }),
  } as unknown as HTMLIFrameElement;
  const options: PluginFrameFocusOptions = {
    isCurrentMainFrame: vi.fn(() => true),
    hasPermissionOrModal: vi.fn(() => false),
    hasSubInputRequest: vi.fn(() => false),
    hasActiveSubInput: vi.fn(() => false),
    hasActiveChild: vi.fn(() => false),
  };
  return { node, document, body, documentElement, other, options };
}

describe("focusPluginFrameWhenUnclaimed", () => {
  it.each(["body", "documentElement", "null"] as const)(
    "hands initial unclaimed focus from %s to the current iframe",
    (activeTarget) => {
      const { node, document, options } = setup(activeTarget);

      expect(focusPluginFrameWhenUnclaimed(node, options)).toBe(true);
      expect(node.focus).toHaveBeenCalledOnce();
      expect(node.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(node);
    },
  );

  it.each([
    ["navigation input", {} as HTMLInputElement],
    ["navigation button", {} as HTMLButtonElement],
    ["another control", {} as HTMLElement],
  ] as const)("does not steal focus from a %s", (_label, control) => {
      const { node, document, options } = setup("other");
      Object.defineProperty(document, "activeElement", { configurable: true, value: control });

      expect(focusPluginFrameWhenUnclaimed(node, options)).toBe(false);
      expect(node.focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(control);
  });

  it("hands retry focus to the current iframe only while the exact trigger button still owns focus", () => {
    const owned = setup("other");
    const trigger = { isConnected: true } as HTMLButtonElement;
    Object.defineProperty(owned.document, "activeElement", { configurable: true, value: trigger });
    owned.options.retryHandoffFrom = trigger;
    expect(focusPluginFrameWhenUnclaimed(owned.node, owned.options)).toBe(true);
    expect(owned.document.activeElement).toBe(owned.node);

    const moved = setup("other");
    const originalTrigger = { isConnected: true } as HTMLButtonElement;
    const userControl = {} as HTMLInputElement;
    Object.defineProperty(moved.document, "activeElement", { configurable: true, value: userControl });
    moved.options.retryHandoffFrom = originalTrigger;
    expect(focusPluginFrameWhenUnclaimed(moved.node, moved.options)).toBe(false);
    expect(moved.node.focus).not.toHaveBeenCalled();
    expect(moved.document.activeElement).toBe(userControl);
  });

  it("keeps all higher-priority focus owners in force during a retry handoff", () => {
    for (const gate of ["hasPermissionOrModal", "hasSubInputRequest", "hasActiveSubInput", "hasActiveChild"] as const) {
      const { node, document, options } = setup("other");
      const trigger = { isConnected: true } as HTMLButtonElement;
      Object.defineProperty(document, "activeElement", { configurable: true, value: trigger });
      options.retryHandoffFrom = trigger;
      options[gate] = vi.fn(() => true);
      expect(focusPluginFrameWhenUnclaimed(node, options)).toBe(false);
      expect(node.focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it("does not hand off focus from a detached retry trigger", () => {
    const { node, document, options } = setup("other");
    const trigger = { isConnected: false } as HTMLButtonElement;
    Object.defineProperty(document, "activeElement", { configurable: true, value: trigger });
    options.retryHandoffFrom = trigger;
    expect(focusPluginFrameWhenUnclaimed(node, options)).toBe(false);
    expect(node.focus).not.toHaveBeenCalled();
  });

  it.each(["stale-main-frame", "unfocused-document"] as const)(
    "does not hand off retry focus when %s blocks the current frame",
    (blockedBy) => {
      const { node, document, options } = setup("other");
      const trigger = { isConnected: true } as HTMLButtonElement;
      Object.defineProperty(document, "activeElement", { configurable: true, value: trigger });
      options.retryHandoffFrom = trigger;
      if (blockedBy === "stale-main-frame") options.isCurrentMainFrame = vi.fn(() => false);
      else vi.mocked(document.hasFocus).mockReturnValue(false);

      expect(focusPluginFrameWhenUnclaimed(node, options)).toBe(false);
      expect(node.focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
    },
  );

  it.each([
    ["permission or modal", "hasPermissionOrModal"],
    ["pending sub-input focus", "hasSubInputRequest"],
    ["active sub-input", "hasActiveSubInput"],
    ["active child frame", "hasActiveChild"],
  ] as const)("does not steal focus during %s", (_label, gate) => {
    const { node, options } = setup();
    options[gate] = vi.fn(() => true);

    expect(focusPluginFrameWhenUnclaimed(node, options)).toBe(false);
    expect(node.focus).not.toHaveBeenCalled();
  });

  it("does not focus a detached or stale main frame", () => {
    const detached = setup();
    Object.defineProperty(detached.node, "isConnected", { value: false });
    expect(focusPluginFrameWhenUnclaimed(detached.node, detached.options)).toBe(false);
    expect(detached.node.focus).not.toHaveBeenCalled();

    const stale = setup();
    stale.options.isCurrentMainFrame = vi.fn(() => false);
    expect(focusPluginFrameWhenUnclaimed(stale.node, stale.options)).toBe(false);
    expect(stale.node.focus).not.toHaveBeenCalled();
  });

  it("does not activate an unfocused native document", () => {
    const { node, document, options } = setup();
    vi.mocked(document.hasFocus).mockReturnValue(false);

    expect(focusPluginFrameWhenUnclaimed(node, options)).toBe(false);
    expect(node.focus).not.toHaveBeenCalled();
  });

  it("safely returns false when focus throws or does not take effect", () => {
    const throwing = setup();
    vi.mocked(throwing.node.focus).mockImplementation(() => { throw new Error("focus rejected"); });
    expect(focusPluginFrameWhenUnclaimed(throwing.node, throwing.options)).toBe(false);

    const ineffective = setup();
    vi.mocked(ineffective.node.focus).mockImplementation(() => {});
    expect(focusPluginFrameWhenUnclaimed(ineffective.node, ineffective.options)).toBe(false);
  });
});
