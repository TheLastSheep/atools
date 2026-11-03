import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";

type ContentState = { ready: boolean; input: string; output: string };
async function waitOutput(context: PublishedScenarioContext, expected: (value: ContentState) => boolean, message: string) {
  return context.until(async () => { const value = await context.probe<ContentState>("state"); return expected(value) ? value : null; }, message);
}
const INPUT = "  A\t  B  \n\n\nRead **ZTools** at [site](https://z.tools). #效率 ";

export async function runOriginalContentScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { check, probe, setPhase, observations } = context;
  let state = await waitOutput(context, value => value.ready, "Original Content Workbench did not mount its reviewed controls");
  setPhase("content-normalize-and-markdown-plain-text");
  await probe("set-input", { value: INPUT });
  state = await waitOutput(context, value => value.input === INPUT, "Original content textarea did not receive the synthetic input event");
  await probe("normalize");
  const normalized = "A B\n\nRead **ZTools** at [site](https://z.tools). #效率";
  state = await waitOutput(context, value => value.output === normalized, "Original text sanitization output did not match the source behavior");
  await probe("plain");
  const plain = "A B\n\nRead ZTools at site. 效率";
  state = await waitOutput(context, value => value.output === plain, "Original Markdown-to-plain-text result did not render");
  check(state.output === plain, "Original Markdown conversion removes formatting while retaining link label and text");
  setPhase("content-link-json-and-social-layout");
  await probe("links");
  const links = JSON.stringify([{ label: "site", url: "https://z.tools" }], null, 2);
  state = await waitOutput(context, value => value.output === links, "Original extracted-link JSON did not render");
  check(state.output === links, "Original link extraction returns the actual Markdown link as structured JSON");
  await probe("social");
  const social = "A B Read **ZTools** at [site](https://z.tools).\n\n#效率";
  state = await waitOutput(context, value => value.output === social, "Original social-post formatting did not render");
  check(state.output === social, "Original social formatting moves the hashtag below the body");
  observations.contentWorkbench = { normalized, plain, links: JSON.parse(links), social,
    boundary: "Original buttons and textarea only; example URL is compared as text and is never requested." };
  return { businessOutcome: "scoped_pass", tested: ["text sanitization", "Markdown-to-plain-text conversion", "link extraction JSON", "social-post hashtag layout"],
    notTested: ["reading statistics", "arbitrary URLs or network access", "clipboard", "physical keyboard", "other original local packages"],
    boundary: "Fixed synthetic content sent only through the original textarea and button handlers; no network, plugin service or clipboard calls." };
}
