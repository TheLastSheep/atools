export type DeepReadImportProjectionInput = {
  bookCount: number;
  fixtureBookPresent: boolean;
  lastBookSelected: boolean;
  pathStored: boolean;
  contentBytes: number | null;
  progressIndex: number | null;
  contentSha256: string | null;
};

export type DeepReadImportProjection = {
  bookCount: number | null;
  fixtureBookPresent: boolean;
  lastBookSelected: boolean;
  pathStored: boolean;
  contentBytes: number | null;
  progressIndex: number | null;
  contentBytesMatchesExpected: boolean;
  contentHashMatchesExpected: boolean;
};

const MAX_PROJECTED_BOOKS = 50;
const MAX_PROJECTED_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_PROJECTED_PROGRESS = 1_000_000;

function boundedCount(value: number | null, maximum: number): number | null {
  return Number.isSafeInteger(value) && value !== null && value >= 0 && value <= maximum ? value : null;
}

/** Emits only bounded counts, booleans, and nulls from an already validated SQLite snapshot. */
export function projectDeepReadImportSnapshot(
  snapshot: DeepReadImportProjectionInput,
  expectedContentBytes: number,
  expectedContentSha256: string,
): DeepReadImportProjection {
  return {
    bookCount: boundedCount(snapshot.bookCount, MAX_PROJECTED_BOOKS),
    fixtureBookPresent: snapshot.fixtureBookPresent === true,
    lastBookSelected: snapshot.lastBookSelected === true,
    pathStored: snapshot.pathStored === true,
    contentBytes: boundedCount(snapshot.contentBytes, MAX_PROJECTED_CONTENT_BYTES),
    progressIndex: boundedCount(snapshot.progressIndex, MAX_PROJECTED_PROGRESS),
    contentBytesMatchesExpected: snapshot.contentBytes === expectedContentBytes,
    contentHashMatchesExpected: snapshot.contentSha256 === expectedContentSha256,
  };
}
