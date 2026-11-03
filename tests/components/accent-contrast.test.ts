import { describe, expect, it } from "vitest";
import { accentForegroundForAccent } from "../../src/lib/accentContrast";

function luminance(hex: string): number {
  const rgb = hex.match(/[\da-f]{2}/gi)!.map(value => Number.parseInt(value, 16) / 255);
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}
function contrast(left: string, right: string): number {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("accent foreground contrast", () => {
  it("uses white for the currently applied purple accent", () => {
    expect(accentForegroundForAccent("#7c3aed")).toBe("#ffffff");
  });

  it("chooses the higher-contrast foreground for every preset and a bright custom accent", () => {
    for (const accent of ["#0284c7", "#7c3aed", "#059669", "#ea580c", "#dc2626", "#db2777", "#facc15"]) {
      const foreground = accentForegroundForAccent(accent);
      const alternative = foreground === "#ffffff" ? "#07111f" : "#ffffff";
      expect(contrast(accent, foreground)).toBeGreaterThanOrEqual(contrast(accent, alternative));
    }
    expect(accentForegroundForAccent("#facc15")).toBe("#07111f");
  });
});
