// GET /api/health (spec 113): the process is alive. No database, storage or provider call.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { status: "ok", version: process.env.APP_VERSION || "dev" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
