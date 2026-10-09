// Vitest configuration for server code: route handlers and lib/server helpers,
// run in the node environment. Component tests use vitest.config.ts (jsdom).
// Run with: pnpm exec vitest run --config vitest.server.config.ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.join(import.meta.dirname, "lib/server/test/server-only-stub.ts"),
      "@": import.meta.dirname,
    },
  },
  test: {
    environment: "node",
    include: ["lib/server/**/*.test.ts", "app/api/**/*.test.ts", "proxy.test.ts", "lib/client/api.test.ts"],
    setupFiles: ["lib/server/test/setup.ts"],
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
