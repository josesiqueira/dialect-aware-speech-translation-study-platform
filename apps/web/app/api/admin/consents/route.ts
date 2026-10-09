// GET  /api/admin/consents   all consent versions of the study, newest first.
// POST /api/admin/consents   create a consent draft. Body: { title, ... }.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const GET = apiRoute(
  async (_request, { ctx }) => {
    const study = await protocols.resolveStudy(ctx.db);
    return jsonOk({ studyId: study.id, consents: await protocols.listConsentVersions(ctx, study.id) });
  },
  { auth: "admin" },
);

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, protocolSchemas.createConsentDraftSchema);
    const study = await protocols.resolveStudy(ctx.db);
    return jsonOk(await protocols.createConsentDraft(ctx, { studyId: study.id, ...body }));
  },
  { auth: "admin" },
);
