import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { getServiceContext } from "@/lib/server/context";
import "./globals.css";

// Shown when the study has no participant-facing title, or when it cannot be read.
const NEUTRAL_TITLE = protocolSchemas.NEUTRAL_PARTICIPANT_TITLE;

/**
 * The browser tab title of the participant pages is the participant-facing
 * study title from the study settings (Settings page), never the internal study
 * name. A participant sees the tab title before speaking, so it must not name
 * the research focus (spec 6.1, 6.4). For the same reason there is no page
 * description. The admin area sets its own title in app/admin/layout.tsx.
 */
export async function generateMetadata(): Promise<Metadata> {
  let title: string = NEUTRAL_TITLE;
  try {
    const ctx = getServiceContext();
    title = protocols.participantTitleOf(await protocols.resolveStudy(ctx.db));
  } catch {
    // No study yet, or the database is not reachable: the neutral title is used.
  }
  return {
    title: { default: title, template: `%s | ${title}` },
    // Research pages are not for search engines, and automatic page translation
    // would alter the study texts that participants read.
    robots: { index: false, follow: false },
    other: { google: "notranslate" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
};

/**
 * Root layout. System font stacks only (design-system/tokens.css): no web
 * font is loaded. Light theme only.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request. The Content Security Policy uses a
  // per-request nonce (proxy.ts), which a statically prerendered page cannot carry.
  await connection();
  // suppressHydrationWarning: browser extensions add attributes to <html> before
  // React loads (for example data-bry-content-script-bryweb). It applies to the
  // attributes of this one element only, not to its children.
  return (
    <html lang="en" translate="no" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full font-sans notranslate">{children}</body>
    </html>
  );
}
