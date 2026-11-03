import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginInventoryIcon from "../../src/components/PluginInventoryIcon.svelte";

const mocks = vi.hoisted(() => ({ convert: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`) }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: mocks.convert }));

beforeEach(() => {
  mocks.convert.mockClear();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});
afterEach(() => {
  cleanup();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

it("renders a decorative lazy PNG and falls back to the monogram after load failure", async () => {
  const { container, getByText } = render(PluginInventoryIcon, {
    pluginId: "sample", name: "Sample Tool", sourceKind: "imported", logoPath: "/plugins/sample/logo.png",
  });
  const icon = container.querySelector(".inventory-icon")!;
  const image = container.querySelector("img")!;
  expect(icon.getAttribute("aria-hidden")).toBe("true");
  expect(image.getAttribute("alt")).toBe("");
  expect(image.getAttribute("loading")).toBe("lazy");
  expect(image.getAttribute("decoding")).toBe("async");
  expect(image.getAttribute("src")).toBe("asset://localhost/%2Fplugins%2Fsample%2Flogo.png");

  await fireEvent.error(image);
  expect(container.querySelector("img")).toBeNull();
  expect(getByText("S")).toBeTruthy();
});

it("retries after path or plugin changes without retaining the previous image error", async () => {
  const view = render(PluginInventoryIcon, {
    pluginId: "first", name: "First", sourceKind: "imported", logoPath: "/plugins/first/logo.png",
  });
  await fireEvent.error(view.container.querySelector("img")!);
  expect(view.container.querySelector("img")).toBeNull();

  await view.rerender({ pluginId: "first", name: "First", sourceKind: "imported", logoPath: "/plugins/first/new-logo.png" });
  expect(view.container.querySelector("img")?.getAttribute("src"))
    .toBe("asset://localhost/%2Fplugins%2Ffirst%2Fnew-logo.png");

  await fireEvent.error(view.container.querySelector("img")!);
  await view.rerender({ pluginId: "renamed", name: "Renamed", sourceKind: "imported", logoPath: "/plugins/first/new-logo.png" });
  expect(view.container.querySelector("img")?.getAttribute("src"))
    .toBe("asset://localhost/%2Fplugins%2Ffirst%2Fnew-logo.png");
});

it("does not pass hostile or unavailable metadata to image src or the asset converter", () => {
  const { container, getByText, rerender } = render(PluginInventoryIcon, {
    pluginId: "remote", name: "Remote", sourceKind: "imported", logoPath: "https://example.invalid/logo.png",
  });
  expect(container.querySelector("img")).toBeNull();
  expect(getByText("R")).toBeTruthy();
  expect(mocks.convert).not.toHaveBeenCalled();

  rerender({ pluginId: "external", name: "External", sourceKind: "external", logoPath: "/outside/logo.png" });
  expect(container.querySelector("img")).toBeNull();
  expect(mocks.convert).not.toHaveBeenCalled();
});
