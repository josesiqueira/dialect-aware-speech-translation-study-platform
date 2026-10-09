// GET  /api/admin/protocols   all protocol versions of the study, newest first, with
//                             what a draft may select (published consent and questionnaire versions).
// POST /api/admin/protocols   create an empty draft. Body: { name }.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const GET = apiRoute(
  async (_request, { ctx }) => {
    const study = await protocols.resolveStudy(ctx.db);
    const [versions, options] = await Promise.all([
      protocols.listProtocolVersions(ctx, study.id),
      protocols.listProtocolOptions(ctx, study.id),
    ]);
    return jsonOk({
      studyId: study.id,
      currentProtocolVersionId: study.currentProtocolVersionId,
      draftProtocolVersionId: versions.find((version) => version.status === "draft")?.id ?? null,
      protocols: versions,
      options,
    });
  },
  { auth: "admin" },
);

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, protocolSchemas.createProtocolDraftSchema);
    const study = await protocols.resolveStudy(ctx.db);
    return jsonOk(await protocols.createProtocolDraft(ctx, { studyId: study.id, name: body.name }));
  },
  { auth: "admin" },
);
