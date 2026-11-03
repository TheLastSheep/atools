import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFixedUpdaterHeadingAlignment } from './ztools-updater-browser-alignment.mjs';

const fixed = { selector: '.changelog th:last-child', matches: 1, tag: 'TH', text: 'Value',
  childElements: 0, attribute: 'right', property: 'right', computed: '-webkit-right' };
test('the exact plain-text Value TH requires HTML and DOM right alignment with a bounded computed spelling', () => {
  assert.doesNotThrow(() => assertFixedUpdaterHeadingAlignment(fixed));
  assert.doesNotThrow(() => assertFixedUpdaterHeadingAlignment({ ...fixed, computed: 'right' }));
});
test('wrong attributes, DOM property, target/content and other computed values remain failures', () => {
  for (const patch of [{ attribute: null }, { property: 'left' }, { attribute: 'left' },
    { computed: 'left' }, { computed: 'end' }, { computed: '-webkit-center' },
    { selector: '.anything' }, { matches: 2 }, { tag: 'TD' }, { text: 'Other' }, { childElements: 1 }]) {
    assert.throws(() => assertFixedUpdaterHeadingAlignment({ ...fixed, ...patch }));
  }
});
