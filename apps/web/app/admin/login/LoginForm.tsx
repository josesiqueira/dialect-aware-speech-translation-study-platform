"use client";

/**
 * LoginForm: the same visual treatment as the reference AdminAuth (centered
 * white card, max-w-sm, password field, dark slate button, inline red alert).
 *
 * What changed for security: the password is sent once to POST /api/admin/login,
 * which sets an HTTP-only session cookie. Nothing is kept in sessionStorage,
 * and a network failure never counts as a successful login.
 *
 * What changed for accessibility (recorded in docs/UI-LINEAGE.md): the
 * password field has a visible label instead of a placeholder, a failed
 * sign-in marks the field as invalid and points it at the message, and
 * keyboard focus returns to the field.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, FormField, InlineMessage, TextInput } from "@/components/ui";

const ERROR_ID = "admin-password-error";

/**
 * Only same-origin admin paths, and the Demo Mode page "/demo" (with a query
 * string), are accepted as a destination after login. The same rule is in
 * safeAdminNextPath (lib/server/admin-session.ts).
 */
export function safeNextPath(search: string): string {
  const next = new URLSearchParams(search).get("next");
  if (!next) return "/admin";
  // "//host" and "/\\host" are treated by browsers as another origin.
  if (next.includes("//") || next.includes("\\")) return "/admin";
  if (next === "/demo" || next.startsWith("/demo?")) return next;
  const isAdminPath = next === "/admin" || next.startsWith("/admin/") || next.startsWith("/admin?");
  if (!isAdminPath) return "/admin";
  if (next.startsWith("/admin/login")) return "/admin";
  return next;
}

type LoginFormProps = {
  /**
   * True when the browser still holds a session cookie that the server refuses
   * (for example after a sign-out in another browser). The form then asks the
   * server once to remove that cookie. The request cannot end a valid session.
   */
  clearRejectedCookie?: boolean;
};

export function LoginForm({ clearRejectedCookie = false }: LoginFormProps) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The field is disabled while the request runs, which drops keyboard focus.
  // After a failure, focus goes back to the field so the password can be corrected.
  useEffect(() => {
    if (error && !submitting) inputRef.current?.focus();
  }, [error, submitting]);

  useEffect(() => {
    if (!clearRejectedCookie) return;
    // Nothing depends on the answer: a new sign-in replaces the cookie anyway.
    void fetch("/api/admin/logout?rejected-cookie-only=1", { method: "POST", credentials: "same-origin" }).catch(
      () => undefined,
    );
  }, [clearRejectedCookie]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        // Full page load so the server renders the admin with the new cookie.
        window.location.assign(safeNextPath(window.location.search));
        return;
      }
      if (response.status === 401) {
        setError("Incorrect password");
      } else if (response.status === 429) {
        setError("Too many attempts. Wait a moment and try again.");
      } else {
        setError("Sign in failed. Try again.");
      }
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    }
    setSubmitting(false);
  }

  return (
    <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-900">Dialect Translation</p>
      <h1 className="mt-2 mb-1 text-lg font-semibold text-slate-900">Research Dashboard</h1>
      <p className="mb-6 text-sm text-slate-500">Enter admin password to continue</p>
      <form onSubmit={handleSubmit} noValidate>
        {error && (
          <InlineMessage variant="error" id={ERROR_ID} className="mb-3 px-3">
            {error}
          </InlineMessage>
        )}
        <FormField label="Password" id="admin-password">
          <TextInput
            ref={inputRef}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? ERROR_ID : undefined}
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError(null);
            }}
            autoFocus
            disabled={submitting}
          />
        </FormField>
        <Button type="submit" fullWidth className="mt-4" loading={submitting} loadingLabel="Signing in...">
          Sign In
        </Button>
      </form>
    </div>
  );
}
