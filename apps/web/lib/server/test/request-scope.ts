// Test replacement for the request-bound APIs of next/headers. Route handler tests
// call the handler function directly, outside a Next.js request, so cookies() and
// headers() are replaced by this in-memory version (see setup.ts).
export type CookieOptions = {
  httpOnly?: boolean;
  sameSite?: "strict" | "lax" | "none" | boolean;
  secure?: boolean;
  path?: string;
  maxAge?: number;
  expires?: Date;
};

export type CookieWrite = { name: string; value: string; options: CookieOptions };

class FakeCookieStore {
  private values = new Map<string, string>();
  // Every set() call in order, with the options that would become Set-Cookie attributes.
  writes: CookieWrite[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.values.get(name);
    return value === undefined ? undefined : { name, value };
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  set(name: string, value: string, options: CookieOptions = {}): void {
    this.writes.push({ name, value, options });
    // Like a browser: an empty value with maxAge 0 removes the cookie.
    if (options.maxAge === 0 || value === "") this.values.delete(name);
    else this.values.set(name, value);
  }

  delete(name: string): void {
    this.writes.push({ name, value: "", options: { maxAge: 0 } });
    this.values.delete(name);
  }

  // Test control: what the browser would send with the next request.
  setRequestCookie(name: string, value: string): void {
    this.values.set(name, value);
  }

  lastWrite(name: string): CookieWrite | undefined {
    return [...this.writes].reverse().find((write) => write.name === name);
  }

  reset(): void {
    this.values.clear();
    this.writes = [];
  }
}

export const fakeCookies = new FakeCookieStore();
export const fakeHeaders = new Headers();

export class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect to ${url}`);
    this.name = "RedirectSignal";
  }
}

export function resetRequestScope(): void {
  fakeCookies.reset();
  for (const key of [...fakeHeaders.keys()]) fakeHeaders.delete(key);
}
