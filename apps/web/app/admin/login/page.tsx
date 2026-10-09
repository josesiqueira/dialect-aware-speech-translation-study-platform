import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminLoginState, safeAdminNextPath } from "@/lib/server/admin-auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Admin login. Outside the (shell) route group, so there is no sidebar.
 *
 * A visitor who is already signed in is sent on to the admin. That decision is
 * made here with the full session check (getAdminLoginState), the same check
 * the admin pages use, and not in proxy.ts, whose check is weaker: a cookie
 * issued before a sign-out in another browser passes the proxy and is refused
 * by the pages, which once caused a redirect loop between the two.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { session, rejectedCookie } = await getAdminLoginState();
  if (session) {
    const { next } = await searchParams;
    redirect(safeAdminNextPath(Array.isArray(next) ? next[0] : next));
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <LoginForm clearRejectedCookie={rejectedCookie} />
    </main>
  );
}
