// Runs once when a Next.js server instance starts, before it handles requests.
// It validates the environment so that a missing or invalid variable is reported
// at startup with a readable message (variable names and reasons, never values).
//
// In production an invalid configuration ends the process with exit code 1
// (lib/server/startup.ts). In development the message is printed and the server
// keeps running: the server log names the variables (GET /api/health/ready only
// says that the configuration check failed).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A build (for example of a container image) runs without the runtime secrets.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { checkConfigurationAtStartup } = await import("./lib/server/startup");
  checkConfigurationAtStartup();
}
