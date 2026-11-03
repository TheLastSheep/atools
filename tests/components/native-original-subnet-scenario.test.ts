import { expect, it, vi } from "vitest";
import { runOriginalSubnetScenario } from "./nativeOriginalSubnetScenario";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";
function harness(options: { wrong31?: boolean; invalidMaskAccepted?: boolean; invalidHostsAccepted?: boolean } = {}) {
  const operations: string[] = []; let rows: Record<string, string> = {}, error = "", reverse = false, hostCount = "";
  const probe = vi.fn(async (operation: string) => {
    operations.push(operation);
    if (operation.startsWith("calculate-")) {
      const bits = Number(operation.slice(10)), ordinary = bits === 24, base = ordinary ? "192.168.1." : "10.0.0.";
      rows = { "网络地址": base + (bits === 32 ? "1" : "0"), "广播地址": base + (ordinary ? "255" : "1"),
        "子网掩码": "255.255.255." + (ordinary ? "0" : bits === 31 ? "254" : "255"), "通配符掩码": "0.0.0." + (ordinary ? "255" : bits === 31 ? "1" : "0"),
        CIDR: "/" + bits, "首个可用主机": base + (bits === 31 ? "0" : "1"), "最后可用主机": base + (ordinary ? "254" : "1"),
        "可用主机数": ordinary ? "254" : bits === 31 ? (options.wrong31 ? "0" : "2") : "1", "总地址数": ordinary ? "256" : bits === 31 ? "2" : "1",
        "IP 类别": ordinary ? "C" : "A", "地址类型": "私有" }; error = "";
    } else if (operation === "invalid-mask") { rows = {}; error = options.invalidMaskAccepted ? "accepted" : "不是合法的子网掩码（连续1后接连续0）"; }
    else if (operation === "reverse-tab") { reverse = true; rows = {}; error = ""; }
    else if (operation === "reverse-30") { hostCount = "30"; error = ""; rows = { "所需主机": "30", "最小掩码": "255.255.255.224", CIDR: "/27", "网段总容量": "32", "可用主机数": "30",
      "推荐网段": "0.0.0.31 (通配符)", "指定起始IP": "192.168.1.100", "所在网段": "192.168.1.96/27", "网段范围": "192.168.1.97 ~ 192.168.1.126" }; }
    else if (operation === "reverse-zero") { hostCount = "0"; rows = {}; error = options.invalidHostsAccepted ? "accepted" : "请输入有效的主机数量（1-16777216）"; }
    else expect(operation).toBe("state");
    return { ready: true, rows: Object.entries(rows).map(([label, value]) => ({ label, value })), resultText: error,
      reverse, hostCount, startIp: "192.168.1.100", visibilityState: "hidden", documentHidden: true };
  });
  const context = { probe, check(ok: unknown, label: string) { if (!ok) throw Error(label); },
    async until(read: () => unknown, label: string) { const value = await read(); if (!value) throw Error(label); return value; },
    observations: {}, setPhase: vi.fn() } as unknown as PublishedScenarioContext;
  return { context, operations };
}
it("requires the independently fixed full /24 /31 /32 and reverse rows with original error and recovery steps", async () => {
  const test = harness(), result = await runOriginalSubnetScenario(test.context);
  expect(test.operations.filter(operation => operation !== "state")).toEqual(["calculate-24", "calculate-31", "calculate-32", "invalid-mask", "calculate-24", "reverse-tab", "reverse-30", "reverse-zero", "reverse-30"]);
  expect(test.context.observations.originalSubnetCalculations).toMatchObject({ pointToPoint: { rows: expect.arrayContaining([{ label: "可用主机数", value: "2" }]) },
    single: { rows: expect.arrayContaining([{ label: "可用主机数", value: "1" }]) }, reverseRecovered: { reverse: true, hostCount: "30" } });
  expect(result.notTested).toContain("physical keyboard/pointer");
});
it.each([{ wrong31: true }, { invalidMaskAccepted: true }, { invalidHostsAccepted: true }])("rejects a false success at the exact business boundary: %j", async options => {
  await expect(runOriginalSubnetScenario(harness(options).context)).rejects.toThrow();
});
it("independent integer arithmetic confirms the fixed /24 /31 /32 and /27 network witnesses", () => {
  const integer = (ip: string) => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
  for (const [ip, bits, network, total, usable] of [["192.168.1.100", 24, "192.168.1.0", 256, 254], ["10.0.0.1", 31, "10.0.0.0", 2, 2],
    ["10.0.0.1", 32, "10.0.0.1", 1, 1], ["192.168.1.100", 27, "192.168.1.96", 32, 30]] as const) {
    const size = 2 ** (32 - bits); expect(size).toBe(total); expect(Math.floor(integer(ip) / size) * size).toBe(integer(network));
    expect(bits >= 31 ? size : size - 2).toBe(usable);
  }
});
