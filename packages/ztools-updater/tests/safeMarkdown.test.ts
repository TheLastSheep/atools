import { expect, it, vi } from 'vitest';
import { renderSafeMarkdown } from '../src/safeMarkdown';
it('keeps original Markdown formatting while removing raw execution, foreign namespaces and resource loads', () => {
    const html = renderSafeMarkdown('# Release\n\n**Fix** [safe](https://example.com/release)\n\n' +
        '<script>alert(1)</script><img src="https://attacker.invalid/pixel" onerror="alert(1)">' +
        '<svg><a href="javascript:alert(1)">svg</a></svg><iframe src="https://attacker.invalid"></iframe>' +
        '<style>@import "https://attacker.invalid/style"</style><a href="javascript:alert(1)" onclick="alert(1)">bad</a>');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('h1')?.textContent).toBe('Release');
    expect(host.querySelector('strong')?.textContent).toBe('Fix');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/release');
    expect(host.querySelector('script,img,svg,iframe,style,[onclick],[onerror]')).toBeNull();
    expect(html).not.toContain('javascript:');
});
it('accepts normalized http(s) links only and never retains any remote resource attribute', () => {
    const html = renderSafeMarkdown('<a href="HTTPS://Example.COM/a?x=1&amp;y=2">safe</a>' +
        '<a href="java&#x73;cript:alert(1)">bad</a><a href="https://user:pass@example.com/">bad</a>' +
        '<a href="//example.com">relative</a><a href="https://example.com/&#10;x">control</a>' +
        '<p style="background:url(https://attacker.invalid)"><img srcset="https://attacker.invalid 1x">text</p>');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect([...host.querySelectorAll('a[href]')].map(e => e.getAttribute('href'))).toEqual(['https://example.com/a?x=1&y=2']);
    expect(host.querySelector('[style],[src],[srcset]')).toBeNull();
});
it('drops comments, nested foreign content and oversized/deep trees without executing getters', () => {
    const html = renderSafeMarkdown('<!--x--><math><mtext><img src=x onerror=alert(1)></mtext></math><pre><code>&lt;script&gt;</code></pre>');
    expect(html).not.toContain('<math');
    expect(html).not.toContain('<!--');
    expect(html).toContain('&lt;script&gt;');
    expect(renderSafeMarkdown('x'.repeat(49153))).toContain('安全纯文本');
    expect(renderSafeMarkdown('<div>'.repeat(70) + 'deep' + '</div>'.repeat(70))).toContain('安全纯文本');
});
it('enforces byte/node/depth/output limits with explicit escaped-text fallback', async () => {
    const { NOTES_MAX_BYTES, SNAPSHOT_MAX_BYTES, MARKDOWN_MAX_OUTPUT_BYTES } = await import('../src/safeMarkdown');
    expect(NOTES_MAX_BYTES).toBe(49152);
    expect(SNAPSHOT_MAX_BYTES).toBe(65536);
    const overBytes = renderSafeMarkdown('中'.repeat(17000) + '<script>unsafe()</script>');
    expect(overBytes).toContain('安全纯文本');
    expect(new TextEncoder().encode(overBytes).length).toBeLessThanOrEqual(MARKDOWN_MAX_OUTPUT_BYTES);
    const many = renderSafeMarkdown('<br>'.repeat(8193));
    expect(many).toContain('安全纯文本');
    expect(many).not.toContain('<script>');
    const escaped = renderSafeMarkdown('&'.repeat(49152));
    expect(new TextEncoder().encode(escaped).length).toBeLessThanOrEqual(MARKDOWN_MAX_OUTPUT_BYTES);
});
it('uses an active DOM resource-loader oracle: inert parsing and fresh reconstruction issue zero requests', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire('/Users/harris/Desktop/atools/node_modules/.pnpm/package.json');
    const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');
    const requests: string[] = [];
    class CountingLoader extends ResourceLoader {
        fetch(url: string): null { requests.push(url); return null; }
    }
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://owned.invalid/', resources: new CountingLoader(), runScripts: 'dangerously', virtualConsole: new VirtualConsole() });
    try {
        const probe = dom.window.document.createElement('iframe');
        probe.src = 'https://oracle.invalid/active';
        dom.window.document.body.appendChild(probe);
        expect(requests).toEqual(['https://oracle.invalid/active']);
        probe.remove();
        requests.length = 0;
        const safe = renderSafeMarkdown('<iframe src="https://evil.invalid/frame"></iframe><link rel=stylesheet href="https://evil.invalid/style">' +
            '<style>@import "https://evil.invalid/css";</style><img src="https://evil.invalid/image" onerror="window.pwned=true">' +
            '<svg><image href="https://evil.invalid/svg"/></svg><script>window.pwned=true</script><b>safe</b>', dom.window.document);
        const host = dom.window.document.createElement('div');
        host.innerHTML = safe;
        dom.window.document.body.appendChild(host);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(requests).toEqual([]);
        expect(dom.window.pwned).toBeUndefined();
        expect(host.querySelector('iframe,link,style,img,svg,script,[src],[srcset]')).toBeNull();
    }
    finally {
        dom.window.close();
    }
});

