import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

const API_KEY = "sk-test-THIS-KEY-MUST-NEVER-APPEAR-1234567890";

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    secrets: [API_KEY, 'pass"word\\with-escapes', undefined],
    write: (line) => lines.push(line),
  });
  return { logger, lines, text: () => lines.join("") };
}

describe("logger redaction", () => {
  it("removes sensitive keys at the top level and when nested", () => {
    const { logger, lines, text } = capture();
    logger.info(
      {
        authorization: "Bearer abc.def",
        cookie: "dts_admin=sealed-value",
        password: "hunter2-plain",
        apiKey: "key-in-field",
        OPENAI_API_KEY: "key-in-env-field",
        req: { headers: { authorization: "Bearer nested", cookie: "dts_participant=tok", "set-cookie": "a=b" } },
        body: { password: "nested-password" },
        requestId: "req-1",
      },
      "request",
    );
    expect(lines).toHaveLength(1);
    const output = text();
    for (const secret of ["Bearer abc.def", "sealed-value", "hunter2-plain", "key-in-field", "key-in-env-field", "Bearer nested", "dts_participant=tok", "nested-password", "a=b"]) {
      expect(output).not.toContain(secret);
    }
    const parsed = JSON.parse(output);
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed.req.headers.cookie).toBe("[REDACTED]");
    expect(parsed.requestId).toBe("req-1");
  });

  it("replaces a secret value that appears inside a message or an error text", () => {
    const { logger, text } = capture();
    logger.error({ err: { message: `Incorrect API key provided: ${API_KEY}` } }, `provider said ${API_KEY}`);
    logger.warn(`again ${API_KEY}`);
    logger.info({ note: 'value pass"word\\with-escapes here' }, "escaped");
    const output = text();
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain("with-escapes");
    expect(output).toContain("[REDACTED]");
    for (const line of output.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe("the logger of the web process", () => {
  it("removes the S3 access key id as well as the secret key wherever they appear", async () => {
    const { resetProcessServicesForTests, getLogger } = await import("./context");
    const { applyTestEnv } = await import("./test/setup");
    await resetProcessServicesForTests();
    applyTestEnv({
      LOG_LEVEL: "info",
      S3_ACCESS_KEY_ID: "AKIAEXAMPLEACCESSKEY",
      S3_SECRET_ACCESS_KEY: "s3-secret-value-that-must-not-appear",
    });
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      getLogger().info(
        { detail: "request signed with AKIAEXAMPLEACCESSKEY failed" },
        "storage error for s3-secret-value-that-must-not-appear",
      );
    } finally {
      process.stdout.write = original;
      await resetProcessServicesForTests();
    }
    const text = written.join("");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("AKIAEXAMPLEACCESSKEY");
    expect(text).not.toContain("s3-secret-value-that-must-not-appear");
  });
});
