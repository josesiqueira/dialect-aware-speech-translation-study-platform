import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv, resetEnvCacheForTests } from "./env";
import { checkConfigurationAtStartup } from "./startup";
import { applyTestEnv, TEST_ENV } from "./test/setup";

afterEach(() => {
  applyTestEnv();
  resetEnvCacheForTests();
});

const invalid = () => parseEnv({ ...TEST_ENV, DATABASE_URL: undefined, ADMIN_SESSION_SECRET: "too-short" });

describe("checkConfigurationAtStartup", () => {
  it("returns true and neither logs nor exits when the configuration is valid", () => {
    const exit = vi.fn();
    const log = vi.fn();
    expect(checkConfigurationAtStartup({ nodeEnv: "production", exit, log })).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("ends the process with exit code 1 in production and names the variables, never their values", () => {
    const exit = vi.fn();
    const log = vi.fn();
    expect(checkConfigurationAtStartup({ nodeEnv: "production", exit, log, validate: invalid })).toBe(false);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("DATABASE_URL");
    expect(printed).toContain("ADMIN_SESSION_SECRET");
    expect(printed).not.toContain("too-short");
    expect(printed).toContain("The server stops because its configuration is invalid.");
  });

  it("prints the problem and keeps running outside production", () => {
    for (const nodeEnv of ["development", "test", undefined]) {
      const exit = vi.fn();
      const log = vi.fn();
      expect(checkConfigurationAtStartup({ nodeEnv, exit, log, validate: invalid })).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).toContain("DATABASE_URL");
    }
  });

  it("reads the real environment by default", () => {
    const exit = vi.fn();
    const log = vi.fn();
    delete process.env.DATABASE_URL;
    resetEnvCacheForTests();
    expect(checkConfigurationAtStartup({ nodeEnv: "production", exit, log })).toBe(false);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe("configuration warnings at startup", () => {
  it("prints a loud warning for a public address without a trusted proxy, and keeps running", () => {
    const exit = vi.fn();
    const log = vi.fn();
    const warn = vi.fn();
    const validate = () => parseEnv({ ...TEST_ENV, NODE_ENV: "production", APP_URL: "https://study.example.org", TRUST_PROXY: "false" });
    expect(checkConfigurationAtStartup({ nodeEnv: "production", exit, log, warn, validate })).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("CONFIGURATION WARNING (TRUST_PROXY_OFF_ON_PUBLIC_URL)");
    expect(String(warn.mock.calls[0]![0])).toContain("TRUST_PROXY=true");
  });

  it("prints no warning on localhost", () => {
    const warn = vi.fn();
    expect(checkConfigurationAtStartup({ nodeEnv: "development", warn, validate: () => parseEnv({ ...TEST_ENV }) })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
