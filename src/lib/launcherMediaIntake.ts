import { isAbsoluteLauncherPath, MAX_LAUNCHER_IMAGE_BYTES, MAX_LAUNCHER_IMAGE_URL_LENGTH, MEDIA_LIMIT_MESSAGE, type LauncherMediaInput } from "./launcherMediaContext";
export function transferHasAbsolutePaths(transfer: DataTransfer | null): boolean {
    const files = Array.from(transfer?.files ?? []);
    return files.length > 0 && files.length <= 1000 && files.every(file => {
        const path = (file as File & {
            path?: string;
        }).path;
        return typeof path === "string" && isAbsoluteLauncherPath(path);
    });
}
/** Relative browser upload hints never stand in for native-confirmed filesystem paths. */
export async function mediaInputFromTransfer(transfer: DataTransfer | null): Promise<LauncherMediaInput | null> {
    if ((transfer?.files?.length ?? 0) > 1000)
        throw new Error(MEDIA_LIMIT_MESSAGE);
    const files = Array.from(transfer?.files ?? []);
    if (!files.length)
        return null;
    const paths = files.map(file => (file as File & {
        path?: string;
    }).path);
    if (paths.every(path => typeof path === "string" && isAbsoluteLauncherPath(path)))
        return { kind: "files", paths: paths as string[] };
    if (files.length === 1 && files[0].type.startsWith("image/")) {
        const file = files[0];
        if (!/^image\/(?:png|jpeg|webp|tiff)$/i.test(file.type))
            throw new Error("此图片格式暂不支持，请使用 PNG、JPEG、WebP 或 TIFF。");
        if (file.size > MAX_LAUNCHER_IMAGE_BYTES)
            throw new Error(MEDIA_LIMIT_MESSAGE);
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败，请重新粘贴。"));
            reader.onerror = () => reject(new Error("图片读取失败，请重新粘贴。"));
            reader.onabort = () => reject(new Error("图片读取已取消。"));
            reader.readAsDataURL(file);
        });
        if (dataUrl.length > MAX_LAUNCHER_IMAGE_URL_LENGTH)
            throw new Error(MEDIA_LIMIT_MESSAGE);
        return { kind: "img", dataUrl };
    }
    return null;
}
export function canReadClipboardMedia(event: ClipboardEvent, _query: string): boolean {
    const target = event.target as HTMLInputElement | null;
    return Boolean(target?.dataset?.atoolsSearchInput === "true" && target.dataset.atoolsComposing !== "true"
        && !(event as ClipboardEvent & {
            isComposing?: boolean;
        }).isComposing);
}
export type LauncherPasteExpectation = {
    input: HTMLInputElement;
    value: string;
    start: number;
    end: number;
    consumed: boolean;
};
/** Expected native insertion lets one paste input through; later typing or selection movement supersedes it. */
export function launcherPasteExpectation(event: ClipboardEvent): LauncherPasteExpectation | null {
    const input = event.target as HTMLInputElement | null;
    if (!input || input.dataset.atoolsSearchInput !== "true")
        return null;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const rawText = event.clipboardData?.getData("text/plain") ?? "";
    // An empty native file transfer performs no text insertion or selection deletion.
    // A text input sanitizes CR/LF during its default paste insertion.
    const text = rawText.replace(/[\r\n]/g, "");
    const hasInsertion = rawText.length > 0;
    const value = hasInsertion ? input.value.slice(0, start) + text + input.value.slice(end) : input.value;
    const caret = start + text.length;
    return { input, value, start: hasInsertion ? caret : start, end: hasInsertion ? caret : end, consumed: false };
}
export function launcherPasteStillCurrent(expected: LauncherPasteExpectation, query: string): boolean {
    return expected.input.isConnected && expected.input.dataset.atoolsComposing !== "true" && query === expected.value
        && expected.input.value === expected.value && expected.input.selectionStart === expected.start && expected.input.selectionEnd === expected.end;
}
