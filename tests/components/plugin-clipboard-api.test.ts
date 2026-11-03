import { describe, expect, it, vi } from 'vitest';
import { createPluginBridgeDocument } from '../../src/lib/pluginPanelBridgeCompiler';
import { createHostClipboardBridge } from '../../src/lib/hostClipboardBridge';
import { createPluginClipboardApi } from '../../src/lib/pluginUtoolsBridgeSource/clipboard-api';
import { createClipboardHistoryCodec } from '../../src/lib/pluginUtoolsBridgeSource/clipboard-history';
import originalClipboardContract from '../fixtures/clipboard-original-contract.json';

const itemId = 'clip-0123456789abcdef';

function createApi(
  nativeCall: Parameters<typeof createPluginClipboardApi>[0],
  getHost: Parameters<typeof createPluginClipboardApi>[1],
  documentNonce?: string,
) {
  return createPluginClipboardApi(nativeCall, getHost, documentNonce, createClipboardHistoryCodec);
}

function makeHost() {
  return {
    historyRead: vi.fn((payload: Record<string, unknown>): unknown => {
      if (payload.operation === 'list') return {
        items: [{ id: itemId, type: 'text', timestamp: 1700000000000, content: 'short text', preview: 'short text', appName: 'ignored' }],
        total: 8, page: payload.page, pageSize: payload.pageSize,
      };
      if (payload.operation === 'getContent') return { id: itemId, type: 'text', content: 'full text', timestamp: 1700000000000 };
      return null;
    }),
    historyDelete: vi.fn((payload: Record<string, unknown>): unknown => payload.operation === 'clear'
      ? { deletedCount: 3 } : { deleted: true }),
    writeText: vi.fn((_text: string): unknown => undefined),
    ensureAccess: vi.fn(async (_access: string) => undefined),
    writeContent: vi.fn((_payload: Record<string, unknown>) => undefined),
    paste: vi.fn((_payload: Record<string, unknown>) => undefined),
  };
}

