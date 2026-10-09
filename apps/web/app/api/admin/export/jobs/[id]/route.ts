// GET /api/admin/export/jobs/:id   status of one export job
import { exportSchemas } from "@dialect/domain";
import { exports as dataExports } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const GET = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = exportSchemas.exportJobParams.parse(params);
    return jsonOk({ job: dataExports.toExportJobView(await dataExports.getExportJob(ctx, id)) });
  },
  { auth: "admin", route: "/api/admin/export/jobs/[id]" },
);
