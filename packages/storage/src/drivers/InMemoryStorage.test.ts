import { describe, expect, it } from "vitest";
import { runAdapterContract } from "../testing/adapterContract";
import { InMemoryStorage } from "./InMemoryStorage";

describe("InMemoryStorage", () => {
  runAdapterContract(() => new InMemoryStorage());

  it("has the driver name memory", () => {
    expect(new InMemoryStorage().driver).toBe("memory");
  });

  it("copies the body so later changes to the caller's buffer do not change the object", async () => {
    const storage = new InMemoryStorage();
    const data = Buffer.from("abc");
    await storage.put({ key: "a/copy.bin", body: data, contentType: "x/y" });
    data[0] = 0x7a;
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get("a/copy.bin")) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("abc");
  });

  it("offers test helpers: keys, contentTypeOf, clear", async () => {
    const storage = new InMemoryStorage();
    await storage.put({ key: "b/two.bin", body: Buffer.from("2"), contentType: "audio/wav" });
    await storage.put({ key: "a/one.bin", body: Buffer.from("1"), contentType: "audio/webm" });
    expect(storage.keys()).toEqual(["a/one.bin", "b/two.bin"]);
    expect(storage.contentTypeOf("a/one.bin")).toBe("audio/webm");
    storage.clear();
    expect(storage.keys()).toEqual([]);
  });
});