describe('permissioned plugin clipboard API', () => {
  it('uses the host session for paginated text history, content, delete, and clear', async () => {
    const host = makeHost();
    const api = createApi(vi.fn(), () => host);
    await expect(api.getHistory(2, 20, 'needle')).resolves.toEqual({
      items: [{ id: itemId, type: 'text', timestamp: 1700000000000, content: 'short text', preview: 'short text' }],
      total: 8, page: 2, pageSize: 20,
    });
    expect(host.historyRead).toHaveBeenCalledWith({ operation: 'list', page: 2, pageSize: 20, query: 'needle' });
    await expect(api.getContent(itemId)).resolves.toEqual({
      id: itemId, type: 'text', content: 'full text', preview: 'full text', timestamp: 1700000000000,
    });
    await expect(api.delete(itemId)).resolves.toEqual({ success: true });
    await expect(api.clear()).resolves.toEqual({ success: true, count: 3 });
    expect(host.historyDelete.mock.calls).toEqual([
      [{ operation: 'delete', id: itemId }], [{ operation: 'clear' }],
    ]);
  });

  it('rejects invalid arguments, non-text rows, malformed responses, and oversized full text', async () => {
    const host = makeHost();
    const api = createApi(vi.fn(), () => host);
    await expect(api.getHistory(0, 20)).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    await expect(api.getHistory(1, 20, 'x'.repeat(257))).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    await expect(api.getContent('foreign-id')).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    host.historyRead.mockReturnValueOnce({ items: [{ id: itemId, type: 'image', timestamp: 1, preview: 'x' }], total: 1, page: 1, pageSize: 1 });
    await expect(api.getHistory(1, 1)).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_RESPONSE' });
    host.historyRead.mockReturnValueOnce({ items: [{ id: itemId, type: 'text', timestamp: 1, preview: 'only preview' }], total: 1, page: 1, pageSize: 1 });
    await expect(api.getHistory(1, 1)).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_RESPONSE' });
    host.historyRead.mockReturnValueOnce({
      items: [{ id: itemId, type: 'text', timestamp: 1, content: 'x'.repeat(256 * 1024 + 1), preview: 'x'.repeat(256) }],
      total: 1, page: 1, pageSize: 1,
    });
    await expect(api.getHistory(1, 1)).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_RESPONSE' });
    host.historyRead.mockReturnValueOnce({ id: itemId, type: 'text', content: 'x'.repeat(256 * 1024 + 1), timestamp: 1 });
    await expect(api.getContent(itemId)).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_RESPONSE' });
  });

  it('preserves full long text used by the original display, multi-select, and favorite-copy contracts', async () => {
    expect(originalClipboardContract.source.assetSha256).toBe('a4f64f03b27ba37beadf6823d1674f9321fdf6d269a44c99b2a62cb174e74316');
    expect(originalClipboardContract.textDisplayBranch).toContain('content:e.content||e.preview||""');
    expect(originalClipboardContract.multiSelectTextMerge).toContain('content:e.map(n=>String(n.content??""))');
    expect(originalClipboardContract.multiSelectTextMerge).toContain('.join(`\n`)');

    const first = '界🙂'.repeat(180);
    const second = '文本🧭'.repeat(150);
    const preview = (content: string) => Array.from(content).slice(0, 256).join('');
    const host = makeHost();
    host.historyRead.mockReturnValueOnce({
      items: [
        { id: itemId, type: 'text', timestamp: 1700000000000, content: first, preview: preview(first) },
        { id: 'clip-fedcba9876543210', type: 'text', timestamp: 1700000000001, content: second, preview: preview(second) },
      ], total: 2, page: 1, pageSize: 2,
    });
    const api = createApi(vi.fn(), () => host);
    const rows = (await api.getHistory(1, 2)).items;
    expect(rows.map((row: { content: string }) => row.content)).toEqual([first, second]);

    // This is the original Wl text branch: every selected row contributes row.content verbatim.
    const multiSelectCopy = rows.map((row: { content: string }) => String(row.content ?? '')).join('\n');
    expect(multiSelectCopy).toBe(`${first}\n${second}`);
    // The original favorite-copy path also passes the saved row content unchanged.
    const favoriteCopy = rows[1].content;
    expect(favoriteCopy).toBe(second);
    expect(favoriteCopy.length).toBeGreaterThan(256);
  });

  it('routes copy and paste through separately permissioned host operations', async () => {
    const host = makeHost();
    const api = createApi(vi.fn(), () => host);
    await expect(api.write(itemId, false)).resolves.toEqual({ success: true });
    expect(host.writeText).toHaveBeenCalledWith('full text');
    await expect(api.write(itemId, true)).resolves.toEqual({ success: true });
    expect(host.ensureAccess).toHaveBeenCalledWith('paste');
    expect(host.paste).toHaveBeenCalledWith({ kind: 'text', text: 'full text' });
    await expect(api.writeContent({ type: 'text', content: 'direct text' }, false)).resolves.toEqual({ success: true });
    expect(host.ensureAccess).toHaveBeenCalledWith('content_write');
    expect(host.writeContent).toHaveBeenCalledWith({ kind: 'text', text: 'direct text' });
    await expect(api.writeContent({ type: 'text', content: 'default paste' })).resolves.toEqual({ success: true });
    expect(host.paste).toHaveBeenLastCalledWith({ kind: 'text', text: 'default paste' });
    await expect(api.writeContent({ type: 'files', content: ['/tmp/a', '/tmp/b'] }, true)).resolves.toEqual({ success: true });
    expect(host.paste).toHaveBeenCalledWith({ kind: 'files', paths: ['/tmp/a', '/tmp/b'] });
    await expect(api.writeContent({ type: 'files', content: ['relative.txt'] }, false))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    await expect(api.writeContent({ type: 'files', content: Array.from({ length: 21 }, (_, index) => `/tmp/${index}`) }, false))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    await expect(api.writeContent({ type: 'files', content: ['/tmp/' + '界'.repeat(2730)] }, false))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    await expect(api.writeContent({ type: 'unknown', content: 'x' }, false))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_UNSUPPORTED' });
    expect(() => api.onChange(() => undefined)).toThrowError('ERR_ATOOLS_CLIPBOARD_UNAVAILABLE');
    expect(host.writeText).toHaveBeenCalledTimes(1);
  });

  it('normalizes saved image paths through the bounded Node reader and never replays after session replacement', async () => {
    const host = makeHost();
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7w8AAAAASUVORK5CYII=', 'base64'));
    const original = Object.getOwnPropertyDescriptor(window, '__atoolsNodeModuleRequire');
    Object.defineProperty(window, '__atoolsNodeModuleRequire', { configurable: true, value: { readPngPath: vi.fn(() => png) } });
    try {
      const api = createApi(vi.fn(), () => host);
      await expect(api.writeContent({ type: 'image', content: '/tmp/saved.png' }, false)).resolves.toEqual({ success: true });
      expect(host.writeContent).toHaveBeenCalledWith({ kind: 'image', image: {
        dataUrl: 'data:image/png;base64,' + Buffer.from(png).toString('base64'), width: 1, height: 1,
      } });
    } finally {
      if (original) Object.defineProperty(window, '__atoolsNodeModuleRequire', original);
      else delete (window as Window & { __atoolsNodeModuleRequire?: unknown }).__atoolsNodeModuleRequire;
    }

    let resolveAccess!: () => void;
    host.ensureAccess.mockImplementationOnce(() => new Promise<void>(resolve => { resolveAccess = resolve; }));
    let current: ReturnType<typeof makeHost> | undefined = host;
    const api = createApi(vi.fn(), () => current);
    const pending = api.writeContent({ type: 'text', content: 'private' }, true);
    await Promise.resolve();
    current = makeHost();
    resolveAccess();
    await expect(pending).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_UNAVAILABLE' });
    expect(host.paste).not.toHaveBeenCalled();
    expect(current.paste).not.toHaveBeenCalled();
  });

  it('keeps clipboard.write bound to its entry host when history content resolves after a generation swap', async () => {
    for (const paste of [false, true]) {
      let resolveHistory!: (value: unknown) => void;
      const oldHost = makeHost();
      oldHost.historyRead.mockImplementation(() => new Promise(resolve => { resolveHistory = resolve; }));
      const nextHost = makeHost();
      let current: ReturnType<typeof makeHost> | undefined = oldHost;
      const api = createApi(vi.fn(), () => current);
      const pending = api.write(itemId, paste);
      await vi.waitFor(() => expect(oldHost.historyRead).toHaveBeenCalledWith({ operation: 'getContent', id: itemId }));
      current = nextHost;
      resolveHistory({ id: itemId, type: 'text', content: 'belongs to old document', timestamp: 1700000000000 });
      await expect(pending).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_UNAVAILABLE' });
      expect(oldHost.writeText).not.toHaveBeenCalled();
      expect(oldHost.paste).not.toHaveBeenCalled();
      expect(nextHost.writeText).not.toHaveBeenCalled();
      expect(nextHost.paste).not.toHaveBeenCalled();
    }
  });

  it('subscribes through the permissioned host, reads the latest full text row, and cancels without replay', async () => {
    const instanceId = '12345678-1234-4234-8234-123456789abc';
    const readEndpoint = 'http://127.0.0.1:23456/host/' + 'a'.repeat(64);
    const transport = vi.fn((_endpoint: string, _payload: Record<string, unknown>) => ({ items: [{ id: itemId, type: 'text', timestamp: 1700000000000,
      content: 'committed text\nwith Unicode 🧭', preview: 'committed text\nwith Unicode 🧭' }], total: 1, page: 1, pageSize: 1 }));
    const bridge = createHostClipboardBridge({ instanceId, endpoints: { history_read: readEndpoint } }, vi.fn(), transport);
    const post = vi.fn((_message: Record<string, unknown>) => true);
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const original = Object.getOwnPropertyDescriptor(window, '__ATOOLS_FRAME_TRANSPORT__');
    Object.defineProperty(window, '__ATOOLS_FRAME_TRANSPORT__', { configurable: true,
      value: { post, accept: () => true } });
    try {
      const callback = vi.fn();
      const api = createApi(vi.fn(), () => bridge, 'a'.repeat(32));
      expect(addListener.mock.calls.some(([type]) => type === 'message')).toBe(false);
      const dispose = api.onChange(callback) as (() => void) & { ready: Promise<void> };
      expect(addListener.mock.calls.some(([type]) => type === 'message')).toBe(true);
      await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({
        __atools_clipboard_change__: true, operation: 'subscribe', instanceId,
      })));
      const subscribe = post.mock.calls[0][0] as Record<string, unknown>;
      window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: {
        __atools_clipboard_change_response__: true, subscriptionId: subscribe.subscriptionId,
        instanceId, documentNonce: 'a'.repeat(32), ok: true,
      } }));
      await dispose.ready;
      window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: {
        __atools_clipboard_change_event__: true, subscriptionId: subscribe.subscriptionId,
        instanceId, documentNonce: 'a'.repeat(32), sequence: 1,
      } }));
      await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        content: 'committed text\nwith Unicode 🧭', type: 'text',
      })));
      expect(transport).toHaveBeenCalledWith(readEndpoint, { operation: 'list', page: 1, pageSize: 1 });
      dispose();
      expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
        __atools_clipboard_change__: true, operation: 'unsubscribe',
      }));
      expect(removeListener.mock.calls.some(([type]) => type === 'message')).toBe(true);
    } finally {
      if (original) Object.defineProperty(window, '__ATOOLS_FRAME_TRANSPORT__', original);
      else delete (window as any).__ATOOLS_FRAME_TRANSPORT__;
      addListener.mockRestore(); removeListener.mockRestore();
    }
  });

  it('rejects a missing permission session without replaying after it later appears', async () => {
    const host = makeHost();
    let current: ReturnType<typeof makeHost> | undefined;
    const api = createApi(vi.fn(), () => current);
    await expect(api.getHistory(1, 10)).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_UNAVAILABLE' });
    current = host;
    expect(host.historyRead).not.toHaveBeenCalled();
    await expect(api.getHistory(1, 10)).resolves.toMatchObject({ total: 8 });
  });

  it('serializes the factory and installs the host session after the public bridge', () => {
    const document = createPluginBridgeDocument({
      action: { plugin_id: 'fixture', plugin_name: 'Fixture', feature_code: 'fixture', main_url: 'index.html', plugin_path: '/fixture', expand_height: 0, payload: null },
      windowType: 'main', browserWindowId: '', geometrySnapshot: null, workerScope: 'fixture', mainPushConfig: null,
      webContentsId: 1, subInputEpoch: 0, appName: 'ATools', appVersion: 'fixture',
      clipboard: { instanceId: 'fixture-instance' }, baseBridgeScript: '',
    });
    expect(document).toContain('getHistory: function(page, pageSize, query)');
    expect(document).toContain('return window.__atoolsHostClipboard;');
    expect(document.indexOf('window.utools =')).toBeLessThan(document.indexOf('data-atools-host-clipboard'));
    expect(document).not.toContain('__ATOOLS_CLIPBOARD_FACTORY__');
    expect(document).not.toContain('__ATOOLS_CLIPBOARD_HISTORY_CODEC_FACTORY__');
  });
});

