import type { Metadata } from "next";
import { QuestionnairesWorkspace } from "./_components/QuestionnairesWorkspace";

export const metadata: Metadata = { title: "Questionnaires" };

// Questionnaires admin (spec 55): versions by key, draft editor, preview, publish.
export default function Page() {
  return <QuestionnairesWorkspace />;
}
