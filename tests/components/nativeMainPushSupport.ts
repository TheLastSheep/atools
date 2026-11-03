import { invoke as nativeInvoke } from "@tauri-apps/api/core";
export type Fixture = { token: string; privateQuery: string; capabilities: Array<{
  id: string; title: string; mainPush: string; node: string; data: string; paths: string;
}> };
export type Observation = { documentId: string; promotions: number; visibility: string; hasFocus: boolean;
  textareaValues: string[]; fixture: null | { ready: string; query: string; select: string; enter: string;
    selectionVerified: string | null; enterOptionVerified: string | null; text: string } };
type Pending = { id: string; tool_name: string; client_id: string; scopes: string[]; arguments: Record<string, unknown> };
const nodeScopes = ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write",
  "screenshot", "browser_context", "plugin_data", "system_settings"];
export const pause = (ms = 50) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`Fixture operation timed out: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
export const invoke = <T>(command: string, args?: Record<string, unknown>) =>
  bounded(nativeInvoke<T>(command, args), 5000, command);
export const phaseErrors: string[] = [];
export async function phase(label: string) {
  try { await bounded(nativeInvoke<void>("native_main_push_phase", { phase: label }), 1500, "phase"); }
  catch { if (phaseErrors.length < 32) phaseErrors.push(label); }
}
export function assert(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }

export function createNativeMainPushSupport(fixture: Fixture) {
  const approvals: Array<{ tool: string; scopes: string[]; runnerId: string | null; delayMs: number }> = [];
  const approvedMainPush = new Set<string>();
  let delayedNode = false;
  async function permissions() {
    const dialog = document.querySelector<HTMLElement>("[data-permission-dialog]");
    if (!dialog || dialog.getAttribute("aria-busy") === "true") return;
    const metadata = dialog.querySelector(".technical-details pre");
    if (!metadata) return; // Exact native owner context can arrive after the dialog shell.
    const identity = JSON.parse(metadata.textContent ?? "null");
    assert(identity && typeof identity.tool === "string" && identity.client === "atools-ui", "Fixture permission identity must be explicit");
    const pending = await invoke<Pending[]>("list_pending_agent_requests");
    const request = pending.find(value => value.tool_name === identity.tool && value.client_id === identity.client);
    if (!request) return;
    const owner = fixture.capabilities.find(value => [value.mainPush, value.node, value.data, value.paths].includes(request.tool_name));
    assert(owner, "Unexpected permission must never be approved by the fixture");
    const expected = request.tool_name === owner.mainPush ? [] : request.tool_name === owner.node ? nodeScopes
      : request.tool_name === owner.data ? ["plugin_data"] : ["file_read"];
    assert([...request.scopes].sort().join("|") === [...expected].sort().join("|"), "Reviewed resource scopes must match exactly");
    const runnerId = request.tool_name === owner.mainPush ? String(request.arguments.runnerId ?? "") : null;
    if (runnerId !== null) {
      assert(request.arguments.operation === "prepare" && request.arguments.inputBytes === 0,
        "Only query-free runner preparation may request MainPush approval");
      assert(runnerId.length > 0, "MainPush approval must identify an actual runner");
      const key = `${request.tool_name}/${runnerId}`;
      assert(!approvedMainPush.has(key), "A prepared runner must not ask again for each query or selection");
      approvedMainPush.add(key);
    }
    let delayMs = 0;
    if (request.tool_name === owner.node && !delayedNode) {
      delayedNode = true; delayMs = 6500;
      // A visible, real resource permission wait must pause the five-second startup clock.
      await pause(delayMs);
    }
    const current = document.querySelector<HTMLElement>("[data-permission-dialog]");
    assert(current === dialog, "Permission dialog changed during fixed approval delay");
    const once = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "允许一次");
    assert(once && !once.disabled, "Reviewed permission must expose one-time approval");
    approvals.push({ tool: request.tool_name, scopes: request.scopes, runnerId, delayMs });
    once.click();
    await pause(80);
  }
  async function until<T>(read: () => T | Promise<T>, message: string, timeout = 45000): Promise<NonNullable<T>> {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      await permissions();
      const value = await read();
      if (value) return value as NonNullable<T>;
      await pause();
    }
    throw Error(message);
  }
  function input() {
    const node = document.querySelector<HTMLInputElement>("[data-atools-search-input]");
    assert(node, "Actual production launcher input is mounted"); return node;
  }
  function search(query: string) {
    const node = input(); node.focus(); node.value = query; node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function rows(plugin: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('[role="option"][data-result-code^="main-push:"]')]
      .filter(row => row.dataset.pluginId === plugin);
  }
  function frame(row: HTMLElement) {
    const id = row.dataset.resultCode?.split(":")[1]; assert(id, "Dynamic row must identify its runner");
    const wrapper = [...document.querySelectorAll<HTMLElement>("[data-main-push-runner]")].find(node => node.dataset.mainPushRunner === id);
    const frame = wrapper?.querySelector<HTMLIFrameElement>(".plugin-panel iframe");
    assert(frame?.contentWindow && wrapper, "Dynamic row must belong to one actual persistent frame");
    return { id, wrapper, frame, window: frame.contentWindow };
  }
  async function observe(frame: HTMLIFrameElement): Promise<Observation> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(Error("Owned read-only frame observation timed out")); }, 2000);
      function receive(event: MessageEvent) {
        const data = event.data;
        if (event.source !== frame.contentWindow || event.origin !== "null" || data?.__nativeMainPushObservation !== true
          || data.token !== fixture.token || data.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener("message", receive); resolve(data.observation);
      }
      window.addEventListener("message", receive);
      frame.contentWindow!.postMessage({ __nativeMainPushObserve: true, token: fixture.token, requestId }, "*");
    });
  }
  return { approvals, until, input, search, rows, frame, observe, permissions,
    delayedNode: () => delayedNode, invoke };
}
