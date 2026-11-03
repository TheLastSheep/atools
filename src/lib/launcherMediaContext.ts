import type { PastedItem } from "./pasteIntake";
export type LauncherFile = {
    path: string;
    name: string;
    isFile: boolean;
    isDirectory: boolean;
};
export type LauncherMediaInput = {
    kind: "files";
    paths: string[];
} | {
    kind: "img";
    dataUrl: string;
};
export type LauncherMediaContent = {
    kind: "files";
    paths: string[];
    files: LauncherFile[];
} | {
    kind: "img";
    dataUrl: string;
};
export type LauncherClipboardMedia = {
    kind: "files";
    files: LauncherFile[];
} | {
    kind: "img";
    dataUrl: string;
} | null;
export const MAX_LAUNCHER_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_LAUNCHER_IMAGE_URL_LENGTH = 8 * 1024 * 1024;
export const MEDIA_LIMIT_MESSAGE = "内容超过处理上限，请缩小内容后重试；不会截断执行。";
export function launcherMediaWithinBudget(input: LauncherMediaInput): boolean {
    if (input.kind === "img")
        return input.dataUrl.length <= MAX_LAUNCHER_IMAGE_URL_LENGTH
            && /^data:image\/(?:png|jpeg|webp|tiff);base64,[A-Za-z0-9+/]*={0,2}$/i.test(input.dataUrl)
            && Math.floor((input.dataUrl.length - input.dataUrl.indexOf(",") - 1) * 3 / 4) - (input.dataUrl.match(/=+$/)?.[0].length ?? 0) <= MAX_LAUNCHER_IMAGE_BYTES;
    if (!input.paths.length || input.paths.length > 1000)
        return false;
    let bytes = 0;
    return input.paths.every(path => {
        const length = new TextEncoder().encode(path).length;
        bytes += length;
        return isAbsoluteLauncherPath(path) && length <= 8192 && bytes <= 256 * 1024;
    });
}
export function isAbsoluteLauncherPath(path: string): boolean {
    return !path.includes("\0") && (/^\//.test(path) || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path));
}
export function launcherMediaSummary(content: LauncherMediaContent): string {
    if (content.kind === "img")
        return "图片";
    return content.files.length === 1 ? content.files[0].name.slice(0, 80) : `${content.paths.length} 个文件`;
}
export function launcherMediaPastedItems(content: LauncherMediaContent): PastedItem[] {
    if (content.kind === "img")
        return [{ id: "paste-0", kind: "image", name: "粘贴图片", type: "image/png", size: 0 }];
    return content.files.map((file, index) => ({ id: `paste-${index}`, kind: /\.(?:png|jpe?g|webp|tiff?|bmp|gif)$/i.test(file.name) && file.isFile ? "image" : "file",
        name: file.name, type: "", size: 0, path: file.path }));
}
