/** Fixed 32×16 RGBA PNG: sixteen red columns followed by sixteen green columns. */
export const originalImagePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAYAAAB3AH1ZAAAAJElEQVR4nGP4z8DwnxJMBTjqgFEHjDpg1AGjDhh1wKgDBtYBANnx/C6l1ra9AAAAAElFTkSuQmCC";
export const originalImageDataUrl = "data:image/png;base64," + originalImagePngBase64;
/** Provision a real File/DataTransfer into the real App handler. This is not an OS paste or a trusted event. */
export function provideOriginalImagePaste() {
  const input = document.querySelector<HTMLInputElement>('[data-atools-search-input="true"]');
  if (!input || document.activeElement !== input) throw Error("Trusted CDP click must focus the actual launcher before fixture paste");
  const bytes = Uint8Array.from(atob(originalImagePngBase64), value => value.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], "fixed-red-green.png", { type: "image/png" }));
  const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
  const dispatched = input.dispatchEvent(event);
  return { isTrusted: event.isTrusted, dispatched, defaultPrevented: event.defaultPrevented, fileCount: transfer.files.length,
    fileName: transfer.files[0].name, bytes: bytes.length, mime: transfer.files[0].type, inputProvision: "fixture File/DataTransfer; no OS clipboard read or write" };
}
