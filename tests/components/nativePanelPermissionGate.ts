type Request = { tool_name: string; client_id: string; scopes: string[] };
type Options = { title: string; tool: string; scopes: string[]; label: string;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  until: <T>(read: () => T | Promise<T>, message: string) => Promise<NonNullable<T>>;
  check: (ok: unknown, label: string) => void };

/** A new prompt is never approved merely because it belongs to the same plugin. */
export async function approveNativePanelPermission(options: Options) {
  const dialog = () => document.querySelector<HTMLElement>("[data-permission-dialog]");
  await options.until(() => dialog()?.querySelector("h2")?.textContent?.trim() === options.title,
    "Exact reviewed permission title did not appear: " + options.label);
  const pending = await options.invoke<Request[]>("list_pending_agent_requests");
  const scopes = (values: string[]) => [...values].sort().join("|");
  options.check(pending.length === 1 && pending[0].tool_name === options.tool && pending[0].client_id === "atools-ui"
    && scopes(pending[0].scopes) === scopes(options.scopes), "Pending permission matches the exact reviewed capability and scopes: " + options.label);
  const once = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "允许一次");
  options.check(once, "Exact reviewed permission offers actual one-time authorization: " + options.label);
  once!.click();
  await options.until(async () => !(await options.invoke<Request[]>("list_pending_agent_requests")).some(request => request.tool_name === options.tool),
    "Reviewed permission did not finish: " + options.label);
}
