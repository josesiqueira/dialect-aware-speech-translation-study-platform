import type { Metadata } from "next";
import { isAppError } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { ErrorState, PageHeading } from "@/components/ui";
import { requireAdminPage } from "@/lib/server/admin-auth";
import { getServiceContext } from "@/lib/server/context";
import { ConsentClient } from "../_components/ConsentClient";
import type { ConsentVersion } from "../_components/types";

export const metadata: Metadata = { title: "Consent versions" };

const FALLBACK_TIME_ZONE = "UTC";

/** Consent versions (spec 6.2, 76): a sub-view of Study Flow. */
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
        <PageHeading title="Consent versions" />
        <ErrorState title="No study exists yet" message={error.message} />
      </div>
    );
  }

  const consents = await protocols.listConsentVersions(ctx, study.id);
  // The client receives the same JSON shapes as the API returns (dates as ISO text).
  const initial = JSON.parse(JSON.stringify(consents)) as ConsentVersion[];
  return <ConsentClient initialConsents={initial} timeZone={study.settingsJson.adminTimezone ?? FALLBACK_TIME_ZONE} />;
}
