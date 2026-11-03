import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";

type CodecState = { ready: boolean; category: string; input: string; output: string; operation: string; status: string };
async function waitCodec(context: PublishedScenarioContext, accept: (state: CodecState) => boolean, message: string) {
  return context.until(async () => { const value = await context.probe<CodecState>("state"); return accept(value) ? value : null; }, message);
}

export async function runOriginalCodecScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { check, probe, setPhase, observations } = context;
  let state = await waitCodec(context, value => value.ready, "Original Developer Codec Tools did not mount its reviewed controls");
  setPhase("codec-unicode-base64-round-trip");
  await probe("select-encoding");
  await probe("base64-encode");
  state = await waitCodec(context, value => value.output === "5L2g5aW9IEFUb29scw==" && value.status === "完成", "Original Base64 encoder did not finish Unicode input");
  check(state.operation === "base64-encode", "Original operation selector runs the Base64 encoder");
  await probe("base64-decode");
  state = await waitCodec(context, value => value.output === "你好 ATools" && value.status === "完成", "Original Base64 decoder did not restore Unicode text");
  check(state.input === "5L2g5aW9IEFUb29scw==", "Base64 decoding uses the approved fixed encoded fixture");
  setPhase("codec-url-and-json-error-recovery");
  await probe("url-encode");
  state = await waitCodec(context, value => value.output === "A%20B%2B%E4%B8%AD" && value.status === "完成", "Original URL Component encoder did not encode spaces, plus and Chinese text");
  await probe("json-format");
  const pretty = '{\n  "name": "ATools",\n  "items": [\n    1,\n    2\n  ]\n}';
  state = await waitCodec(context, value => value.category === "text" && value.operation === "json-format"
    && value.output === pretty && value.status === "完成", "Original text category JSON formatter did not render formatted input");
  check(state.output === pretty, "Original JSON formatter preserves data and applies readable indentation");
  await probe("json-invalid");
  state = await waitCodec(context, value => value.category === "text" && value.operation === "json-format"
    && value.input === "{bad json}" && value.output === "" && value.status.length > 0 && value.status !== "完成",
    "Original invalid JSON operation did not clear stale output and report the parse error");
  const invalidStatus = state.status;
  const errorShown = state.output === "" && invalidStatus.length > 0 && invalidStatus !== "完成";
  check(errorShown, "Original malformed JSON clears stale output and shows an error");
  await probe("json-format");
  state = await waitCodec(context, value => value.category === "text" && value.operation === "json-format"
    && value.output === pretty && value.status === "完成", "Original JSON formatter did not recover after malformed input");
  observations.codecTools = { base64: "5L2g5aW9IEFUb29scw==", url: "A%20B%2B%E4%B8%AD", prettyJson: pretty, errorShown, invalidStatus,
    boundary: "Original category/operation selectors, input event and Execute button; no copy, paste, hash, crypto, JWT or network-dependent operation." };
  return { businessOutcome: "scoped_pass", tested: ["Unicode Base64 encoding and decoding", "URL Component encoding", "JSON formatting", "invalid JSON feedback and recovery"],
    notTested: ["copy/paste", "hash, crypto, JWT and AI functions", "large-payload performance", "physical keyboard", "other original local packages"],
    boundary: "Only fixed local inputs through the original UI; clipboard and operations with crypto, AI or external services were not invoked." };
}
