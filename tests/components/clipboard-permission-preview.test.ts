import { describe, expect, it } from 'vitest';
import { isHighRiskScope, permissionRequestPreview, scopeLabel } from '../../src/lib/permissionPreview';
import { clipboardPermissionPresentation, permissionRequestContext } from '../../src/lib/permissionPresentation';
import type { PendingAgentToolRequest } from '../../src/lib/types';

const request: PendingAgentToolRequest = {
  id: 'request', run_id: 'run', client_id: 'atools-ui', tool_name: 'atools.host.clipboard.history.delete',
  arguments: { operation: 'clear' }, scopes: ['clipboard_delete'], created_at: '2026-10-22T00:00:00Z',
};

describe('clipboard permission scope labels', () => {
  it('describes history read while keeping history deletion explicit and high risk', () => {
    expect(scopeLabel('clipboard_read')).toBe('读取剪贴板内容及历史');
    expect(permissionRequestPreview(request).scopeLabels).toEqual(['删除剪贴板历史（含清空）']);
    expect(permissionRequestPreview(request).riskLevel).toBe('high');
    expect(isHighRiskScope('clipboard_delete')).toBe(true);
    expect(isHighRiskScope('clipboard_read')).toBe(false);
    expect(isHighRiskScope('clipboard_write')).toBe(true);
  });
  it('marks encrypted plugin credential storage as a separate high-risk capability', () => {
    expect(scopeLabel('secret_storage')).toBe('加密存储插件凭据');
    expect(permissionRequestPreview({ ...request, scopes: ['secret_storage'] }).riskLevel).toBe('high');
    expect(isHighRiskScope('secret_storage')).toBe(true);
  });
  it('requires the exact write plus keyboard scopes for paste and explains the foreground action', () => {
    const context = permissionRequestContext({ kind: 'host_clipboard', pluginName: 'Clipboard', clipboardAccess: 'paste' });
    const pasteRequest = { ...request, scopes: ['clipboard_write', 'input_keyboard'] };
    const presentation = clipboardPermissionPresentation(pasteRequest, context);
    expect(presentation?.title).toContain('写入并粘贴');
    expect(presentation?.riskHints[0]).toContain('前台应用');
    expect(permissionRequestPreview(pasteRequest).riskLevel).toBe('high');
    expect(clipboardPermissionPresentation({ ...pasteRequest, scopes: ['clipboard_write'] }, context)).toBeNull();
    expect(clipboardPermissionPresentation({ ...pasteRequest, scopes: ['clipboard_write', 'input_keyboard', 'file_read'] }, context)).toBeNull();
  });
  it('maps copy-only content_write to clipboard write alone', () => {
    const context = permissionRequestContext({ kind: 'host_clipboard', pluginName: 'Clipboard', clipboardAccess: 'content_write' });
    const copyRequest = { ...request, scopes: ['clipboard_write'] };
    expect(clipboardPermissionPresentation(copyRequest, context)?.title).toContain('写入');
    expect(permissionRequestContext({ kind: 'host_clipboard', clipboardAccess: 'unknown' }).clipboardAccess).toBeNull();
  });
});
