import type { Metadata } from "next";
import { DashboardView } from "./_components/DashboardView";

export const metadata: Metadata = { title: "Dashboard" };

// /admin: operational study health (spec 42). The data comes from GET /api/admin/dashboard.
export default function Page() {
  return <DashboardView />;
}
