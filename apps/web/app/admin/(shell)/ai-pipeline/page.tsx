import type { Metadata } from "next";
import { SYNTHESIS_OUTPUT_FORMATS } from "@dialect/ai";
import { isAppError } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { ErrorState, PageHeading } from "@/components/ui";
import { requireAdminPage } from "@/lib/server/admin-auth";
import { getServiceContext } from "@/lib/server/context";
import { AiPipelineClient } from "./_components/AiPipelineClient";
import type { ModelConfig, PromptVersion } from "./_components/types";

export const metadata: Metadata = { title: "AI Pipeline" };

// Timestamps are shown in the admin time zone of the study settings. UTC is
// used, and named on the page, when the study does not set one.
const FALLBACK_TIME_ZONE = "UTC";

export default async function Page() {
  const session = await requireAdminPage();
  const ctx = getServiceContext(session.actorLabel);

  let study;
  try {
    study = await aiConfig.resolveStudy(ctx);
  } catch (error) {
    if (!isAppError(error) || error.code !== "CONFIGURATION_MISSING") throw error;
    return (
      <div className="space-y-6">
        <PageHeading title="AI Pipeline" />
        <ErrorState title="No study exists yet" message={error.message} />
      </div>
    );
  }

  const [prompts, configs] = await Promise.all([
    aiConfig.listPromptVersions(ctx, { studyId: study.id }),
    aiConfig.listModelConfigs(ctx, { studyId: study.id }),
  ]);
  // The client receives the same JSON shapes as the API returns (dates as ISO text).
  const initial = JSON.parse(JSON.stringify({ prompts, configs })) as {
    prompts: PromptVersion[];
    configs: ModelConfig[];
  };

  return (
    <AiPipelineClient
      initialPrompts={initial.prompts}
      initialConfigs={initial.configs}
      // Names and a yes or no per provider. The API key itself stays on the server (spec 26).
      initialProviders={aiConfig.listProviderStatus(ctx)}
      timeZone={study.settingsJson.adminTimezone ?? FALLBACK_TIME_ZONE}
      outputFormats={SYNTHESIS_OUTPUT_FORMATS}
    />
  );
}
