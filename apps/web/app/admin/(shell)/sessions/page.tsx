import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingState } from "@/components/ui";
import { SessionsBrowser } from "./_components/SessionsBrowser";

export const metadata: Metadata = { title: "Sessions" };

// /admin/sessions: filters, the session list and the detail of the selected
// session. Filters, page and selection live in the URL, so
// /admin/sessions?session=<id> links to one session.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <SessionsBrowser />
    </Suspense>
  );
}
