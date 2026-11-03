import { expect, it, vi } from "vitest";
import { runConvertedTetrisScenario } from "./nativePublishedTetrisScenario";
function context() {
  const state = { ready: true, screen: "home", paused: false, theme: "modern", persistedTheme: null as string | null,
    board: null as { pixelHash: string } | null };
  const calls: string[] = [], checks: string[] = [], observations: Record<string, unknown> = {};
  const probe = vi.fn(async (operation: string) => {
    calls.push(operation);
    if (operation === "start-game") { state.screen = "game"; state.board = { pixelHash: "before" }; }
    if (operation === "move-left") { state.board = { pixelHash: "after" }; return { ...state, boardTransition: { beforeHash: "before", afterHash: "after" } }; }
    if (operation === "pause") state.paused = true;
    if (operation === "resume") state.paused = false;
    if (operation === "settings-from-pause") state.screen = "settings";
    if (operation === "set-theme-retro") { state.theme = "retro"; state.persistedTheme = "retro"; }
    if (operation === "settings-return") state.screen = "game";
    return { ...state };
  });
  return { calls, checks, observations, probe, scenario: () => runConvertedTetrisScenario({
    profile: { caseId: "converted-tetris-source" } as never, fixture: {} as never,
    check: (ok, label) => { if (!ok) throw Error(label); checks.push(label); },
    until: async read => { const value = await read(); if (!value) throw Error("unexpected incomplete UI state"); return value as never; },
    pause: async () => {}, probe: probe as never, setPhase: () => {}, observations
  }) };
}
it("runs the reviewed start, visible move, pause/resume, persisted-theme path in order", async () => {
  const f = context(); const result = await f.scenario();
  expect(f.calls).toEqual(["state", "start-game", "state", "move-left", "pause", "state", "resume", "state", "pause",
    "settings-from-pause", "set-theme-retro", "settings-return", "state"]);
  expect(f.checks).toHaveLength(2);
  expect(result.notTested).toContain("physical keyboard or pointer");
});
