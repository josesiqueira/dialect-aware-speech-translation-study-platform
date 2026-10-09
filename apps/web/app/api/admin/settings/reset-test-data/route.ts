// POST /api/admin/settings/reset-test-data (spec 38, 116).
// Body: { modes: ["demo", "test"], confirmationPhrase }. Deletes DEMO and TEST
// data only. Refused in production unless ALLOW_TEST_DATA_RESET=true.
// There is no route that resets research data.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { getEnv } from "@/lib/server/env";
import { testDataResetAllowedInProduction } from "../_lib/runtime";

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, corpusSchemas.resetTestDataBodySchema);
    const study = await corpus.resolveStudy(ctx.db);
    return jsonOk(
      await corpus.resetTestData(ctx, {
        studyId: study.id,
        modes: body.modes,
        confirmationPhrase: body.confirmationPhrase,
        isProduction: getEnv().isProduction,
        allowInProduction: testDataResetAllowedInProduction(),
      }),
    );
  },
  { auth: "admin", route: "/api/admin/settings/reset-test-data" },
);
