// GET  /api/admin/export/jobs   recent export jobs, newest first
// POST /api/admin/export/jobs   create an export job (the worker builds the archive)
//
// A session package (exportType "session_package", exactly one id in
// filters.sessionIds) is the exception: it is small, so it is built during the
// request and the response already holds the completed job. The archive is then
// downloaded like any other export, with GET /api/admin/export/jobs/:id/download.
import { exportSchemas } from "@dialect/domain";
import { exports as dataExports, getWorkerStatus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody, parseQuery } from "@/lib/server/api";

// A worker counts as running when it sent a heartbeat within this time.
const WORKER_STALE_AFTER_MS = 60_000;

export const GET = apiRoute(
  async (request, { ctx }) => {
    const query = parseQuery(request, exportSchemas.listExportJobsQuery);
    const [list, worker] = await Promise.all([
      dataExports.listExportJobs(ctx, query),
      getWorkerStatus(ctx.db, { now: ctx.now(), staleAfterMs: WORKER_STALE_AFTER_MS }),
    ]);
    const body: exportSchemas.ExportJobListResponse = {
      items: list.items.map(dataExports.toExportJobView),
      total: list.total,
      workerHealthy: worker.healthy,
    };
    return jsonOk(body);
  },
  { auth: "admin", route: "/api/admin/export/jobs" },
);

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, exportSchemas.createExportJobBody);
    if (body.exportType === "session_package") {
      const built = await dataExports.buildSessionPackageForRequest(ctx, body);
      return jsonOk({ job: dataExports.toExportJobView(built) });
    }
    const created = await dataExports.createExportJob(ctx, body);
    return jsonOk({ job: dataExports.toExportJobView({ ...created, archive: null }) });
  },
  { auth: "admin", route: "/api/admin/export/jobs" },
);
