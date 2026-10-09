import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin";
import { requireAdminPage } from "@/lib/server/admin-auth";

/**
 * Layout for every admin page except /admin/login, which sits outside this
 * route group and therefore has no sidebar.
 */
export default async function AdminShellLayout({ children }: { children: ReactNode }) {
  // Second check after proxy.ts: redirects to the login page without a valid session.
  await requireAdminPage();
  return <AdminShell>{children}</AdminShell>;
}
