import type { ReactNode } from "react";
import { AdminNav } from "./AdminNav";

/**
 * AdminShell: fixed light-slate sidebar plus scrollable main content, the
 * layout of the reference admin (app/admin/layout.tsx there).
 *
 * main is offset by the sidebar width, slate-50, p-8, min-w-0 (so wide tables
 * scroll inside their own container instead of stretching the page).
 * Authentication is not done here: proxy.ts guards /admin on the server.
 */
export interface AdminShellProps {
  children: ReactNode;
  /** Development previews only: the path the sidebar marks as current. */
  previewPathname?: string;
}

export function AdminShell({ children, previewPathname }: AdminShellProps) {
  return (
    <div className="flex min-h-screen bg-slate-50 text-sm text-slate-700">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-30 focus:rounded-md focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2"
      >
        Skip to main content
      </a>
      <AdminNav previewPathname={previewPathname} />
      <main id="main-content" tabIndex={-1} className="ml-sidebar min-w-0 flex-1 p-8 focus:outline-none">
        {children}
      </main>
    </div>
  );
}
