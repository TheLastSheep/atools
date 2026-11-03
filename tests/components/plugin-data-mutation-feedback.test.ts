import { describe, expect, it, vi } from "vitest";
import { createPluginDataMutationFeedback } from "../../src/lib/pluginDataMutationFeedback";

const recordId = "pasteboard-pro:record:sha256:record-a";

function createSession() {
  const operationFeedback = { failed: vi.fn(), resolved: vi.fn() };
  const feedback = createPluginDataMutationFeedback(operationFeedback);
  feedback.generationChanged(1);
  return { feedback, operationFeedback };
}

describe("plugin data mutation feedback state", () => {
  it("clears a same-ID failure only after a newer success and can report another failure", () => {
    const { feedback, operationFeedback } = createSession();
    const failed = feedback.begin("db.put", [{ _id: recordId }], 1)!;
    feedback.failed("db.put", [{ _id: recordId }], 1, failed);
    expect(operationFeedback.failed).toHaveBeenCalledTimes(1);

    const retry = feedback.begin("db.put", [{ _id: recordId }], 1)!;
    feedback.resolved("db.put", [{ _id: recordId }], 1, retry);
    expect(operationFeedback.resolved).toHaveBeenCalledTimes(1);

    const laterFailure = feedback.begin("db.put", [{ _id: recordId }], 1)!;
    feedback.failed("db.put", [{ _id: recordId }], 1, laterFailure);
    expect(operationFeedback.failed).toHaveBeenCalledTimes(2);
  });

  it("ignores reads and other IDs while preserving the tracked failure", () => {
    const { feedback, operationFeedback } = createSession();
    const failed = feedback.begin("db.put", [{ _id: recordId }], 1)!;
    feedback.failed("db.put", [{ _id: recordId }], 1, failed);

    expect(feedback.begin("db.get", [recordId], 1)).toBeUndefined();
    feedback.resolved("db.get", [recordId], 1, undefined);
    const other = feedback.begin("db.put", [{ _id: "other-record" }], 1)!;
    feedback.resolved("db.put", [{ _id: "other-record" }], 1, other);
    expect(operationFeedback.resolved).not.toHaveBeenCalled();

    const retry = feedback.begin("db.put", [{ _id: recordId }], 1)!;
    feedback.resolved("db.put", [{ _id: recordId }], 1, retry);
    expect(operationFeedback.resolved).toHaveBeenCalledTimes(1);
  });

  it("does not let an older success or a replacement generation clear the notice", () => {
    const { feedback, operationFeedback } = createSession();
    const older = feedback.begin("db.put", [{ _id: recordId }], 1)!;
    const newer = feedback.begin("db.put", [{ _id: recordId }], 1)!;
    feedback.failed("db.put", [{ _id: recordId }], 1, newer);
    feedback.resolved("db.put", [{ _id: recordId }], 1, older);
    expect(operationFeedback.resolved).not.toHaveBeenCalled();

    feedback.generationChanged(2);
    const replacement = feedback.begin("db.put", [{ _id: recordId }], 2)!;
    feedback.resolved("db.put", [{ _id: recordId }], 2, replacement);
    feedback.resolved("db.put", [{ _id: recordId }], 1, newer);
    expect(operationFeedback.resolved).not.toHaveBeenCalled();
  });
});
