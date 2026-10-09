import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/server/admin-auth";
import { ScientificRelevance } from "./_components/ScientificRelevance";

export const metadata: Metadata = { title: "Scientific Relevance" };

export default async function Page() {
  await requireAdminPage();
  return <ScientificRelevance />;
}
