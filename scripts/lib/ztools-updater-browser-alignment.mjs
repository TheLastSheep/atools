import assert from 'node:assert/strict';

/** One fixed Markdown fixture heading, not a global computed-style normalization. */
export function readFixedUpdaterHeadingAlignment(owner = document) {
  const selector = '.changelog th:last-child', cells = owner.querySelectorAll(selector), cell = cells[0];
  if (cells.length !== 1) return { selector, matches: cells.length };
  const computed = owner.defaultView.getComputedStyle(cell), rect = cell.getBoundingClientRect();
  const range = owner.createRange(); range.selectNodeContents(cell);
  const textRect = range.getBoundingClientRect();
  const box = value => ({ left: value.left, right: value.right, width: value.width });
  return { selector, matches: cells.length, tag: cell.tagName, text: cell.textContent.trim(),
    childElements: cell.childElementCount, attribute: cell.getAttribute('align'), property: cell.align,
    computed: computed.textAlign, direction: computed.direction, writingMode: computed.writingMode,
    outerHTML: cell.outerHTML.slice(0, 320), cellBox: box(rect), textBox: box(textRect) };
}

export function assertFixedUpdaterHeadingAlignment(facts) {
  assert.equal(facts.selector, '.changelog th:last-child');
  assert.equal(facts.matches, 1); assert.equal(facts.tag, 'TH');
  assert.equal(facts.text, 'Value'); assert.equal(facts.childElements, 0);
  assert.equal(facts.attribute, 'right'); assert.equal(facts.property, 'right');
  // This exact plain-text TH uses the HTML align hint; accept only these two observed serializations.
  assert.ok(['right', '-webkit-right'].includes(facts.computed), `Unexpected fixed TH text-align: ${facts.computed}`);
}
