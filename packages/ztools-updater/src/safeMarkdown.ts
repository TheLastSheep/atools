import { marked } from 'marked';
export const NOTES_MAX_BYTES = 48 * 1024;
export const SNAPSHOT_MAX_BYTES = 64 * 1024;
export const MARKDOWN_MAX_NODES = 8192;
export const MARKDOWN_MAX_DEPTH = 64;
export const MARKDOWN_MAX_OUTPUT_BYTES = 256 * 1024;
export const LINK_MAX_BYTES = 8192;
export const ORDERED_START_MIN = -2147483648;
export const ORDERED_START_MAX = 2147483647;
export const MARKDOWN_MAX_PARSE_WORK = 8192;
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const HTML = 'http://www.w3.org/1999/xhtml';
const allowed = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
    'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const blocked = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'form', 'input', 'button', 'textarea', 'select', 'img', 'source', 'video', 'audio', 'canvas']);
export function safeHref(value: string): string | null {
    if (byteLength(value) > LINK_MAX_BYTES || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
        return null;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname)
            return null;
        return byteLength(url.href) <= LINK_MAX_BYTES ? url.href : null;
    }
    catch {
        return null;
    }
}
/** Linear conservative admission, not HTML sanitization. Count even escaped/code pipes.
 * A table can pad every source row to its header width. maxColumns * ALL rows is
 * an upper bound across tables, including short rows; 3 units reserve cell/text overhead.
 */
function admittedMarkdown(source: string): boolean {
    let rows = 1, pipes = 0, maxPipes = 0, angles = 0, brackets = 0;
    let prefix = true, quotes = 0, indent = 0;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (char === '\n' || char === '\r') {
            rows++; maxPipes = Math.max(maxPipes, pipes); pipes = 0;
            prefix = true; quotes = 0; indent = 0;
            continue;
        }
        if (char === '|') pipes++;
        if (char === '<') angles++;
        if (char === '[' || char === '(') brackets++;
        else if (char === ']' || char === ')') brackets = Math.max(0, brackets - 1);
        if (brackets > MARKDOWN_MAX_DEPTH) return false;
        if (prefix) {
            if (char === ' ' || char === '\t') indent += char === '\t' ? 4 : 1;
            else if (char === '>') quotes++;
            else prefix = false;
            if (quotes + Math.floor(indent / 2) > MARKDOWN_MAX_DEPTH) return false;
        }
    }
    maxPipes = Math.max(maxPipes, pipes);
    const tableWork = maxPipes ? (maxPipes + 1) * rows * 3 : 0;
    return tableWork + angles * 3 <= MARKDOWN_MAX_PARSE_WORK;
}

/** A second linear gate before materializing parsed HTML; no original nodes are trusted. */
function admittedHtml(html: string): boolean {
    if (html.length > MARKDOWN_MAX_OUTPUT_BYTES || byteLength(html) > MARKDOWN_MAX_OUTPUT_BYTES) return false;
    let tags = 0;
    for (let i = 0; i < html.length; i++) if (html[i] === '<' && ++tags * 3 + 1 > MARKDOWN_MAX_NODES) return false;
    return true;
}
/** Parse only in an inert template, then rebuild text and safe HTML in a separate tree. */
export function renderSafeMarkdown(markdown: string, owner: Document = document): string {
    if (typeof markdown !== 'string')
        return '';
    function plainText(): string {
        let text = '', size = 0;
        for (const character of markdown) {
            const bytes = byteLength(character);
            if (size + bytes > NOTES_MAX_BYTES)
                break;
            text += character;
            size += bytes;
        }
        const pre = owner.createElement('pre');
        pre.textContent = '更新说明以安全纯文本显示（达到显示限制）。\n' + text;
        const parent = owner.createElement('div');
        parent.appendChild(pre);
        return parent.innerHTML;
    }
    if (markdown.length > NOTES_MAX_BYTES || byteLength(markdown) > NOTES_MAX_BYTES || !admittedMarkdown(markdown))
        return plainText();
    let parsed: string;
    try { parsed = marked.parse(markdown, { async: false }); } catch { return plainText(); }
    if (!admittedHtml(parsed)) return plainText();
    const inert = owner.createElement('template');
    try { inert.innerHTML = parsed; } catch { return plainText(); }
    const output = owner.createElement('div');
    let count = 0;
    function rebuild(source: Node, target: Node, depth: number): void {
        if (++count > MARKDOWN_MAX_NODES || depth > MARKDOWN_MAX_DEPTH)
            throw new Error('Markdown tree limit');
        if (source.nodeType === 3) {
            target.appendChild(owner.createTextNode(source.textContent ?? ''));
            return;
        }
        if (source.nodeType !== 1)
            return;
        const element = source as Element, tag = element.localName;
        if (element.namespaceURI !== HTML) return;
        if (tag === 'input') {
            if (element.getAttribute('type')?.toLowerCase() !== 'checkbox') return;
            const task = owner.createElement('input');
            task.setAttribute('type', 'checkbox');
            task.setAttribute('disabled', '');
            if (element.hasAttribute('checked')) task.setAttribute('checked', '');
            target.appendChild(task);
            return;
        }
        if (blocked.has(tag)) return;
        let parent = target;
        if (allowed.has(tag)) {
            const clean = owner.createElement(tag);
            if (tag === 'ol') {
                const start = element.getAttribute('start') ?? '';
                if (/^-?(?:0|[1-9]\d{0,9})$/.test(start)) {
                    const value = Number(start);
                    if (Number.isInteger(value) && value >= ORDERED_START_MIN && value <= ORDERED_START_MAX)
                        clean.setAttribute('start', String(value));
                }
            }
            if (tag === 'th' || tag === 'td') {
                const align = element.getAttribute('align')?.toLowerCase();
                if (align && ['left','center','right'].includes(align)) clean.setAttribute('align', align);
            }
            if (tag === 'a') {
                const href = safeHref(element.getAttribute('href') ?? '');
                if (href) {
                    clean.setAttribute('href', href);
                    clean.setAttribute('rel', 'noopener noreferrer');
                }
            }
            target.appendChild(clean);
            parent = clean;
        }
        for (const child of Array.from(source.childNodes))
            rebuild(child, parent, depth + 1);
    }
    try {
        for (const child of Array.from(inert.content.childNodes))
            rebuild(child, output, 0);
        const html = output.innerHTML;
        return byteLength(html) > MARKDOWN_MAX_OUTPUT_BYTES ? plainText() : html;
    }
    catch {
        return plainText();
    }
}