describe('clipboard original history query contract', () => {
  it('uses the permissioned history session and rejects search results beyond its cap', async () => {
    const host = makeHost();
    const nativeCall = vi.fn();
    const api = createApi(nativeCall, () => host);
    await expect(api.search('needle')).resolves.toEqual([
      { id: itemId, type: 'text', timestamp: 1700000000000, content: 'short text', preview: 'short text' },
    ]);
    expect(host.historyRead).toHaveBeenCalledWith({ operation: 'list', page: 1, pageSize: 1000, query: 'needle' });
    expect(nativeCall).not.toHaveBeenCalled();
    host.historyRead.mockReturnValueOnce({ items: [], total: 1001, page: 1, pageSize: 1000 });
    await expect(api.search('needle')).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_LIMIT' });
  });

  it('allows all four history clear types and rejects unsupported types before host IPC', async () => {
    const host = makeHost();
    const api = createApi(vi.fn(), () => host);
    await expect(api.clear('text')).resolves.toEqual({ success: true, count: 3 });
    await expect(api.clear('image')).resolves.toEqual({ success: true, count: 3 });
    await expect(api.clear('file')).resolves.toEqual({ success: true, count: 3 });
    await expect(api.clear('all')).resolves.toEqual({ success: true, count: 3 });
    await expect(api.clear('unknown')).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    await expect(api.clear(3)).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    expect(host.historyDelete.mock.calls).toEqual([
      [{ operation: 'clear', type: 'text' }], [{ operation: 'clear', type: 'image' }],
      [{ operation: 'clear', type: 'file' }], [{ operation: 'clear', type: 'all' }],
    ]);
  });
});

