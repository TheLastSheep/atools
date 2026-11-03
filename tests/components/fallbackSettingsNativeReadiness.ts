export type LaunchControlReadiness = {
  ready: boolean | null;
  controlUnique: boolean | null;
  enabled: boolean | null;
  disabled: boolean | null;
  indeterminate: boolean | null;
};
export type NativeInputDispatch = { dispatched: boolean | null; valueObserved: boolean | null };

const READINESS_POLL_MS = 25;

export function isLaunchControlReady(value: LaunchControlReadiness): boolean {
  return value.ready === true
    && value.controlUnique === true
    && value.enabled !== null
    && value.disabled === false
    && value.indeterminate === false;
}

export function sampleLaunchControl(document: Document): LaunchControlReadiness {
  const panels = document.querySelectorAll<HTMLElement>("section.settings-panel");
  if (panels.length !== 1) {
    return { ready: false, controlUnique: null, enabled: null, disabled: null, indeterminate: null };
  }
  const controls = panels[0].querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"][aria-label="开机自动启动"]',
  );
  if (controls.length !== 1) {
    return { ready: true, controlUnique: false, enabled: null, disabled: null, indeterminate: null };
  }
  const control = controls[0];
  const ariaChecked = control.getAttribute("aria-checked");
  const indeterminate = control.indeterminate || ariaChecked === "mixed";
  const enabled = indeterminate ? null
    : ariaChecked === "true" ? true
      : ariaChecked === "false" ? false
        : control.checked;
  return {
    ready: true,
    controlUnique: true,
    enabled,
    disabled: control.disabled,
    indeterminate,
  };
}

export function dispatchDomClick(element: HTMLElement | null): boolean | null {
  if (!element || !element.isConnected) return false;
  let observed = false;
  const onClick = () => { observed = true; };
  element.addEventListener("click", onClick, { once: true });
  try {
    element.click();
    return observed ? true : null;
  } catch {
    return null;
  } finally {
    element.removeEventListener("click", onClick);
  }
}

export function dispatchNativeInput(input: HTMLInputElement | null, value: string): NativeInputDispatch {
  if (!input || !input.isConnected || input.disabled) return { dispatched: false, valueObserved: null };
  const view = input.ownerDocument.defaultView;
  if (!view) return { dispatched: false, valueObserved: null };
  const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set;
  if (!setter) return { dispatched: false, valueObserved: null };
  let inputEvent: InputEvent;
  let changeEvent: Event;
  try {
    inputEvent = new view.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    });
    changeEvent = new view.Event("change", { bubbles: true });
    setter.call(input, value);
  } catch {
    return { dispatched: false, valueObserved: safelyReadValue(input, value) };
  }
  try {
    input.dispatchEvent(inputEvent);
    input.dispatchEvent(changeEvent);
    return { dispatched: true, valueObserved: safelyReadValue(input, value) };
  } catch {
    return { dispatched: null, valueObserved: safelyReadValue(input, value) };
  }
}

function safelyReadValue(input: HTMLInputElement, expected: string): boolean | null {
  try { return input.value === expected; } catch { return null; }
}

export async function waitForKnownLaunchState<T extends LaunchControlReadiness>(
  read: () => T,
  deadline: number,
): Promise<T> {
  let observed = read();
  while (!isLaunchControlReady(observed)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(READINESS_POLL_MS, remaining)));
    if (performance.now() >= deadline) break;
    observed = read();
  }
  return observed;
}
