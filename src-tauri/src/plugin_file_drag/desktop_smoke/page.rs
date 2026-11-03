pub(super) const SOURCE_PAGE: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SOURCE — native file drag</title>
  <style>
    :root { color-scheme: light; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #183238; background: #f3f8f6; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 22px; }
    h1 { margin: 0 0 5px; color: #087e78; font-size: 21px; letter-spacing: -.02em; }
    .lead { margin: 0 0 18px; color: #527075; }
    .file { display: grid; place-items: center; min-height: 150px; padding: 18px; border: 2px dashed #0c9c8d; border-radius: 18px; background: #e2f6ef; text-align: center; user-select: none; -webkit-user-drag: element; cursor: grab; }
    .file:active { cursor: grabbing; }
    .icon { display: block; margin-bottom: 8px; font-size: 40px; }
    .file strong { display: block; font-size: 18px; }
    .uuid { color: #527075; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .steps { margin: 16px 0; padding-left: 21px; color: #39585d; }
    .steps li { margin: 4px 0; }
    .status { min-height: 55px; padding: 10px 12px; border-radius: 10px; background: #fff; border: 1px solid #cfdfdb; }
    .paths { margin-top: 9px; color: #637a7e; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    button { margin-top: 12px; padding: 9px 13px; border: 0; border-radius: 9px; background: #087e78; color: white; font: inherit; cursor: pointer; }
    button:disabled { background: #a7b9b7; cursor: default; }
    .foot { margin-top: 10px; color: #73878a; font-size: 11px; }
  </style>
</head>
<body>
  <h1>SOURCE · native drag</h1>
  <p class="lead">Drag this fixed fixture file with a real mouse gesture.</p>
  <div id="file" class="file" draggable="false" aria-label="Drag fixed smoke file">
    <div><span class="icon">📄</span><strong>input.txt</strong><span class="uuid">123e4567-e89b-12d3-a456-426614174000</span></div>
  </div>
  <ol class="steps">
    <li>Drop on TARGET; confirm the native drop.</li>
    <li>Drag again and press Escape or release outside both windows.</li>
    <li>Drag once more to TARGET to prove retry works.</li>
  </ol>
  <div id="status" class="status">Preparing the AppKit mouse monitor…</div>
  <div id="paths" class="paths"></div>
  <button id="finish" type="button" disabled>Finish and close fixture</button>
  <div class="foot">Only this isolated fixture file is offered. The report is written in the scratch directory.</div>
  <script>
    const invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
    const status = document.getElementById('status');
    const paths = document.getElementById('paths');
    const file = document.getElementById('file');
    const finish = document.getElementById('finish');
    let ready = false;
    let active = false;

    file.addEventListener('dragstart', event => {
      // Let the native adapter consume the real mouse-down captured by AppKit.
      // No synthetic mouse or drop events are created by this page.
      event.preventDefault();
      if (!ready) {
        status.textContent = 'Wait until the native mouse monitor is ready.';
        return;
      }
      if (active) return;
      active = true;
      status.textContent = 'Real dragstart observed; requesting native file drag…';
      invoke('begin_native_file_drag_smoke').then(ack => {
        status.textContent = `Native start acknowledged for round ${ack.attemptId}. Drag to TARGET or cancel with Escape.`;
      }).catch(error => {
        active = false;
        status.textContent = `Native start was rejected. Retry with a real mouse drag: ${String(error)}`;
      });
    });

    async function refresh() {
      try {
        const state = await invoke('native_file_drag_smoke_status');
        if (!state.dragActive) active = false;
        const attempts = state.attempts.map(item => `#${item.id} ${item.outcome || (item.startAck ? 'in progress' : 'pending')}`).join(' · ');
        status.textContent = state.passed
          ? `PASS · native drop, cancellation, and retry were recorded. ${attempts}`
          : `${state.prepared ? 'Ready' : 'Preparing'} · rounds: ${attempts || 'none'}${state.lastStartRejection ? ` · retry: ${state.lastStartRejection}` : ''}`;
        paths.textContent = `Report: ${state.reportPath}  |  Events: ${state.eventLogPath}`;
        finish.disabled = !state.passed;
      } catch (error) {
        status.textContent = `Status unavailable: ${String(error)}`;
      }
    }

    finish.addEventListener('click', () => {
      finish.disabled = true;
      invoke('finish_native_file_drag_smoke').catch(error => {
        status.textContent = `Unable to close fixture: ${String(error)}`;
        finish.disabled = false;
      });
    });

    invoke('prepare_native_file_drag_smoke').then(() => {
      ready = true;
      file.draggable = true;
      return refresh();
    }).catch(error => {
      status.textContent = `Native monitor preparation failed: ${String(error)}`;
    });
    window.setInterval(refresh, 400);
  </script>
</body>
</html>"##;

pub(super) const TARGET_PAGE: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TARGET — real OS drop</title>
  <style>
    :root { color-scheme: light; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #24354d; background: #f5f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 22px; }
    h1 { margin: 0 0 5px; color: #315fc5; font-size: 21px; letter-spacing: -.02em; }
    .lead { margin: 0 0 18px; color: #657490; }
    .receiver { display: grid; place-items: center; min-height: 205px; padding: 20px; border: 2px dashed #7999e0; border-radius: 18px; background: #eaf0ff; text-align: center; }
    .icon { display: block; margin-bottom: 8px; font-size: 42px; }
    .receiver strong { display: block; font-size: 18px; }
    .status { margin-top: 16px; min-height: 75px; padding: 12px; border-radius: 10px; background: white; border: 1px solid #d6deee; }
    .hint { margin-top: 12px; color: #71809b; font-size: 12px; }
    .drop { color: #087e78; font-weight: 700; }
  </style>
</head>
<body>
  <h1>TARGET · real OS drop</h1>
  <p class="lead">Release the source file anywhere inside this window.</p>
  <div class="receiver"><div><span class="icon">⇩</span><strong>Native file receiver</strong><span>Waiting for Tauri DragDropEvent::Drop</span></div></div>
  <div id="status" class="status">No native drop has been observed.</div>
  <div class="hint">Evidence comes from the target window's native Tauri event and fixed-file content check. This page does not synthesize a DOM drop.</div>
  <script>
    const invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
    const status = document.getElementById('status');
    async function refresh() {
      try {
        const state = await invoke('native_file_drag_smoke_status');
        const drops = state.targetDrops.map(drop => {
          const valid = drop.pathMatchesExpected && drop.contentMatchesExpected;
          return `round ${drop.attemptId ?? '?'}: ${valid ? 'fixed path and UUID content matched' : 'drop mismatch'} at (${drop.x}, ${drop.y})`;
        });
        status.innerHTML = drops.length
          ? `<span class="drop">${drops.length} native drop event(s)</span><br>${drops.map(item => String(item).replaceAll('&', '&amp;').replaceAll('<', '&lt;')).join('<br>')}`
          : 'No native drop has been observed.';
      } catch (error) {
        status.textContent = `Status unavailable: ${String(error)}`;
      }
    }
    window.setInterval(refresh, 400);
    refresh();
  </script>
</body>
</html>"##;
