// Vitest entry point for `pnpm test`. Two projects:
//
// - "ui": component, hook and formatting tests in jsdom with the React plugin
//   and Testing Library (setup in vitest.setup.ts).
// - "server": route handlers and lib/server helpers in the node environment.
//   Its settings live in vitest.server.config.ts, owned by the platform work package.
//
// Run one project with: pnpm exec vitest run --project ui
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tests that belong to the "server" project (keep in sync with vitest.server.config.ts).
const serverTests = ["lib/server/**", "app/api/**", "proxy.test.ts", "lib/client/api.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: {
          alias: {
            "@": path.resolve(import.meta.dirname),
          },
        },
        test: {
          name: "ui",
          environment: "jsdom",
          globals: false,
          setupFiles: ["./vitest.setup.ts"],
          include: ["**/*.test.{ts,tsx}"],
          exclude: ["node_modules/**", ".next/**", "e2e/**", ...serverTests],
          css: false,
        },
      },
      {
        extends: "./vitest.server.config.ts",
        test: { name: "server" },
      },
    ],
  },
});
