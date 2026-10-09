// One upload at a time per session (spec 67).
//
// An upload holds the recording in the memory of this process while it is read,
// validated and stored. Without a guard one session cookie could start many
// uploads at once and hold many recordings in memory.
//
// Why an in-process guard and not a PostgreSQL advisory lock: what is protected
// is the memory of this process, so the process is the right scope. An advisory
// lock would have to be held for the whole upload, which pins one pooled
// database connection per (possibly slow) upload, and a few slow uploads could
// then use up the pool for every other request. With several web replicas a
// session could run one upload per replica at the same time. That is bounded,
// and the data stay consistent either way: the service locks the session row
// (SELECT ... FOR UPDATE) and replaces the earlier candidate in one transaction.
import "server-only";
import { AppError } from "@dialect/domain";

const active = new Set<string>();

// Runs `work` unless an upload with the same key is running in this process.
// The second caller gets 409 CONFLICT at once, before its body is read.
export async function withSingleUpload<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (active.has(key)) {
    throw new AppError("CONFLICT", "Another upload of this session is still running. Wait until it has finished.", {
      reason: "upload_in_progress",
    });
  }
  active.add(key);
  try {
    return await work();
  } finally {
    active.delete(key);
  }
}

export function activeUploadCountForTests(): number {
  return active.size;
}
