import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, httpStatusOf, isAppError } from "./errors";

// A second, separately defined class with the same shape as AppError. This is
// what code sees when one process holds two copies of this module (the
// production web bundle, or a development server after a hot reload).
class AppErrorCopy extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

class SubclassCopy extends AppErrorCopy {
  constructor(name: string, code: string) {
    super(code, "from a subclass of another copy");
    this.name = name;
  }
}

describe("isAppError", () => {
  it("accepts an AppError of this module", () => {
    expect(isAppError(new AppError("NOT_FOUND", "missing"))).toBe(true);
  });

  it("accepts an error of the same shape made by a second, separately defined class", () => {
    const foreign = new AppErrorCopy("CONFIGURATION_MISSING", "No key.", { provider: "openai" });
    expect(foreign).not.toBeInstanceOf(AppError);
    expect(isAppError(foreign)).toBe(true);
    if (isAppError(foreign)) {
      expect(foreign.code).toBe("CONFIGURATION_MISSING");
      expect(foreign.details).toEqual({ provider: "openai" });
      expect(httpStatusOf(foreign)).toBe(422);
    }
  });

  it("accepts the subclasses of another copy by their names", () => {
    expect(isAppError(new SubclassCopy("AiProviderError", "ASR_PROVIDER_ERROR"))).toBe(true);
    expect(isAppError(new SubclassCopy("WavParseError", "INVALID_AUDIO"))).toBe(true);
  });

  it("accepts every error code", () => {
    for (const code of ERROR_CODES) expect(isAppError(new AppErrorCopy(code, "x"))).toBe(true);
  });

  it("refuses everything else", () => {
    expect(isAppError(new Error("plain"))).toBe(false);
    expect(isAppError(new AppErrorCopy("NOT_A_CODE", "unknown code"))).toBe(false);
    expect(isAppError(new SubclassCopy("SomeOtherError", "NOT_FOUND"))).toBe(false);
    // A database error has a `code` too, but neither the name nor a known code.
    expect(isAppError(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
    // Not an Error: a plain object of the same shape, for example parsed JSON.
    expect(isAppError({ name: "AppError", code: "NOT_FOUND", message: "x" })).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError("AppError")).toBe(false);
  });
});
