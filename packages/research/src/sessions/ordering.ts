// Task order for one session (spec 8). Pure functions: the same seed and the
// same protocol always give the same order. The result is stored in
// task_presentations when the participant acknowledges the instructions, and the
// stored sequence is the only thing used afterwards.
import { createHash } from "node:crypto";
import type { ProtocolOrderConfig, RandomizationMetadata } from "@dialect/db";
import type { OrderMode } from "@dialect/domain";

// Fisher-Yates shuffle driven by the mulberry32 generator. The generator state is
// the first 32 bits of SHA-256("<order seed>:<block key>").
export const SHUFFLE_ALGORITHM = "fisher_yates_mulberry32_sha256_v1";
export const FIXED_ALGORITHM = "fixed_order_v1";

export type OrderableTask = {
  id: string;
  blockKey: string;
  orderIndex: number;
  orderMode: OrderMode;
  // False keeps the task at its own position inside a shuffled block.
  randomizationEligible?: boolean;
};

export type SequencedTask<T extends OrderableTask> = {
  task: T;
  sequenceIndex: number;
  metadata: RandomizationMetadata;
};

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function blockSeed(orderSeed: string, blockKey: string): number {
  return createHash("sha256").update(`${orderSeed}:${blockKey}`, "utf8").digest().readUInt32BE(0);
}

export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = result[i] as T;
    result[i] = result[j] as T;
    result[j] = a;
  }
  return result;
}

function byOrderIndex<T extends OrderableTask>(a: T, b: T): number {
  return a.orderIndex - b.orderIndex || a.id.localeCompare(b.id);
}

// Blocks come in the order of order_config_json. A block that the configuration
// does not list (it should not happen for a published protocol) is placed after
// the listed ones, by the smallest order_index of its tasks, with the order mode
// of its first task.
export function buildTaskSequence<T extends OrderableTask>(
  tasks: readonly T[],
  orderConfig: ProtocolOrderConfig | null | undefined,
  orderSeed: string,
): SequencedTask<T>[] {
  const byBlock = new Map<string, T[]>();
  for (const task of tasks) {
    const list = byBlock.get(task.blockKey) ?? [];
    list.push(task);
    byBlock.set(task.blockKey, list);
  }
  for (const list of byBlock.values()) list.sort(byOrderIndex);

  const blocks: Array<{ key: string; orderMode: OrderMode }> = [];
  for (const block of orderConfig?.blocks ?? []) {
    if (byBlock.has(block.key) && !blocks.some((existing) => existing.key === block.key)) {
      blocks.push({ key: block.key, orderMode: block.orderMode });
    }
  }
  const unlisted = [...byBlock.entries()]
    .filter(([key]) => !blocks.some((block) => block.key === key))
    .sort(([, a], [, b]) => byOrderIndex(a[0] as T, b[0] as T));
  for (const [key, list] of unlisted) {
    blocks.push({ key, orderMode: (list[0] as T).orderMode });
  }

  const sequence: SequencedTask<T>[] = [];
  for (const block of blocks) {
    const inOrder = byBlock.get(block.key) ?? [];
    let ordered = inOrder;
    if (block.orderMode === "shuffle_within_block") {
      const eligible = inOrder.filter((task) => task.randomizationEligible !== false);
      const shuffled = seededShuffle(eligible, mulberry32(blockSeed(orderSeed, block.key)));
      let next = 0;
      ordered = inOrder.map((task) =>
        task.randomizationEligible === false ? task : (shuffled[next++] as T),
      );
    }
    ordered.forEach((task, indexInBlock) => {
      sequence.push({
        task,
        sequenceIndex: sequence.length,
        metadata: {
          seed: orderSeed,
          algorithm: block.orderMode === "shuffle_within_block" ? SHUFFLE_ALGORITHM : FIXED_ALGORITHM,
          blockKey: block.key,
          orderMode: block.orderMode,
          indexInBlock,
          protocolOrderIndex: task.orderIndex,
        },
      });
    });
  }
  return sequence;
}
