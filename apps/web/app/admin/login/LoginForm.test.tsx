import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginForm, safeNextPath } from "./LoginForm";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safeNextPath", () => {
  it("accepts the Demo Mode page and its query string, and nothing else outside /admin", () => {
    expect(safeNextPath("?next=/demo")).toBe("/demo");
    expect(safeNextPath("?next=%2Fdemo%3Fcondition%3Dpreserve")).toBe("/demo?condition=preserve");
    for (const bad of [
      "/demo/other",
      "/demonstration",
      "/demo//example.org",
      "/demo?to=//example.org",
      "/demo%5Cexample.org",
      "//example.org/demo",
      "https://example.org/demo",
      "/study",
    ]) {
      expect(safeNextPath(`?next=${bad}`)).toBe("/admin");
    }
  });

  it("accepts only same-origin admin paths", () => {
    expect(safeNextPath("")).toBe("/admin");
    expect(safeNextPath("?next=/admin/sessions")).toBe("/admin/sessions");
    expect(safeNextPath("?next=%2Fadmin%2Fsessions%3Fmode%3Dtest")).toBe("/admin/sessions?mode=test");
    expect(safeNextPath("?next=https://example.org/admin")).toBe("/admin");
    expect(safeNextPath("?next=//example.org/admin")).toBe("/admin");
    expect(safeNextPath("?next=/admin//example.org")).toBe("/admin");
    expect(safeNextPath("?next=/administrator")).toBe("/admin");
    expect(safeNextPath("?next=/admin/login")).toBe("/admin");
    expect(safeNextPath("?next=/")).toBe("/admin");
  });
});

describe("LoginForm", () => {
  it("shows an inline alert for a wrong password and keeps the form usable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Wrong password" } }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect password");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/login",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ password: "wrong" }) }),
    );
    expect(screen.getByRole("button", { name: "Sign In" })).toBeEnabled();
  });

  it("asks the server once to remove a refused session cookie, and only when told to", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<LoginForm />);
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();

    render(<LoginForm clearRejectedCookie />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/logout?rejected-cookie-only=1",
      expect.objectContaining({ method: "POST" }),
    );
    // The form stays usable whatever the answer is.
    expect(screen.getByLabelText("Password")).toBeEnabled();
  });

  it("has a visible label and no placeholder standing in for it", () => {
    render(<LoginForm />);
    const label = screen.getByText("Password");
    expect(label.tagName).toBe("LABEL");
    expect(label).not.toHaveClass("sr-only");
    const input = screen.getByLabelText("Password");
    expect(input).not.toHaveAttribute("placeholder");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("after a failed sign-in marks the field invalid, points it at the message and returns focus to it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const user = userEvent.setup();
    render(<LoginForm />);

    const input = screen.getByLabelText("Password");
    await user.type(input, "wrong");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    const alert = await screen.findByRole("alert");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", alert.id);
    expect(input).toHaveAccessibleDescription(/Incorrect password/);
    await waitFor(() => expect(input).toHaveFocus());

    // Typing a new password clears the error state.
    await user.type(input, "x");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("explains rate limiting and network failure, and never treats them as success", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429 })));
    const { unmount } = render(<LoginForm />);
    await user.type(screen.getByLabelText("Password"), "x");
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<LoginForm />);
    await user.type(screen.getByLabelText("Password"), "x");
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
  });
});
