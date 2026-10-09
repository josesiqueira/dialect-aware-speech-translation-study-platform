import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isAppError } from "@dialect/domain";
import { demo } from "@dialect/research";
import { ModeBanner, ParticipantCard, ParticipantHeading, ParticipantShell } from "@/components/participant";
import { getAdminSession } from "@/lib/server/admin-auth";
import { getServiceContext } from "@/lib/server/context";
import { DemoClient } from "./_components/DemoClient";
import { DEMO_STRINGS } from "./_components/strings";

export const metadata: Metadata = { title: DEMO_STRINGS.pageTitle };
export const dynamic = "force-dynamic";

/**
 * Demo Mode (spec 3.2, 80, 81): record Finnish, see the ASR transcript and two
 * translations side by side, and play the synthesized audio of each. A seminar
 * and operator tool. It is a separate code path from the study, all its data
 * has the mode `demo`, and nothing of it enters research data (docs/DEMO-MODE.md).
 *
 * Access: a signed-in researcher always, anyone when the study setting
 * demoPublic is true. `?provider=mock` preselects the mock provider option,
 * which only a researcher can use and only where the mock provider is allowed.
 */
export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await getAdminSession();
  const ctx = getServiceContext(admin?.actorLabel ?? null);

  let access;
  try {
    access = await demo.getDemoAccess(ctx, { isAdmin: admin !== null });
  } catch (error) {
    if (!isAppError(error) || error.code !== "CONFIGURATION_MISSING") throw error;
    return (
      <ParticipantShell width="md" centered banner={<ModeBanner mode="DEMO">{DEMO_STRINGS.bannerText}</ModeBanner>}>
        <ParticipantCard padding="lg">
          <ParticipantHeading title={DEMO_STRINGS.pageTitle} />
          <p className="text-center text-slate-700">{error.message}</p>
        </ParticipantCard>
      </ParticipantShell>
    );
  }
  if (!access.demoPublic && !admin) redirect("/admin/login?next=/demo");

  const requested = (await searchParams).provider;
  const initialProvider = requested === "mock" && access.mockAvailable ? "mock" : "active";

  return <DemoClient access={access} isAdmin={admin !== null} initialProvider={initialProvider} />;
}
