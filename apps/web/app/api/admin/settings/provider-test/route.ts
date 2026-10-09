// POST /api/admin/settings/provider-test (spec 59, 113): the explicit provider
// connectivity test. It lists models, which checks the network path and the API
// key and generates no model output. Health checks never call the provider.
import { createOpenAIClient } from "@dialect/ai";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { getEnv } from "@/lib/server/env";

const TEST_TIMEOUT_MS = 15_000;

export const POST = apiRoute(
  async (_request, { ctx }) => {
    const study = await corpus.resolveStudy(ctx.db);
    const apiKey = getEnv().OPENAI_API_KEY;
    // The key stays in this server process. Without a key nothing is called.
    const client = apiKey ? createOpenAIClient(apiKey, { timeoutMs: TEST_TIMEOUT_MS }) : null;
    return jsonOk(await corpus.testProviderConnectivity(ctx, study.id, { client }));
  },
  { auth: "admin", route: "/api/admin/settings/provider-test" },
);
