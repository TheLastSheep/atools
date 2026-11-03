import { mediaInputFromTransfer, canReadClipboardMedia, launcherPasteExpectation, launcherPasteStillCurrent, type LauncherPasteExpectation, transferHasAbsolutePaths } from "./launcherMediaIntake";
import type { LauncherClipboardMedia, LauncherMediaInput } from "./launcherMediaContext";
type Options = {
    begin: (kind?: "files" | "img") => number;
    current: (revision: number) => boolean;
    cancel: () => void;
    read: (filesOnly?: boolean) => Promise<LauncherClipboardMedia>;
    available: () => boolean;
    query: () => string;
    pin: (input: LauncherMediaInput) => void;
    error: (message: string) => void;
};
/** An explicit paste may probe native media once. Its reply cannot replace a later edit or selection. */
export function createLauncherMediaPaste(options: Options) {
    let expected: LauncherPasteExpectation | null = null;
    const waitForDefault = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    async function probe(event: ClipboardEvent, fixedGuard?: () => boolean, prevented = false) {
        if (!options.available() || !canReadClipboardMedia(event, options.query()))
            return;
        const revision = options.begin();
        const expectation = fixedGuard ? null : launcherPasteExpectation(event);
        expected = expectation;
        if (prevented && expectation) {
            expectation.value = expectation.input.value;
            expectation.start = expectation.input.selectionStart ?? 0;
            expectation.end = expectation.input.selectionEnd ?? expectation.start;
        }
        try {
            const result = await options.read();
            await waitForDefault();
            if (!options.current(revision) || !(fixedGuard ? fixedGuard() : expectation && launcherPasteStillCurrent(expectation, options.query())))
                return;
            if (result?.kind === "files")
                options.pin({ kind: "files", paths: result.files.map(file => file.path) });
            else if (result?.kind === "img")
                options.pin({ kind: "img", dataUrl: result.dataUrl });
        }
        catch {
            // Plain-text insertion remains usable even when a best-effort native probe fails.
            if ((prevented || expectation?.value === "") && options.current(revision))
                options.error("未能读取粘贴内容，请复制文件或图片后重试。");
        }
        finally {
            if (expected === expectation)
                expected = null;
        }
    }
    return {
        observeQuery(value: string) {
            if (expected && !expected.consumed && value === expected.value) {
                expected.consumed = true;
                return;
            }
            options.cancel();
            expected = null;
        },
        probe(event: ClipboardEvent, fixedGuard?: () => boolean) { void probe(event, fixedGuard); },
        handleFiles(event: ClipboardEvent): boolean {
            if (!event.clipboardData?.files?.length || !canReadClipboardMedia(event, options.query()))
                return false;
            const revision = options.begin(event.clipboardData.files.length === 1 && event.clipboardData.files[0].type?.startsWith("image/") ? "img" : "files");
            expected = null;
            const transfer = event.clipboardData;
            const filesOnly = transfer.files.length === 1 && transfer.files[0].type?.startsWith("image/");
            const inputRead = mediaInputFromTransfer(transfer);
            const nativeRead = !transferHasAbsolutePaths(transfer) && options.available()
                ? Promise.resolve().then(() => options.read(Boolean(filesOnly))) : Promise.resolve(null);
            void Promise.allSettled([inputRead, nativeRead]).then(([local, native]) => {
                if (!options.current(revision))
                    return;
                const clipboard = native.status === "fulfilled" ? native.value : null;
                if (clipboard?.kind === "files") {
                    options.pin({ kind: "files", paths: clipboard.files.map(file => file.path) });
                }
                else if (local.status === "fulfilled" && local.value) {
                    options.pin(local.value);
                }
                else if (clipboard?.kind === "img") {
                    options.pin({ kind: "img", dataUrl: clipboard.dataUrl });
                }
                else {
                    const message = local.status === "rejected" && local.reason instanceof Error
                        ? local.reason.message : "未能读取粘贴内容，请复制文件或图片后重试。";
                    options.error(message);
                }
            });
            return true;
        },
    };
}
