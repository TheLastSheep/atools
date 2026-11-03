import { join } from "node:path";
import { expect } from "vitest";

const searchSelector = "[data-pb-search]";
const cardSelector = '[data-pb-item-id="text-old"]';
const expectedSummary = "Invoice #1042 is due on July 31 for USD 480.00.";

type ShelfControls = {
  evaluate(expression: string, awaitPromise?: boolean): Promise<any>;
  waitFor(expression: string, label: string, timeoutMs?: number): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  key(key: string, modifiers?: string[]): Promise<void>;
  screenshot(path: string): Promise<Record<string, unknown>>;
  settleRequests(): Promise<void>;
};

type ShelfReport = Record<string, any>;

export async function runPasteShelfScenario(
  page: ShelfControls,
  outputRoot: string,
  runId: string,
  report: ShelfReport,
) {
  report.scenario = { status: "running", route: "original-index-shelf-query-selection-preview" };
  report.outputs = [];

  await page.waitFor(
    `document.querySelector(${JSON.stringify(searchSelector)})&&document.querySelector('.shelf')`,
    "original Shelf and search input mounted",
  );
  await page.waitFor(
    `document.querySelectorAll('[data-pb-item-id]').length===2`,
    "both persisted original history cards loaded",
  );
  const initial = await readShelfState(page);
  expect(initial.query).toBe("");
  expect(initial.ids.slice().sort()).toEqual(["files-item", "text-old"]);
  report.initialShelf = initial;
  await capture(page, outputRoot, runId, report, "initial-shelf");

  await page.click('[role="search"]');
  await page.type(searchSelector, "Invoice");
  await page.waitFor(
    `document.querySelectorAll('[data-pb-item-id]').length===1&&document.querySelector('[data-pb-item-id="text-old"]')`,
    "original history search returns the matching text card",
  );
  const searched = await readShelfState(page);
  expect(searched.query).toBe("Invoice");
  expect(searched.ids).toEqual(["text-old"]);
  report.invoiceSearch = searched;
  await capture(page, outputRoot, runId, report, "invoice-search");

  await page.key("ArrowDown");
  await page.waitFor(
    `(()=>{const card=document.querySelector(${JSON.stringify(cardSelector)});return card?.getAttribute('aria-selected')==='true'&&document.activeElement===card})()`,
    "ArrowDown selects and focuses the original text card",
  );
  const preview = await readSelectedTextPreview(page);
  expect(preview).toMatchObject({ itemId: "text-old", selected: true, visibleText: expectedSummary, fullyVisible: true });
  report.selectedTextPreview = preview;
  await capture(page, outputRoot, runId, report, "selected-text-preview");

  const noMatchQuery = "atools-no-history-match-1042";
  await page.type(searchSelector, noMatchQuery);
  await page.waitFor(
    `document.querySelector(${JSON.stringify(searchSelector)})?.value===${JSON.stringify(noMatchQuery)}&&document.querySelectorAll('[data-pb-item-id]').length===0&&document.querySelector('.empty-state')`,
    "unmatched original history query produces the empty shelf state",
  );
  const noMatch = await readShelfState(page);
  expect(noMatch.query).toBe(noMatchQuery);
  expect(noMatch.ids).toEqual([]);
  expect(noMatch.emptyStateText).toContain("复制内容后会出现在这里");
  report.noMatch = noMatch;
  await capture(page, outputRoot, runId, report, "no-match-empty-state");

  await page.type(searchSelector, "");
  await page.waitFor(
    `document.querySelector(${JSON.stringify(searchSelector)})?.value===''&&document.querySelectorAll('[data-pb-item-id]').length===2`,
    "clearing the search input restores both original history cards",
  );
  const restored = await readShelfState(page);
  expect(restored.query).toBe("");
  expect(restored.ids.slice().sort()).toEqual(["files-item", "text-old"]);
  report.restoredShelf = restored;
  await capture(page, outputRoot, runId, report, "restored-original-shelf");
  await page.settleRequests();

  report.scenario = {
    status: "passed",
    assertions: [
      "two fixed persisted records render through the original Shelf",
      "Invoice query is relayed to the original primary preload; the driver separately verifies PluginData SQLite allDocs",
      "ArrowDown selects text-old and its complete ModernCardPreview summary is visible",
      "unmatched query renders empty state",
      "clearing the query restores the same two records",
    ],
  };
  return report.scenario;
}

async function readShelfState(page: ShelfControls) {
  return page.evaluate(`(()=>({
    query:document.querySelector(${JSON.stringify(searchSelector)})?.value??null,
    ids:[...document.querySelectorAll('[data-pb-item-id]')].map(card=>card.getAttribute('data-pb-item-id')),
    selectedIds:[...document.querySelectorAll('[data-pb-item-id][aria-selected="true"]')].map(card=>card.getAttribute('data-pb-item-id')),
    emptyStateText:document.querySelector('.empty-state')?.innerText??null,
    activeElement:{tag:document.activeElement?.tagName??null,className:document.activeElement?.className??null,
      itemId:document.activeElement?.getAttribute?.('data-pb-item-id')??null},
    viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,
    shelfMounted:Boolean(document.querySelector('.shelf')),
  }))()`);
}

async function readSelectedTextPreview(page: ShelfControls) {
  return page.evaluate(`(()=>{
    const card=document.querySelector(${JSON.stringify(cardSelector)});
    const preview=card?.querySelector('.modern-preview--text');
    const paragraph=preview?.querySelector('p');
    if(!card||!preview||!paragraph)return null;
    const r=paragraph.getBoundingClientRect();
    const style=getComputedStyle(paragraph);
    const visibleText=paragraph.innerText.trim();
    return {itemId:card.getAttribute('data-pb-item-id'),selected:card.getAttribute('aria-selected')==='true',
      title:preview.querySelector('strong')?.innerText.trim()??null,visibleText,
      fullyVisible: r.width>0&&r.height>0&&paragraph.scrollHeight<=paragraph.clientHeight+1
        &&style.display!=='none'&&style.visibility!=='hidden',
      clientHeight:paragraph.clientHeight,scrollHeight:paragraph.scrollHeight,lineClamp:style.webkitLineClamp};
  })()`);
}

async function capture(page: ShelfControls, outputRoot: string, runId: string, report: ShelfReport, name: string) {
  const screenshot = await page.screenshot(join(outputRoot, `${runId}-${name}.png`));
  report.outputs.push({ name, ...screenshot });
}
