// Periodic housekeeping that is not a queued job: marking inactive participant
// sessions as abandoned (spec 108). Runs on a timer inside the worker process.
import { sessions, type ServiceContext } from "@dialect/research";

export const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export function startMaintenance(ctx: ServiceContext, signal: AbortSignal, intervalMs = MAINTENANCE_INTERVAL_MS): void {
  let running = false;
  const tick = async () => {
    if (running || signal.aborted) return;
    running = true;
    try {
      const abandoned = await sessions.markAbandonedSessions(ctx);
      if (abandoned > 0) ctx.logger.info({ abandoned }, "marked inactive sessions as abandoned");
    } catch (error) {
      ctx.logger.error({ error: error instanceof Error ? error.message : String(error) }, "maintenance failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  void tick();
}
