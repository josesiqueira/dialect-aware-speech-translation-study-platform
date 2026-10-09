"use client";

/**
 * AdminNav: fixed left sidebar of the researcher interface.
 *
 * Kept from the reference AdminNav: w-56 (224px), slate-100 background, right
 * border, small uppercase branding block, neutral navigation states (the
 * active item is slate-200, never a colored accent), 16px outline icons,
 * Sign Out at the bottom.
 *
 * Changed: the routes; Sign Out ends the server session (secure cookie)
 * instead of clearing a password from sessionStorage.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/components/ui/cn";
import { IconSignOut } from "@/components/ui/icons";
import { ADMIN_NAV_ITEMS, isNavItemActive } from "./nav-items";

const focus =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1";

export interface AdminNavProps {
  /** Development previews only: mark this path as current instead of the real one. */
  previewPathname?: string;
}

export function AdminNav({ previewPathname }: AdminNavProps = {}) {
  const currentPathname = usePathname() ?? "";
  const pathname = previewPathname ?? currentPathname;
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // Even if the request fails, go to the login page: the server decides
      // whether the session is still valid.
    }
    // A full page load on purpose, not router.push: it drops every admin page
    // and response held in memory by the client router.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/admin/login");
  }

  return (
    <aside className="fixed left-0 top-0 z-10 flex h-screen w-sidebar flex-col border-r border-slate-200 bg-slate-100">
      {/* Branding block */}
      <div className="border-b border-slate-200 px-4 py-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-900">Dialect Translation</p>
        <p className="mt-0.5 text-xs text-slate-600">Research Dashboard</p>
      </div>

      {/* Primary navigation */}
      <nav aria-label="Admin" className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {ADMIN_NAV_ITEMS.map((item) => {
          const active = isNavItemActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                focus,
                active ? "bg-slate-200 text-slate-900" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
              )}
            >
              <item.Icon className={active ? "text-slate-900" : "text-slate-400"} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer: sign out */}
      <div className="border-t border-slate-200 px-2 py-3">
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition-colors",
            "hover:bg-slate-200 hover:text-slate-900 active:bg-slate-300 disabled:opacity-60",
            focus,
          )}
        >
          <IconSignOut className="text-slate-400" />
          {signingOut ? "Signing out..." : "Sign Out"}
        </button>
      </div>
    </aside>
  );
}