describe('plugin clipboard factory through host history validation', () => {
  it('routes 1000-row reads, search, and supported clear types to the exact permissioned session', async () => {
    const readEndpoint = 'http://127.0.0.1:23456/host/' + 'a'.repeat(64);
    const deleteEndpoint = 'http://127.0.0.1:23457/host/' + 'b'.repeat(64);
    const transport = vi.fn((endpoint: string, payload: Record<string, unknown>): unknown => {
      if (endpoint === readEndpoint && payload.operation === 'list') return {
        items: [{ id: itemId, type: 'text', timestamp: 1700000000000, content: 'needle', preview: 'needle' }],
        total: 1, page: payload.page, pageSize: payload.pageSize,
      };
      if (endpoint === deleteEndpoint && payload.operation === 'clear') return { deletedCount: 3 };
      return { deleted: true };
    });
    const bridge = createHostClipboardBridge({
      instanceId: 'history-integration',
      endpoints: { history_read: readEndpoint, history_delete: deleteEndpoint },
    }, vi.fn(), transport);
    const api = createApi(vi.fn(), () => bridge);

    await expect(api.getHistory(1, 1000)).resolves.toMatchObject({ total: 1, pageSize: 1000 });
    await expect(api.search('needle')).resolves.toHaveLength(1);
    await expect(api.clear('text')).resolves.toEqual({ success: true, count: 3 });
    await expect(api.clear('all')).resolves.toEqual({ success: true, count: 3 });
    await expect(api.clear('image')).resolves.toEqual({ success: true, count: 3 });
    expect(transport.mock.calls).toEqual([
      [readEndpoint, { operation: 'list', page: 1, pageSize: 1000 }],
      [readEndpoint, { operation: 'list', page: 1, pageSize: 1000, query: 'needle' }],
      [deleteEndpoint, { operation: 'clear', type: 'text' }],
      [deleteEndpoint, { operation: 'clear', type: 'all' }],
      [deleteEndpoint, { operation: 'clear', type: 'image' }],
    ]);
    expect(() => bridge.historyRead({ operation: 'list', page: 1, pageSize: 1001 }))
      .toThrow('ERR_ATOOLS_HOST_CLIPBOARD_ARGUMENT');
    expect(transport).toHaveBeenCalledTimes(5);
  });
});

