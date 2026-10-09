import type { Metadata } from "next";
import { SettingsView } from "./_components/SettingsView";

export const metadata: Metadata = { title: "Settings" };

// /admin/settings: operational study state, limits and technical status (spec 59).
// Scientific content (protocol, prompts, questionnaires) is edited on its own pages.
export default function Page() {
  return <SettingsView />;
}
