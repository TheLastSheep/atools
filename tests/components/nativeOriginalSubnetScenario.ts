import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";
type SubnetState = { ready: boolean; ip: string; mask: string; hostCount: string; startIp: string; reverse: boolean; resultText: string;
  rows: Array<{ label: string; value: string }>; visibilityState: string; documentHidden: boolean };
const MASK_ERROR = "不是合法的子网掩码（连续1后接连续0）", HOST_ERROR = "请输入有效的主机数量（1-16777216）";
export async function runOriginalSubnetScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { probe, until, observations, check, setPhase } = context;
  await until(async () => (await probe<SubnetState>("state")).ready, "Original subnet inputs and button did not mount");
  async function rows(operation: string, expected: Record<string, string>, count: number) {
    await probe(operation);
    const state = await until(async () => {
      const value = await probe<SubnetState>("state"); observations.originalSubnetLast = value;
      return value.rows.length === count && Object.entries(expected).every(([label, expectedValue]) =>
        value.rows.filter(row => row.label === label && row.value === expectedValue).length === 1) ? value : null;
    }, "Original subnet rendered rows differ from independently fixed " + operation + " expectations");
    check(state.rows.length === count, "Original subnet " + operation + " renders all independently fixed rows through the original button");
    return state;
  }
  setPhase("original-subnet-ipv4-24-31-32");
  const ordinary = await rows("calculate-24", { "网络地址": "192.168.1.0", "广播地址": "192.168.1.255", "子网掩码": "255.255.255.0",
    "通配符掩码": "0.0.0.255", CIDR: "/24", "首个可用主机": "192.168.1.1", "最后可用主机": "192.168.1.254", "可用主机数": "254", "总地址数": "256", "IP 类别": "C", "地址类型": "私有" }, 11);
  const pointToPoint = await rows("calculate-31", { "网络地址": "10.0.0.0", "广播地址": "10.0.0.1", "子网掩码": "255.255.255.254",
    "通配符掩码": "0.0.0.1", CIDR: "/31", "首个可用主机": "10.0.0.0", "最后可用主机": "10.0.0.1", "可用主机数": "2", "总地址数": "2", "IP 类别": "A", "地址类型": "私有" }, 11);
  const single = await rows("calculate-32", { "网络地址": "10.0.0.1", "广播地址": "10.0.0.1", "子网掩码": "255.255.255.255",
    "通配符掩码": "0.0.0.0", CIDR: "/32", "首个可用主机": "10.0.0.1", "最后可用主机": "10.0.0.1", "可用主机数": "1", "总地址数": "1", "IP 类别": "A", "地址类型": "私有" }, 11);
  setPhase("original-subnet-invalid-mask-recovery"); await probe("invalid-mask");
  const invalidMask = await until(async () => { const value = await probe<SubnetState>("state"); return value.resultText === MASK_ERROR && value.rows.length === 0 ? value : null; }, "Original subnet did not reject a noncontiguous mask");
  const maskRecovered = await rows("calculate-24", { "网络地址": "192.168.1.0", CIDR: "/24", "可用主机数": "254" }, 11);
  setPhase("original-subnet-reverse-30-error-recovery"); await probe("reverse-tab");
  const reverseExpected = { "所需主机": "30", "最小掩码": "255.255.255.224", CIDR: "/27", "网段总容量": "32", "可用主机数": "30",
    "推荐网段": "0.0.0.31 (通配符)", "指定起始IP": "192.168.1.100", "所在网段": "192.168.1.96/27", "网段范围": "192.168.1.97 ~ 192.168.1.126" };
  const reverse = await rows("reverse-30", reverseExpected, 9);
  check(reverse.reverse && reverse.hostCount === "30" && reverse.startIp === "192.168.1.100", "Original reverse tab uses the fixed host count and start IP");
  await probe("reverse-zero");
  const invalidHosts = await until(async () => { const value = await probe<SubnetState>("state"); return value.resultText === HOST_ERROR && value.rows.length === 0 ? value : null; }, "Original subnet did not reject host count zero");
  const reverseRecovered = await rows("reverse-30", reverseExpected, 9);
  observations.originalSubnetCalculations = { ordinary, pointToPoint, single, invalidMask, maskRecovered, reverse, invalidHosts, reverseRecovered };
  return { tested: ["original /24 calculation", "original /31 two-host and /32 single-host boundaries", "noncontiguous-mask error and recovery",
    "original reverse tab and 30-host /27 network", "host-zero error and recovery"],
    notTested: ["physical keyboard/pointer", "foreground paint and visual comparison", "clipboard and result-value clicks", "all IPv4 cases or IPv6", "performance with repeated calculations"],
    boundary: "Fixed ordinary DOM input events and original button/tab clicks only. Every expected value is independently fixed in this verifier. No calculate, calculateReverse, render, preload service, result-value click, clipboard or storage call is substituted. Exact Electron-only preload runs with Web runtime and zero Node, data or path permissions." };
}
