import { describe, expect, it } from "vitest";
import { buildTaskSequence, FIXED_ALGORITHM, SHUFFLE_ALGORITHM, type OrderableTask } from "./ordering";

const task = (id: string, blockKey: string, orderIndex: number, extra: Partial<OrderableTask> = {}): OrderableTask => ({
  id,
  blockKey,
  orderIndex,
  orderMode: "fixed",
  ...extra,
});

const TASKS: OrderableTask[] = [
  task("c1", "controlled", 0),
  task("c2", "controlled", 1),
  task("c3", "controlled", 2),
  task("c4", "controlled", 3),
  task("c5", "controlled", 4),
  task("s1", "semi", 5),
  task("s2", "semi", 6),
  task("f1", "free", 7),
];

const CONFIG = {
  blocks: [
    { key: "controlled", orderMode: "shuffle_within_block" as const },
    { key: "semi", orderMode: "fixed" as const },
    { key: "free", orderMode: "fixed" as const },
  ],
};

const ids = (seed: string, tasks = TASKS, config = CONFIG) =>
  buildTaskSequence(tasks, config, seed).map((entry) => entry.task.id);

describe("buildTaskSequence", () => {
  it("gives the same order for the same seed, every time", () => {
    for (const seed of ["seed-a", "seed-b", "0123456789abcdef"]) {
      expect(ids(seed)).toEqual(ids(seed));
    }
  });

  it("keeps the block order and the order inside fixed blocks, and shuffles only inside the shuffled block", () => {
    const orders = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const order = ids(`seed-${i}`);
      expect(order.slice(0, 5).sort()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
      expect(order.slice(5)).toEqual(["s1", "s2", "f1"]);
      orders.add(order.slice(0, 5).join(","));
    }
    // 40 seeds over 120 possible orders: several different orders must appear.
    expect(orders.size).toBeGreaterThan(5);
  });

  it("gives a known order for a known seed, so a change of the algorithm is noticed", () => {
    expect(ids("reference-seed")).toMatchInlineSnapshot(`
      [
        "c5",
        "c3",
        "c4",
        "c1",
        "c2",
        "s1",
        "s2",
        "f1",
      ]
    `);
  });

  it("records the seed, the algorithm, the block and both positions", () => {
    const sequence = buildTaskSequence(TASKS, CONFIG, "seed-x");
    expect(sequence.map((entry) => entry.sequenceIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const first = sequence[0]!;
    expect(first.metadata).toEqual({
      seed: "seed-x",
      algorithm: SHUFFLE_ALGORITHM,
      blockKey: "controlled",
      orderMode: "shuffle_within_block",
      indexInBlock: 0,
      protocolOrderIndex: first.task.orderIndex,
    });
    expect(sequence[6]!.metadata).toMatchObject({
      algorithm: FIXED_ALGORITHM,
      blockKey: "semi",
      orderMode: "fixed",
      indexInBlock: 1,
      protocolOrderIndex: 6,
    });
  });

  it("uses a different shuffle per block for the same seed", () => {
    const tasks = [
      ...["a1", "a2", "a3", "a4", "a5", "a6"].map((id, index) => task(id, "a", index)),
      ...["b1", "b2", "b3", "b4", "b5", "b6"].map((id, index) => task(id, "b", index + 6)),
    ];
    const config = {
      blocks: [
        { key: "a", orderMode: "shuffle_within_block" as const },
        { key: "b", orderMode: "shuffle_within_block" as const },
      ],
    };
    let different = 0;
    for (let i = 0; i < 20; i += 1) {
      const order = ids(`seed-${i}`, tasks, config);
      const a = order.slice(0, 6).map((id) => id.slice(1));
      const b = order.slice(6).map((id) => id.slice(1));
      if (a.join() !== b.join()) different += 1;
    }
    expect(different).toBeGreaterThan(15);
  });

  it("keeps a task that is not eligible for randomization at its own position", () => {
    const tasks = TASKS.map((entry) => (entry.id === "c3" ? { ...entry, randomizationEligible: false } : entry));
    for (let i = 0; i < 20; i += 1) {
      expect(ids(`seed-${i}`, tasks)[2]).toBe("c3");
    }
  });

  it("falls back to the block keys and order_index when the configuration lists no blocks", () => {
    const tasks = [
      task("z1", "later", 5),
      task("y1", "first", 0, { orderMode: "fixed" }),
      task("y2", "first", 1),
      task("z2", "later", 4),
    ];
    expect(buildTaskSequence(tasks, { blocks: [] }, "seed").map((entry) => entry.task.id)).toEqual([
      "y1",
      "y2",
      "z2",
      "z1",
    ]);
    expect(buildTaskSequence(tasks, null, "seed").map((entry) => entry.task.id)).toEqual(["y1", "y2", "z2", "z1"]);
  });
});
