import {
  SETTINGS_REGISTRATION_ALIAS, SETTINGS_REGISTRATION_FOCUS_STAGES, settingsRegistrationFixturePaths,
} from "./ztools-launch-return-settings-registration.mjs";

/** Synthetic closed-contract data for validator tests; never used as native acceptance evidence. */
export function makeLaunchReturnSettingsRegistrationFixture(root, settingsBundleRevision = "a".repeat(64)) {
  const fixturePaths = settingsRegistrationFixturePaths(root);
  const dropRows = Object.entries(fixturePaths).map(([role, path], index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    name: path.split("/").at(-1), path, type: role.endsWith("App") ? "app" : role,
    addedAt: 1_700_000_000_000 + index,
  }));
  const child = (sessionId) => ({ label: `ztools-settings-${sessionId}`, sessionId,
    origin: `atools-settings://${sessionId}.localhost`, bundleRevision: settingsBundleRevision,
    url: `atools-settings://${sessionId}.localhost/index.html#/localLaunch`, phase: "open", ready: true,
    documentVisibility: "visible", documentHasFocus: false });
  const firstChild = child("11111111111141118111111111111111");
  const secondChild = child("22222222222242228222222222222222");
  const closed = () => ({ sessionCount: 0, childCount: 0, layoutCount: 0, pendingCalls: 0, pendingWrites: 0, bindingActive: false });
  const finalRows = structuredClone(dropRows.slice(0, 2));
  return {
    settingsBundleRevision, registrationSqlite: { valid: true, revision: 8, rows: structuredClone(finalRows) },
    registration: {
      status: "passed", inputSource: "rust-injected-drag-event", physicalOsDrop: false, deadlineMs: 60_000,
      fixturePaths, initial: { rows: [], revision: 0 }, firstChild,
      drop: { rows: dropRows, revision: 4, uiRows: 4, feedback: true, mainRevision: 4,
        binding: { sessionId: firstChild.sessionId, childLabel: firstChild.label, bundleRevision: settingsBundleRevision,
          bindingNonce: "33333333333343338333333333333333", batchNonce: "44444444444444448444444444444444",
          added: 4, failed: 0, resultNoticeEnqueued: true } },
      alias: { value: SETTINGS_REGISTRATION_ALIAS, revision: 5,
        rows: dropRows.map((row, index) => index === 0 ? { ...row, alias: SETTINGS_REGISTRATION_ALIAS } : { ...row }) },
      firstClose: closed(), aliasSearch: { query: SETTINGS_REGISTRATION_ALIAS, path: fixturePaths.firstApp,
        subType: "local-shortcut", matched: true, launchCallsBefore: 0, launchCallsAfter: 0 },
      secondChild, reopen: { aliasPersisted: true, documentChanged: true, sessionChanged: true },
      cleanup: { rows: finalRows, revision: 8, aliasCleared: true, fileDeleted: true, folderDeleted: true },
      finalClose: closed(), acl: { dragEnter: "denied", dragOver: "denied", dragDrop: "denied", dragLeave: "denied", cleanup: true },
      identity: { wrongMainRejected: true, oldSessionRejected: true, oldBindingRejected: true, nonceBound: true, childRoleBound: true },
      focus: SETTINGS_REGISTRATION_FOCUS_STAGES.map(stage => ({ stage, visible: false, focused: false,
        applicationActive: false, mainKey: false, focusGainedEvents: 0 })),
      mainEvents: { initial: 0, dropped: 4, aliased: 5, cleaned: 8 },
      mainCalls: { initialOpen: 0, firstOpen: 1, secondOpen: 2, initialLaunch: 0, afterAliasSearch: 0, finalLaunch: 0 },
    },
  };
}
