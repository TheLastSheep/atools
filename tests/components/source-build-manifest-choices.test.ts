import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it } from "vitest";
import SourceBuildManifestChoices from "../../src/components/SourceBuildManifestChoices.svelte";
import type { SourceBuildInspection } from "../../src/lib/pluginSourceBuildProtocol";

afterEach(() => cleanup());

it("renders repeated feature codes in order without duplicate keyed-each failures", () => {
  const identity = { id: "deepread", version: "1.0.0", main: "index.html", preload: null, runtime: "web" as const,
    featureCodes: ["repeat", "repeat", "after"] };
  const inspection: SourceBuildInspection = {
    status: "eligible", pluginId: identity.id, version: identity.version, blockers: [], sourceRevision: "a".repeat(64),
    manifestSelection: "root", manifestSha256: "b".repeat(64), manifestIdentity: identity,
    manifestCandidates: [
      { selection: "root", status: "valid", manifestSha256: "b".repeat(64), identity },
      { selection: "public", status: "valid", manifestSha256: "c".repeat(64), identity },
    ], manifestDifferences: [],
  };
  const { container } = render(SourceBuildManifestChoices, { inspection, confirmed: true, disabled: false, onchoose: () => {} });
  expect(container.querySelectorAll("ul li")).toHaveLength(6);
  expect(screen.getAllByText("repeat")).toHaveLength(4);
  expect([...container.querySelectorAll("ul")].map(list => [...list.querySelectorAll("li")].map(item => item.textContent)))
    .toEqual([["repeat", "repeat", "after"], ["repeat", "repeat", "after"]]);
});
