import type { Metadata } from "next";
import { isAppError } from "@dialect/domain";
import { processing } from "@dialect/research";
import { ErrorState, PageHeading } from "@/components/ui";
import { requireAdminPage } from "@/lib/server/admin-auth";
import { getServiceContext } from "@/lib/server/context";
import { ProcessingClient } from "./_components/ProcessingClient";
import type { BatchList, BatchOptions } from "./_components/types";

export const metadata: Metadata = { title: "Processing Runs" };

// Timestamps are shown in the admin time zone of the study settings. UTC is
// used, and named on the page, when the study does not set one.
const FALLBACK_TIME_ZONE = "UTC";

export default async function Page() {
  const session = await requireAdminPage();
  const ctx = getServiceContext(session.actorLabel);

  let options;
  try {
    options = await processing.getBatchOptions(ctx);
  } catch (error) {
    if (!isAppError(error) || !["NOT_FOUND", "CONFIGURATION_MISSING", "VALIDATION_ERROR"].includes(error.code)) throw error;
    return (
      <div className="space-y-6">
        <PageHeading title="Processing Runs" />
        <ErrorState title="Processing is not available yet" message={error.message} />
      </div>
    );
  }

  const list = await processing.listBatches(ctx, { studyId: options.studyId });
  // The client receives the same JSON shapes as the API returns (dates as ISO text).
  const initial = JSON.parse(JSON.stringify({ list, options })) as { list: BatchList; options: BatchOptions };

  return (
    <ProcessingClient
      initialList={initial.list}
      options={initial.options}
      timeZone={options.adminTimezone ?? FALLBACK_TIME_ZONE}
    />
  );
}
