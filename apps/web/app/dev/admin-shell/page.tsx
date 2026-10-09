import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminPlaceholder, AdminShell } from "@/components/admin";

export const metadata: Metadata = { title: "Admin shell preview" };

/**
 * Developer page: the admin shell without authentication, for visual review
 * and screenshots. It shows no data. Not available in production.
 */
export default function AdminShellPreviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return (
    <AdminShell previewPathname="/admin">
      <AdminPlaceholder title="Dashboard" description="Study overview and recent activity." />
    </AdminShell>
  );
}
