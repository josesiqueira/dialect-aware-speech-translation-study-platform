import type { Metadata } from "next";
import { isAppError } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { ErrorState, PageHeading } from "@/components/ui";
import { requireAdminPage } from "@/lib/server/admin-auth";
import { getServiceContext } from "@/lib/server/context";
import { StudyFlowClient } from "./_components/StudyFlowClient";
import type { Overview, ProtocolDetail } from "./_components/types";

export const metadata: Metadata = { title: "Study Flow" };

// Timestamps are shown in the admin time zone of the study settings. UTC is
// used, and named on the page, when the study does not set one.
const FALLBACK_TIME_ZONE = "UTC";

/** Study Flow (spec 47 to 49): protocol versions, the draft editor, the publish review. */
export default async function Page() {
  const session = await requireAdminPage();
  const ctx = getServiceContext(session.actorLabel);

  let study;
  try {
    study = await protocols.resolveStudy(ctx.db);
  } catch (error) {
    if (!isAppError(error) || error.code !== "CONFIGURATION_MISSING") throw error;
    return (
      <div className="space-y-6">
        <PageHeading title="Study Flow" />
        <ErrorState title="No study exists yet" message={error.message} />
      </div>
    );
  }

  const [versions, options] = await Promise.all([
    protocols.listProtocolVersions(ctx, study.id),
    protocols.listProtocolOptions(ctx, study.id),
  ]);
  const draftId = versions.find((version) => version.status === "draft")?.id ?? null;
  // Open on the draft when there is one, because that is what can be edited.
  const firstId = draftId ?? study.currentProtocolVersionId ?? versions[0]?.id ?? null;
  const detail = firstId ? await protocols.getProtocolVersion(ctx, firstId) : null;

  // The client receives the same JSON shapes as the API returns (dates as ISO text).
  const initial = JSON.parse(
    JSON.stringify({
      overview: {
        studyId: study.id,
        currentProtocolVersionId: study.currentProtocolVersionId,
        draftProtocolVersionId: draftId,
        protocols: versions,
        options,
      },
      detail,
    }),
  ) as { overview: Overview; detail: ProtocolDetail | null };

  return (
    <StudyFlowClient
      initialOverview={initial.overview}
      initialDetail={initial.detail}
      timeZone={study.settingsJson.adminTimezone ?? FALLBACK_TIME_ZONE}
    />
  );
}
