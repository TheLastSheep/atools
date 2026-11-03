import { describe, expect, it } from "vitest";
import { homeWindowHeightFor, LAUNCHER_LAYOUT } from "../../src/lib/launcherWindowLayout";
import type { RecommendedCommand } from "../../src/lib/uiState";

function commands(pinnedCount: number, recentCount: number): RecommendedCommand[] {
  return [
    ...Array.from({ length: pinnedCount }, (_, index) => ({
      code: `pinned-${index}`,
      label: `固定 ${index}`,
      explain: "固定命令",
      source: "pinned" as const,
    })),
    ...Array.from({ length: recentCount }, (_, index) => ({
      code: `recent-${index}`,
      label: `最近 ${index}`,
      explain: "最近使用",
      source: "history" as const,
    })),
  ];
}

describe("home window geometry", () => {
  it.each([0, 1, 9])("uses the 280px minimum for %i recent commands", count => {
    expect(homeWindowHeightFor(commands(0, count))).toBe(280);
  });

  it("adds a full 86px row when recent commands exceed the nine-column grid", () => {
    expect(homeWindowHeightFor(commands(0, 10))).toBe(364);
  });

  it("does not reserve a recent section when only pinned commands exist", () => {
    expect(homeWindowHeightFor(commands(1, 0))).toBe(280);
  });

  it("adds one section header and gap for one pinned row plus two recent rows", () => {
    expect(homeWindowHeightFor(commands(1, 10))).toBe(478);
  });

  it("keeps sparse section separation and sizes large command sets without a fixed cap", () => {
    expect(homeWindowHeightFor(commands(1, 1))).toBe(392);
    expect(homeWindowHeightFor(commands(90, 90))).toBe(1940);
    expect(LAUNCHER_LAYOUT).not.toHaveProperty("homeMaxWindowHeight");
  });
});
