/** Keep rejected lazy imports inside the effect generation that requested them. */
export async function settlePluginPanelLoad<T>(
  load: () => Promise<T>,
  isCurrent: () => boolean,
  onLoaded: (value: T) => void,
  onCurrentError: (error: unknown) => void,
): Promise<void> {
  try {
    const value = await load();
    if (!isCurrent()) return;
    onLoaded(value);
  } catch (error) {
    if (!isCurrent()) return;
    onCurrentError(error);
  }
}
