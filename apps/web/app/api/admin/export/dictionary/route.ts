// GET /api/admin/export/dictionary?format=markdown|json&privacyTier=...
// The data dictionary, generated from the same column registry as the exports.
// Without a privacy tier it lists every field and the tiers that include it.
import { exportSchemas } from "@dialect/domain";
import { exports as dataExports } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request) => {
    const query = parseQuery(request, exportSchemas.dictionaryQuery);
    if (query.privacyTier) dataExports.assertSupportedPrivacyTier(query.privacyTier);
    const policy = query.privacyTier
      ? { privacyTier: query.privacyTier, includeResearcherNotes: query.includeResearcherNotes ?? false }
      : undefined;
    if (query.format === "json") return jsonOk({ fields: dataExports.dataDictionaryFields(policy) });
    return new Response(dataExports.renderDataDictionary(policy), {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="data_dictionary.md"',
      },
    });
  },
  { auth: "admin", route: "/api/admin/export/dictionary" },
);
