import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAppError, protocolSchemas } from "@dialect/domain";
import { protocols, sessions } from "@dialect/research";
import { availableLocales, resolveLocale } from "@/lib/i18n";
import { requireAdminPage } from "@/lib/server/admin-auth";
import { getServiceContext } from "@/lib/server/context";
import { PreviewFlow, type PreviewProtocol, type PreviewStudy } from "./_components/PreviewFlow";

export const metadata: Metadata = { title: "Preview participant study" };

/**
 * Participant preview of one protocol version, draft or published (spec 130).
 * It lives under /admin, so it needs an admin session, but outside the admin
 * shell, so it looks like the participant flow. It only reads the protocol
 * and the study settings: no session is created and nothing the researcher
 * enters is stored.
 */
export default async function Page({ params }: { params: Promise<{ protocolId: string }> }) {
  const session = await requireAdminPage();
  const { protocolId } = await params;
  if (!protocolSchemas.idParamsSchema.safeParse({ id: protocolId }).success) notFound();

  const ctx = getServiceContext(session.actorLabel);
  let detail;
  let study: PreviewStudy;
  try {
    detail = await protocols.getProtocolVersion(ctx, protocolId);
    // The same settings the participant pages use: study title, languages, recording limit.
    const row = await sessions.resolveStudy(ctx.db);
    const settings = sessions.effectiveSettings(row.settingsJson);
    const defaultLocale = resolveLocale(null, settings.participantLocales, settings.defaultLocale);
    const locales = availableLocales(settings.participantLocales);
    study = {
      // The participant-facing title, as on the welcome page. Never the internal study name.
      name: protocols.participantTitleOf(row),
      nameByLocale: Object.fromEntries(
        settings.participantLocales.map((locale) => [locale, protocols.participantTitleOf(row, locale)]),
      ),
      locales: locales.length > 0 ? locales : [defaultLocale],
      defaultLocale,
      maxUtteranceSeconds: settings.maxUtteranceSeconds,
      studyLaptopMode: settings.studyLaptopMode,
      englishCheckEnabled: settings.englishCheckEnabled,
    };
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  // Plain JSON for the client component (dates as ISO text).
  const protocol = JSON.parse(JSON.stringify(detail)) as PreviewProtocol;
  return <PreviewFlow protocol={protocol} study={study} />;
}
