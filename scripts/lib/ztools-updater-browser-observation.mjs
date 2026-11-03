/** Observes only the owned updater document. Never focuses nodes, synthesizes keys or changes product handlers. */
export function installUpdaterKeyObserver(owner = window) {
  const previous = owner.__UPDATER_BROWSER_KEY_OBSERVER__;
  if (previous?.active) throw Error('Updater key observer already active');
  const document = owner.document, records = [];
  const describe = node => ({ tag: node?.tagName ?? null,
    className: String(node?.getAttribute?.('class') ?? '').slice(0, 160),
    root: node === document.querySelector('.update-window'),
    interactive: node?.closest?.('button,a,input,textarea,select,[contenteditable],[role="button"]')?.tagName ?? null });
  let active = true;
  const callback = event => {
    if (records.length >= 8) return;
    const record = { target: describe(event.target), focus: describe(document.activeElement),
      key: String(event.key).slice(0, 32), code: String(event.code).slice(0, 32), isTrusted: event.isTrusted,
      repeat: event.repeat, composing: event.isComposing, keyCode: event.keyCode,
      modifiers: { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
        altGraph: !!event.getModifierState?.('AltGraph') } };
    records.push(record);
    // This is the value seen by the capture-scheduled microtask, not a final default-action guarantee.
    queueMicrotask(() => {
      record.defaultPreventedObserved = event.defaultPrevented;
      record.samplingStage = 'capture-microtask';
    });
  };
  document.addEventListener('keydown', callback, true);
  const observer = { get active() { return active; },
    snapshot() { return { active, records: JSON.parse(JSON.stringify(records)) }; },
    stop() { if (active) { active = false; document.removeEventListener('keydown', callback, true); } return this.snapshot(); } };
  Object.defineProperty(owner, '__UPDATER_BROWSER_KEY_OBSERVER__', { value: observer, configurable: true });
  return observer.snapshot();
}

export function readUpdaterBrowserFacts(owner = window, stopObserver = false) {
  const document = owner.document, fixture = owner.__UPDATER_BROWSER_FIXTURE__?.snapshot();
  const describe = node => ({ tag: node?.tagName ?? null,
    className: String(node?.getAttribute?.('class') ?? '').slice(0, 160),
    root: node === document.querySelector('.update-window'),
    interactive: node?.closest?.('button,a,input,textarea,select,[contenteditable],[role="button"]')?.tagName ?? null });
  const state = fixture?.state, candidate = state?.candidate;
  const observer = owner.__UPDATER_BROWSER_KEY_OBSERVER__;
  return { focus: describe(document.activeElement), documentFocused: document.hasFocus(), visibility: document.visibilityState,
    buttons: [...document.querySelectorAll('.btn')].slice(0, 4).map(button => ({
      className: String(button.className).slice(0, 160), disabled: button.disabled, text: button.textContent.slice(0, 120) })),
    state: state ? { version: state.version, sequence: state.sequence, phase: state.phase, operationId: state.operationId,
      candidate: candidate ? { candidateId: candidate.candidateId, version: candidate.version, currentVersion: candidate.currentVersion,
        bodyBytes: new TextEncoder().encode(candidate.body ?? '').length } : null,
      progress: state.progress, error: state.error ? { code: state.error.code.slice(0, 128), message: state.error.message.slice(0, 256) } : null } : null,
    pending: fixture?.pending ?? null, callCount: fixture?.calls.length ?? 0,
    calls: (fixture?.calls ?? []).slice(-40).map(call => ({ command: call.command.slice(0, 128),
      request: call.args?.request ? { op: call.args.request.op, windowId: call.args.request.windowId,
        candidateId: call.args.request.candidateId, href: call.args.request.href?.slice(0, 200) } : null })),
    bodyText: document.querySelector('.update-window')?.textContent.slice(0, 2000) ?? null,
    keys: observer ? (stopObserver ? observer.stop() : observer.snapshot()) : null };
}

export function readUpdaterFacts(control, stopObserver = false) {
  return control.evaluate(`(${readUpdaterBrowserFacts.toString()})(window,${stopObserver})`);
}
export function beginUpdaterKeyObservation(control) {
  return control.evaluate(`(${installUpdaterKeyObserver.toString()})(window)`);
}

/** Only JavaScript diagnostics from the owned CDP page, not log/network domain entries. */
export function recordUpdaterJsDiagnostic(report, kind, event) {
  let level, message;
  if (kind === 'exception') {
    level = 'error';
    message = event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? 'JavaScript exception';
  } else if (kind === 'console-api' && ['error', 'warning'].includes(event.type)) {
    level = event.type;
    message = (event.args ?? []).slice(0, 8).map(arg => String(arg.value ?? arg.description ?? arg.type ?? '').slice(0, 256)).join(' ');
  } else return;
  // All current scenarios expect no JS error/warning. Never silently whitelist diagnostic text.
  if (report.console.length >= 64) {
    report.consoleOverflow = (report.consoleOverflow ?? 0) + 1;
    return;
  }
  report.console.push({ kind, level, source: 'owned-updater-headless-fixture', expected: false,
    message: String(message).slice(0, 1024) });
}
