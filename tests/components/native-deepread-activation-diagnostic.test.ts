import { expect, it } from "vitest";
import { projectDeepReadActivationFailure } from "./nativeDeepReadActivationDiagnostic";

const record = (error: unknown, stage: "port-unavailable" | "callback-reported-error" = "callback-reported-error") =>
  projectDeepReadActivationFailure(error, stage);

it("distinguishes a missing fixture port, unknown command, invalid arguments, and TaskRun persistence failure", () => {
  expect(record(undefined, "port-unavailable").errorCode).toBe("FILES_PORT_MISSING");
  expect(record(new Error("Command activate_file_content_feature not found")).errorCode).toBe("COMMAND_NOT_FOUND");
  expect(record({ name: "InvokeError", message: "invalid args: expected code string" }).errorCode).toBe("INVALID_ARGUMENTS");
  expect(record("SQLite failed to persist TaskRun").errorCode).toBe("TASK_RUN_CREATE_FAILED");
  expect(record("SQLite disk is full").errorCode).toBe("ACTIVATION_REJECTED");
  expect(record("database connection failed").errorCode).toBe("ACTIVATION_REJECTED");
});

it("retains only fixed reason text and bounded shape when errors contain paths and credentials", () => {
  const secret = "/Users/private/home/Downloads/book.txt token=secret-token nonce=abc authorization=Bearer secret-key";
  const projected = record(Object.assign(new Error(`Command activate_file_content_feature not found ${secret}`), {
    stack: `${secret}\n${"x".repeat(10000)}`
  }));
  const encoded = JSON.stringify(projected);
  expect(projected).toMatchObject({ phase: "deepread-original-fixed-file-import", command: "activate_file_content_feature",
    featureCode: "deepread-import", pluginId: "deepread", fileCount: 1, errorKind: "error",
    errorName: "Error", errorCode: "COMMAND_NOT_FOUND" });
  expect(projected.reason.length).toBeLessThanOrEqual(160);
  expect(new TextEncoder().encode(encoded).length).toBeLessThan(1024);
  for (const privateValue of ["/Users/private", "Downloads", "secret-token", "nonce=abc", "authorization", "secret-key", "stack"]) {
    expect(encoded).not.toContain(privateValue);
  }
});

it("accepts only plain object diagnostics and never serializes arbitrary or malformed fields", () => {
  const safe = record({ name: "TauriError", code: "FILE_INPUT_UNAVAILABLE", message: "/private/tmp/path" });
  expect(safe).toMatchObject({ errorKind: "plain-object", errorName: "TauriError", errorCode: "FILE_INPUT_UNAVAILABLE" });
  expect(JSON.stringify(safe)).not.toContain("/private/tmp/path");
  expect(record(["command not found"]).errorKind).toBe("malformed");
  expect(record(null).errorKind).toBe("malformed");
  const throwing = new Proxy({}, { getPrototypeOf() { throw Error("/Users/secret"); } });
  const malformed = record(throwing);
  expect(malformed).toMatchObject({ errorKind: "malformed", errorCode: "ACTIVATION_REJECTED" });
  expect(JSON.stringify(malformed)).not.toContain("/Users/secret");
});

it("normalizes unknown text and codes to a fixed safe category", () => {
  const projected = record({ code: "Bearer secret", message: `mystery /Users/user/file token=secret` });
  expect(projected.errorCode).toBe("ACTIVATION_REJECTED");
  expect(projected.reason).toBe("Reported error category: activation rejected; raw details omitted.");
  expect(JSON.stringify(projected)).not.toMatch(/Bearer|secret|Users|file token/);
});

it("classifies only the bounded message prefix for strings, Errors, and plain objects", () => {
  const privateTail = `${"x".repeat(1024)} TaskRun failed to persist /Users/private token=secret`;
  for (const error of [privateTail, new Error(privateTail), { name: "Error", message: privateTail }]) {
    const projected = record(error);
    const encoded = JSON.stringify(projected);
    expect(projected.errorCode).toBe("ACTIVATION_REJECTED");
    expect(new TextEncoder().encode(encoded).length).toBeLessThan(1024);
    expect(encoded).not.toMatch(/TaskRun|Users|token=secret/);
  }

  const boundedHead = `${"TaskRun failed to persist ".repeat(8)}${"x".repeat(10000)} token=secret`;
  for (const error of [boundedHead, new Error(boundedHead), { name: "Error", message: boundedHead }]) {
    const projected = record(error);
    const encoded = JSON.stringify(projected);
    expect(projected.errorCode).toBe("TASK_RUN_CREATE_FAILED");
    expect(new TextEncoder().encode(encoded).length).toBeLessThan(1024);
    expect(encoded).not.toMatch(/token=secret|x{100}/);
  }
});


it("classifies only the four fixed desktop-smoke activation errors", () => {
  const cases = [
    ["App desktop-smoke activation port is unavailable", "APP_ACTIVATION_PORT_UNAVAILABLE"],
    ["Desktop smoke activation scope is unavailable", "ACTIVATION_SCOPE_UNAVAILABLE"],
    ["DeepRead smoke activation input is outside its fixed fixture scope", "ACTIVATION_INPUT_OUT_OF_SCOPE"],
    ["Desktop smoke activation scope ended during feature activation", "ACTIVATION_SCOPE_ENDED"]
  ] as const;
  for (const [message, errorCode] of cases) {
    const projected = record(new Error(message));
    expect(projected.errorCode).toBe(errorCode);
    expect(projected.reason).not.toContain(message);
    expect(JSON.stringify(projected)).not.toContain(message);
  }

  for (const message of [
    "Desktop smoke activation scope is unavailable: /private/path",
    "DeepRead smoke activation input is outside its fixed fixture scope (flag=unsafe)",
    "Desktop smoke activation scope ended during feature activation: token=secret",
    "app desktop-smoke activation port is unavailable"
  ]) {
    expect(record(new Error(message)).errorCode).toBe("ACTIVATION_REJECTED");
  }
});


it("keeps prototype-property messages as bounded generic rejections", () => {
  for (const message of ["toString", "constructor", "__proto__"]) {
    for (const error of [message, new Error(message), { message }]) {
      const projected = record(error);
      expect(projected.errorCode).toBe("ACTIVATION_REJECTED");
      expect(JSON.stringify(projected)).not.toContain(message);
      expect(new TextEncoder().encode(JSON.stringify(projected)).length).toBeLessThan(1024);
    }
  }
});
