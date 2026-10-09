// Job handlers of the worker, keyed by job type.
//
// Each service area exports its own `jobHandlers` record. A job whose type has no
// handler fails permanently with a clear message, so nothing waits in the queue
// unnoticed.
import { exports as exportsArea, processing, sessions, type JobHandlerRegistry } from "@dialect/research";

export function buildHandlers(): JobHandlerRegistry {
  return { ...processing.jobHandlers, ...exportsArea.jobHandlers, ...sessions.jobHandlers };
}
