import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { studies } from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

describe("createTestDatabase", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("provides an empty migrated database", async () => {
    expect(await t.db.select().from(studies)).toEqual([]);
    const [row] = await t.db.insert(studies).values({ slug: "s", name: "S" }).returning();
    expect(row?.status).toBe("active");
  });
});
