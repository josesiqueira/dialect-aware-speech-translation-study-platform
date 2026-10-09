import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminNav } from "./AdminNav";
import { ADMIN_NAV_ITEMS, isNavItemActive } from "./nav-items";

const pathname = vi.hoisted(() => ({ current: "/admin" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

function activeLabels(): string[] {
  return screen
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent ?? "");
}

describe("AdminNav", () => {
  beforeEach(() => {
    pathname.current = "/admin";
  });

  it("lists the ten study routes in order, with Sign Out as a button", () => {
    render(<AdminNav />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Dashboard",
      "Scientific Relevance",
      "Sessions",
      "Review & Transcription",
      "Study Flow",
      "AI Pipeline",
      "Processing Runs",
      "Questionnaires",
      "Data & Export",
      "Settings",
    ]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(ADMIN_NAV_ITEMS.map((i) => i.href));
    expect(screen.getByRole("button", { name: "Sign Out" })).toBeEnabled();
    expect(screen.getByRole("navigation", { name: "Admin" })).toBeInTheDocument();
  });

  it("marks only Dashboard on /admin", () => {
    render(<AdminNav />);
    expect(activeLabels()).toEqual(["Dashboard"]);
  });

  it("marks the section for a nested route and not the Dashboard", () => {
    pathname.current = "/admin/sessions/0f3a9c1e/utterances/2";
    render(<AdminNav />);
    expect(activeLabels()).toEqual(["Sessions"]);
  });

  it("uses the neutral active style", () => {
    pathname.current = "/admin/study-flow/versions/3";
    render(<AdminNav />);
    const active = screen.getByRole("link", { name: "Study Flow" });
    expect(active.className).toContain("bg-slate-200");
    expect(active.className).toContain("text-slate-900");
    expect(screen.getByRole("link", { name: "Dashboard" }).className).toContain("text-slate-600");
  });
});

describe("isNavItemActive", () => {
  const data = { href: "/admin/data", exactMatch: false };
  const dashboard = { href: "/admin", exactMatch: true };

  it("matches whole path segments only", () => {
    expect(isNavItemActive("/admin/data", data)).toBe(true);
    expect(isNavItemActive("/admin/data/", data)).toBe(true);
    expect(isNavItemActive("/admin/data/exports/12", data)).toBe(true);
    expect(isNavItemActive("/admin/database", data)).toBe(false);
    expect(isNavItemActive("/admin", data)).toBe(false);
  });

  it("matches the Dashboard exactly", () => {
    expect(isNavItemActive("/admin", dashboard)).toBe(true);
    expect(isNavItemActive("/admin/", dashboard)).toBe(true);
    expect(isNavItemActive("/admin/settings", dashboard)).toBe(false);
  });
});
