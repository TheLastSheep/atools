const MAX_HOME_COMMAND_HINT_CODE_POINTS = 256;

/** Bound third-party command text before trimming or rendering it. */
export function boundedHomeCommandHintText(value: string): string {
  const codePoints: string[] = [];
  let offset = 0;
  let visited = 0;

  while (offset < value.length && visited < MAX_HOME_COMMAND_HINT_CODE_POINTS + 1) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    offset += codePoint > 0xffff ? 2 : 1;
    visited += 1;
    if (visited <= MAX_HOME_COMMAND_HINT_CODE_POINTS) {
      codePoints.push(String.fromCodePoint(codePoint));
    } else {
      codePoints[MAX_HOME_COMMAND_HINT_CODE_POINTS - 1] = "…";
    }
  }

  return codePoints.join("").trim();
}