import { marked } from 'marked';
import { safeHref } from '../src/safeMarkdown';
it('rejects padded-table work before marked or any inert DOM exists, while normal tables keep formatting', () => {
  const table = '|' + 'a|'.repeat(200) + '\n|' + '--|'.repeat(200) + '\n' + 'x|\n'.repeat(200);
  expect(new TextEncoder().encode(table).length).toBe(1604);
  const parse = vi.spyOn(marked, 'parse'), create = vi.spyOn(document, 'createElement');
  const result = renderSafeMarkdown(table);
  expect(result).toContain('安全纯文本');
  expect(result).toContain(table);
  expect(parse).not.toHaveBeenCalled();
  expect(create.mock.calls.map(c => c[0])).not.toContain('template');
  parse.mockRestore(); create.mockRestore();
  const normal = renderSafeMarkdown('| Name | Value |\n| --- | --- |\n| A | **B** |');
  const host = document.createElement('div'); host.innerHTML = normal;
  expect(host.querySelectorAll('th')).toHaveLength(2); expect(host.querySelectorAll('td')).toHaveLength(2);
  expect(host.querySelector('td strong')?.textContent).toBe('B');
});
it('bounds canonical href bytes after Unicode expansion and accepts exact normalized limits', () => {
  const prefix = 'https://example.com/';
  expect(safeHref(prefix + '中'.repeat(2700))).toBeNull();
  expect(safeHref(prefix + 'a'.repeat(8192 - prefix.length))).toHaveLength(8192);
  expect(safeHref(prefix + 'a'.repeat(8193 - prefix.length))).toBeNull();
  expect(safeHref('HTTPS://Example.COM/a b?x=1&y=2')).toBe('https://example.com/a%20b?x=1&y=2');
});
it('checks linear parsed HTML node potential before innerHTML, with bounded list compatibility', () => {
  const parse = vi.spyOn(marked, 'parse'), create = vi.spyOn(document, 'createElement');
  const result = renderSafeMarkdown('- item\n'.repeat(3000));
  expect(parse).toHaveBeenCalledTimes(1); expect(result).toContain('安全纯文本');
  expect(create.mock.calls.map(c => c[0])).not.toContain('template');
  parse.mockRestore(); create.mockRestore();
  const host = document.createElement('div'); host.innerHTML = renderSafeMarkdown('- first\n- **second**');
  expect(host.querySelectorAll('li')).toHaveLength(2); expect(host.querySelector('li strong')?.textContent).toBe('second');
});
it('checks actual parsed HTML bytes before innerHTML even when potential-node count is small', () => {
  const parse = vi.spyOn(marked, 'parse'), create = vi.spyOn(document, 'createElement');
  const result = renderSafeMarkdown('<https://example.com/?' + '&'.repeat(47000) + '>');
  expect(parse).toHaveBeenCalledTimes(1);
  expect(new TextEncoder().encode(parse.mock.results[0].value as string).length).toBeGreaterThan(256 * 1024);
  expect(result).toContain('安全纯文本'); expect(create.mock.calls.map(c => c[0])).not.toContain('template');
});

it('retains normal marked ordered starts, table alignment and disabled task state through fresh reconstruction',()=>{
  const notes='3. third\n4. fourth\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| A | B | C |\n\n- [x] done\n- [ ] pending';
  const ordinary=document.createElement('template');ordinary.innerHTML=marked.parse(notes,{async:false});
  const clean=document.createElement('div');clean.innerHTML=renderSafeMarkdown(notes);
  expect(ordinary.content.querySelector('ol')?.getAttribute('start')).toBe('3');expect(clean.querySelector('ol')?.getAttribute('start')).toBe('3');
  for(const tag of ['th','td']) expect([...clean.querySelectorAll(tag)].map(cell=>cell.getAttribute('align'))).toEqual([...ordinary.content.querySelectorAll(tag)].map(cell=>cell.getAttribute('align')));
  const tasks=[...clean.querySelectorAll<HTMLInputElement>('input')];expect(tasks).toHaveLength(2);expect(tasks.map(input=>input.checked)).toEqual([true,false]);expect(tasks.every(input=>input.disabled&&input.type==='checkbox')).toBe(true);
});

it('rebuilds only finite per-tag semantic attributes; dangerous controls/styles/events stay absent',()=>{
  const clean=document.createElement('div');clean.innerHTML=renderSafeMarkdown('<ol start="2147483647" onclick="evil()"><li>x</li></ol><ol start="2147483648"><li>x</li></ol><ol start="2.5"><li>x</li></ol>'+
    '<table><tr><th align="RIGHT" style="background:url(https://evil.invalid)">x</th><td align="evil" onclick="evil()">y</td></tr></table>'+
    '<input type="checkbox" checked onclick="evil()" autofocus name="secret" src="https://evil.invalid"><input type="image" src="https://evil.invalid"><input type="text" value="secret">');
  expect([...clean.querySelectorAll('ol')].map(list=>list.getAttribute('start'))).toEqual(['2147483647',null,null]);
  expect(clean.querySelector('th')?.getAttribute('align')).toBe('right');expect(clean.querySelector('td')?.hasAttribute('align')).toBe(false);
  const inputs=clean.querySelectorAll<HTMLInputElement>('input');expect(inputs).toHaveLength(1);expect(inputs[0].disabled&&inputs[0].checked).toBe(true);
  expect([...inputs[0].attributes].map(attr=>attr.name).sort()).toEqual(['checked','disabled','type']);
  expect(clean.querySelector('[style],[onclick],[src],[autofocus],[name]')).toBeNull();
});
