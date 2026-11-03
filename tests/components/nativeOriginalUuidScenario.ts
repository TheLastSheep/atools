import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";

type UuidState = { ready: boolean; input: string; badge: string; meta: string; error: string; selftestError: string;
  rows: Array<{ label: string; value: string }>; visibilityState: string; documentHidden: boolean };
const COMMAND = "uuid5 dns example.com", UUID = "cfbff0d1-9375-5685-968c-48ce8b15ae17";

export async function runOriginalUuidScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { until, probe, check, observations, setPhase } = context;
  const wait = (accept: (state: UuidState) => boolean, label: string) => until(async () => {
    const state = await probe<UuidState>("inspect-result"); observations.originalUuidLastState = state;
    return state.ready && !state.selftestError && accept(state) ? state : null;
  }, label);
  await wait(() => true, "Original UUID page did not mount or its own self-test failed");
  const input = await until(() => {
    const nodes = document.querySelectorAll<HTMLInputElement>('.plugin-navigation input.sub-input[aria-label="插件搜索"]');
    return nodes.length === 1 && !nodes[0].disabled && !nodes[0].readOnly ? nodes[0] : null;
  }, "Original UUID did not expose its real production host sub-input");
  const enter = (value: string) => {
    check(input.isConnected && !input.closest("[hidden],[inert]"), "UUID host sub-input remains available in the current panel");
    input.focus(); input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  setPhase("original-uuid-host-subinput-deterministic-generation"); enter(COMMAND);
  const generated = await wait(state => state.input === COMMAND && state.badge === "生成 UUIDv5（确定性）"
    && state.rows.some(row => row.label === "标准 UUID" && row.value === UUID), "Host sub-input did not reach the original UUID deterministic generator");
  check(generated.meta.includes("dns") && generated.meta.includes("example.com") && !generated.error,
    "Actual host sub-input callback renders the independently fixed UUIDv5 DNS result in the original page");
  observations.originalUuidGenerated = generated;
  setPhase("original-uuid-host-subinput-error-recovery"); enter("not/valid!!");
  const rejected = await wait(state => state.input === "not/valid!!" && state.badge === "无法识别" && !!state.error,
    "Original UUID did not render invalid input from the actual host sub-input");
  enter(COMMAND);
  const recovered = await wait(state => state.input === COMMAND && state.rows.some(row => row.label === "标准 UUID" && row.value === UUID)
    && state.badge === "生成 UUIDv5（确定性）" && !state.error, "Original UUID deterministic result did not recover after invalid host input");
  check(recovered.rows.length >= 6 && input.value === COMMAND, "Original UUID recovers all encoding rows and retains the host input text");
  observations.originalUuidRecovery = { rejected, recovered, hostInputValue: input.value };
  return { tested: ["production host sub-input DOM event through the plugin callback", "fixed UUIDv5 DNS result", "original invalid-input error and recovery", "original self-test absence of failure"],
    notTested: ["physical keyboard/pointer", "foreground paint and visual comparison", "clipboard and regex auto-copy", "random UUID generation", "all UUID codecs and versions"],
    boundary: "Programmatic input events on the actual production host sub-input. The adapter only reads original DOM; no private callback, UUID function, model or clipboard call is substituted." };
}
