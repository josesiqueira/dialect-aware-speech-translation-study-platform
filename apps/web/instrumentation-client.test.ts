import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Counts every `new Function(...)`, which is what the Content Security Policy
// of the production build blocks and reports.
const OriginalFunction = globalThis.Function;
let constructed = 0;

beforeAll(() => {
  globalThis.Function = new Proxy(OriginalFunction, {
    construct(target, args) {
      constructed += 1;
      return Reflect.construct(target, args) as object;
    },
  });
});

afterAll(() => {
  globalThis.Function = OriginalFunction;
});

describe("instrumentation-client", () => {
  it("turns on Zod's jitless setting before any schema exists, so Zod never calls new Function", async () => {
    await import("./instrumentation-client");
    const { z } = await import("zod");
    expect(z.config().jitless).toBe(true);

    // The shared validators create their object schemas when the module loads.
    const { sessionSchemas } = await import("@dialect/domain");
    expect(sessionSchemas).toBeDefined();

    const schema = z.object({ name: z.string(), age: z.number().int() });
    expect(schema.parse({ name: "a", age: 1 })).toEqual({ name: "a", age: 1 });
    expect(schema.safeParse({ name: 1 }).success).toBe(false);

    expect(constructed).toBe(0);
  });
});
