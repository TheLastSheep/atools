import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPluginBridgeDocument } from '../../src/lib/pluginPanelBridgeCompiler';
import utoolsApiAndDynamicFeatures from '../../src/lib/pluginUtoolsBridgeSource/utools-api-and-dynamic-features';
import { createPluginPanelDocumentSourceHost } from '../../src/lib/pluginPanelDocumentSourceHost';
import { createPluginWorkerDocumentLifecycle } from '../../src/lib/pluginWorkerDocumentLifecycle';
import { createPluginHostedIpcRouter } from '../../src/lib/pluginHostedIpcRouter';
import { PluginFrameSourceRegistry } from '../../src/lib/pluginFrameDocumentIdentity';
import { emptyPluginSubInput } from '../../src/lib/pluginSubInputState';
describe('production exports entry wiring', () => {
  it('injects the compiled bridge through the real document-source host wrapper', () => {
    const sources = new PluginFrameSourceRegistry();
    const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
    const workerDocument = createPluginWorkerDocumentLifecycle({
      getSource: () => null,
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
    });
    const subInput = emptyPluginSubInput();
    const documentHost = createPluginPanelDocumentSourceHost({
      action: () => ({ plugin_id: 'fixture', plugin_name: 'Fixture', feature_code: 'fixture', main_url: 'index.html',
        plugin_path: '/fixture', expand_height: 0, payload: null }),
      workerDocument, hostedIpc, mainPushHost: undefined, generation: () => 0, pluginPathForPreview: '/fixture',
      productName: 'ATools', productVersion: 'fixture', clipboard: () => undefined, data: () => undefined,
      paths: () => undefined, dialogs: () => undefined, display: () => undefined, bridgeScript: () => undefined,
      smokeEnabled: () => false, smokeSampleIndex: () => 0, subInputState: () => subInput, setSubInputState: () => {},
      iframeSrc: () => {}, iframeSrcDoc: () => {}, setPluginItems: () => {}, setSelectedIndex: () => {}, setLoadError: () => {},
    });
    const source = '<!doctype html><html><head></head><body><main id="plugin-content">fixture</main></body></html>';
    const injected = documentHost.injectBridge(source);
    expect(hostedIpc.hasReservation({ kind: 'main' })).toBe(true);
    expect(injected).toContain('<main id="plugin-content">fixture</main>');
    expect(injected.indexOf('window.__ATOOLS_FRAME_TRANSPORT__')).toBeLessThan(injected.indexOf('</head>'));
    expect(injected).toContain('getCopiedFiles: function()');
    expect(injected).not.toContain('__ATOOLS_FEATURE_EXPORTS_FACTORY__');
  });
  it('routes list/none through the lazy panel, preserves entry type, and keeps original frame mounted', () => {
    const panel = readFileSync('src/components/PluginPanel.svelte', 'utf8');
    const body = readFileSync('src/components/PluginPanelBody.svelte', 'utf8');
    const messageHost = readFileSync('src/lib/pluginPanelMessageHost.ts', 'utf8');
    const document = createPluginBridgeDocument({
      action: { plugin_id: 'fixture', plugin_name: 'Fixture', feature_code: 'fixture', main_url: 'index.html', plugin_path: '/fixture',
        expand_height: 0, payload: null, entry_type: 'regex' },
      windowType: 'main', browserWindowId: '', geometrySnapshot: null, workerScope: 'fixture-scope', mainPushConfig: null,
      webContentsId: 1, subInputEpoch: 0, appName: 'ATools', appVersion: 'fixture', baseBridgeScript: '',
    });
    const entryTypeTemplate = utoolsApiAndDynamicFeatures;
    expect(entryTypeTemplate).toContain('type: detail.type || __ACTION_ENTRY_TYPE__');
    expect(document).toContain('type: detail.type || "regex"');
    expect(document).not.toContain('__ACTION_ENTRY_TYPE__');
    expect(panel).toContain('onmessage={pluginPanelMessageHost.handleMessage}');
    expect(panel).toContain('iframeAction={pluginMainFrame}');
    expect(panel).toContain('<PluginPanelBody');
    expect(body).toContain('<PluginFeatureList');
    expect(messageHost).toContain('featureListMessage');
    expect(messageHost).toContain('handleNativeCall: nativeBridge.handleNativeBridgeCall');
    expect(panel).not.toContain("window.dispatchEvent(new Event('atools-plugin-enter'));");
  });
});
