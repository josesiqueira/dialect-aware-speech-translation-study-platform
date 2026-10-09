import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Browser tab title of the admin area: an internal, neutral name. It does not
 * use the study name, so a participant who glimpses a researcher's screen or a
 * shared laptop's tab list reads nothing about the research focus.
 */
export const metadata: Metadata = {
  title: { default: "Research Dashboard", template: "%s | Research Dashboard" },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