describe('clipboard Promise history authorization', () => {
  const readEndpoint = 'http://127.0.0.1:23456/host/' + 'c'.repeat(64);
  const deleteEndpoint = 'http://127.0.0.1:23457/host/' + 'd'.repeat(64);

  it('waits for one shared read grant, then performs each requested read exactly once', async () => {
    const requestPermission = vi.fn();
    const transport = vi.fn((_endpoint: string, payload: Record<string, unknown>): unknown => {
      if (payload.operation === 'getContent') return { id: itemId, type: 'text', content: 'full text', timestamp: 1700000000000 };
      return { items: [{ id: itemId, type: 'text', timestamp: 1700000000000, content: 'short text', preview: 'short text' }],
        total: 1, page: payload.page, pageSize: payload.pageSize };
    });
    const bridge = createHostClipboardBridge({ instanceId: 'pending-read' }, requestPermission, transport);
    const api = createApi(vi.fn(), () => bridge);
    const page = api.getHistory(1, 1);
    const content = api.getContent(itemId);

    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    expect(requestPermission).toHaveBeenCalledWith('history_read');
    expect(transport).not.toHaveBeenCalled();
    bridge.install('history_read', readEndpoint);

    await expect(page).resolves.toMatchObject({ total: 1, items: [{ content: 'short text' }] });
    await expect(content).resolves.toMatchObject({ content: 'full text' });
    expect(transport.mock.calls).toEqual([
      [readEndpoint, { operation: 'list', page: 1, pageSize: 1 }],
      [readEndpoint, { operation: 'getContent', id: itemId }],
    ]);
  });

  it('authorizes delete and clear before mutation and never replays a granted operation', async () => {
    const requestPermission = vi.fn();
    const transport = vi.fn((_endpoint: string, payload: Record<string, unknown>): unknown =>
      payload.operation === 'clear' ? { deletedCount: 2 } : { deleted: true });
    const bridge = createHostClipboardBridge({ instanceId: 'pending-delete' }, requestPermission, transport);
    const api = createApi(vi.fn(), () => bridge);
    const deleted = api.delete(itemId);
    const cleared = api.clear('text');

    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    expect(requestPermission).toHaveBeenCalledWith('history_delete');
    expect(transport).not.toHaveBeenCalled();
    bridge.install('history_delete', deleteEndpoint);
    bridge.install('history_delete', deleteEndpoint);

    await expect(deleted).resolves.toEqual({ success: true });
    await expect(cleared).resolves.toEqual({ success: true, count: 2 });
    expect(transport.mock.calls).toEqual([
      [deleteEndpoint, { operation: 'delete', id: itemId }],
      [deleteEndpoint, { operation: 'clear', type: 'text' }],
    ]);
  });

  it('rejects invalid input before prompting and cancels a pending read when its host closes', async () => {
    const requestPermission = vi.fn();
    const transport = vi.fn();
    const bridge = createHostClipboardBridge({ instanceId: 'closed-pending-read' }, requestPermission, transport);
    const api = createApi(vi.fn(), () => bridge);

    await expect(api.getHistory(0, 1)).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    await expect(api.getContent('bad-id')).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    await expect(api.delete('bad-id')).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    await expect(api.clear('html')).rejects.toMatchObject({ code: 'ERR_ATOOLS_CLIPBOARD_ARGUMENT' });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();

    const deniedRequest = vi.fn();
    const deniedTransport = vi.fn();
    const deniedBridge = createHostClipboardBridge({ instanceId: 'denied-history-read' }, deniedRequest, deniedTransport);
    const deniedApi = createApi(vi.fn(), () => deniedBridge);
    const denied = deniedApi.getContent(itemId);
    await vi.waitFor(() => expect(deniedRequest).toHaveBeenCalledTimes(1));
    deniedBridge.install('history_read');
    await expect(denied).rejects.toMatchObject({ code: 'ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED' });
    expect(deniedTransport).not.toHaveBeenCalled();

    const pending = api.getHistory(1, 1);
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    bridge.close();
    await expect(pending).rejects.toMatchObject({ code: 'ERR_ATOOLS_HOST_CLIPBOARD_CLOSED' });
    expect(transport).not.toHaveBeenCalled();
  });
});
