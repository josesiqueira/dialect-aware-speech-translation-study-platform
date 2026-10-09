import type { ComponentType } from "react";
import {
  IconActivity,
  IconBook,
  IconClipboard,
  IconCpu,
  IconDownload,
  IconEdit,
  IconGrid,
  IconList,
  IconSettings,
  IconUsers,
  type IconProps,
} from "@/components/ui/icons";

export interface AdminNavItem {
  href: string;
  label: string;
  Icon: ComponentType<IconProps>;
  /** Only the exact path is active. Used for the Dashboard at /admin. */
  exactMatch: boolean;
}

/** The admin sidebar (spec 40). There is no Users, Teams or Roles page. */
export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { href: "/admin", label: "Dashboard", Icon: IconGrid, exactMatch: true },
  { href: "/admin/scientific-relevance", label: "Scientific Relevance", Icon: IconBook, exactMatch: false },
  { href: "/admin/sessions", label: "Sessions", Icon: IconUsers, exactMatch: false },
  { href: "/admin/review", label: "Review & Transcription", Icon: IconEdit, exactMatch: false },
  { href: "/admin/study-flow", label: "Study Flow", Icon: IconList, exactMatch: false },
  { href: "/admin/ai-pipeline", label: "AI Pipeline", Icon: IconCpu, exactMatch: false },
  { href: "/admin/processing", label: "Processing Runs", Icon: IconActivity, exactMatch: false },
  { href: "/admin/questionnaires", label: "Questionnaires", Icon: IconClipboard, exactMatch: false },
  { href: "/admin/data", label: "Data & Export", Icon: IconDownload, exactMatch: false },
  { href: "/admin/settings", label: "Settings", Icon: IconSettings, exactMatch: false },
];

/**
 * Whether a navigation item is the current section. The Dashboard matches
 * only /admin. Every other item matches its own path and anything nested
 * under it (/admin/sessions/abc), compared by whole path segment, so
 * /admin/data does not light up for a hypothetical /admin/database.
 */
export function isNavItemActive(pathname: string, item: Pick<AdminNavItem, "href" | "exactMatch">): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (item.exactMatch) return path === item.href;
  return path === item.href || path.startsWith(`${item.href}/`);
}
