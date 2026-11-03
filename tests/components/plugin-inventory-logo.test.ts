import { describe, expect, it, vi } from "vitest";
import { normalizeInstalledPlugin } from "../../src/lib/installedPluginBoundary";
import { pluginInventoryLogoSrc, validatedPluginInventoryLogoPath } from "../../src/lib/pluginInventoryLogo";

const installed = (fields: Record<string, unknown> = {}) => normalizeInstalledPlugin({
  id: "sample", name: "Sample", version: "1.0.0", path: "/plugins/sample", enabled: false,
  source_kind: "imported", created_at: "now", updated_at: "now", manifest: { features: [] }, ...fields,
});

describe("installed plugin logo projection", () => {
  it("accepts only absolute package PNG paths from builtin or imported records", () => {
    expect(validatedPluginInventoryLogoPath("/Users/me/.atools/plugins/sample/logo.PNG", "imported"))
      .toBe("/Users/me/.atools/plugins/sample/logo.PNG");
    expect(validatedPluginInventoryLogoPath("C:\\ATools\\plugins\\sample\\logo.png", "builtin"))
      .toBe("C:\\ATools\\plugins\\sample\\logo.png");
    for (const value of [
      "https://example.invalid/logo.png", "data:image/png;base64,AA==", "asset://localhost/logo.png",
      "file:///tmp/logo.png", "//server/share/logo.png", "\\\\server\\share\\logo.png",
      "logo.png", "/plugins/sample/../outside.png", "/plugins/./logo.png", "/plugins/sample/logo.svg",
      "/plugins/sample//logo.png", "/plugins/sample/\u0000logo.png", " /plugins/sample/logo.png",
    ]) expect(validatedPluginInventoryLogoPath(value, "imported")).toBeNull();
    expect(validatedPluginInventoryLogoPath("/plugins/sample/logo.png", "external")).toBeNull();
    expect(validatedPluginInventoryLogoPath("/plugins/sample/logo.png", undefined)).toBeNull();
  });

  it("keeps old API records and disabled imported records while dropping only unsafe logo metadata", () => {
    const oldApi = installed();
    expect(oldApi).toMatchObject({ id: "sample", enabled: false });
    expect(oldApi).not.toHaveProperty("inventory_logo_path");

    const valid = installed({ inventory_logo_path: "/plugins/sample/logo.png" });
    expect(valid).toMatchObject({ id: "sample", enabled: false, source_kind: "imported", inventory_logo_path: "/plugins/sample/logo.png" });

    const invalid = installed({ inventory_logo_path: "https://example.invalid/logo.png" });
    expect(invalid).toMatchObject({ id: "sample", inventory_logo_path: null });
    expect(installed({ inventory_logo_path: 42 })).toMatchObject({ id: "sample", inventory_logo_path: null });
  });

  it("never calls convertFileSrc for unsafe metadata, non-Tauri previews, or external plugins", () => {
    const convert = vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`);
    expect(pluginInventoryLogoSrc("https://example.invalid/a.png", "imported", true, convert)).toBeNull();
    expect(pluginInventoryLogoSrc("/plugins/a/logo.png", "external", true, convert)).toBeNull();
    expect(pluginInventoryLogoSrc("/plugins/a/logo.png", "imported", false, convert)).toBeNull();
    expect(convert).not.toHaveBeenCalled();

    expect(pluginInventoryLogoSrc("/plugins/a/logo.png", "imported", true, convert))
      .toBe("asset://localhost/%2Fplugins%2Fa%2Flogo.png");
    expect(convert).toHaveBeenCalledOnce();
  });

  it("falls back when conversion throws or returns a nonlocal URL", () => {
    expect(pluginInventoryLogoSrc("/plugins/a/logo.png", "imported", true, () => { throw Error("offline"); })).toBeNull();
    const remote = vi.fn(() => "https://example.invalid/logo.png");
    expect(pluginInventoryLogoSrc("/plugins/a/logo.png", "imported", true, remote)).toBeNull();
    expect(remote).toHaveBeenCalledOnce();
  });
});
