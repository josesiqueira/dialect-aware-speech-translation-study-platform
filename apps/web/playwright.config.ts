// Playwright configuration for browser tests (apps/web/e2e).
//
// The tests run against an app that is already running. They do not start a
// server. Two ways to run them:
//
//   pnpm test:e2e            against the development server (E2E_BASE_URL,
//                            default http://localhost:3100). Runs the participant,
//                            recorder and demo specs only. The admin specs change
//                            global state (the current protocol, active model
//                            configurations, TEST data), so they never run here.
//   pnpm test:e2e:isolated   builds and starts the isolated stack of
//                            docker-compose.e2e.yml, sets E2E_ISOLATED=1 and runs
//                            everything, the admin specs included
//                            (scripts/e2e/run-isolated.mjs).
//
// Projects (isolated run):
//   setup     signs in once through the real login page and saves the storage
//             state (Playwright guide "Authentication", setup project).
//   admin     e2e/admin-*.spec.ts, in file name order, with that storage state.
//             The file order matters: the specs share one database, each file
//             leaves it usable for the next. admin-11 deletes the TEST and DEMO
//             data, admin-12 signs out, which ends the saved session.
//   chromium  participant, recorder and demo specs.
// The chromium project depends on nothing, so a failure in the admin specs does
// not skip it, and the other way round. With one worker Playwright 1.63 runs the
// projects without dependencies first (setup, chromium) and the admin project
// after them. The admin specs do not rely on that: they find the sample sessions
// by their start time and take every count from the admin API.
//
// Chromium only: it is the supported research browser (spec 136). The two
// launch arguments give the browser a built-in test microphone and accept the
// permission prompt, so recorder tests need no audio hardware.
import { defineConfig, devices } from "@playwright/test";
import { ADMIN_STORAGE_STATE, BASE_URL, ISOLATED, ISOLATED_OUTPUT_DIR } from "./e2e/support/env";

const chromiumWithTestMicrophone = {
  ...devices["Desktop Chrome"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
};

const ADMIN_SPECS = /admin-[^/]*\.spec\.ts$/;
const SETUP_FILES = /[^/]*\.setup\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  // The isolated run keeps its output apart, so that another Playwright run in
  // this checkout cannot empty it (e2e/support/env.ts).
  outputDir: ISOLATED ? ISOLATED_OUTPUT_DIR : "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    ...(ISOLATED
      ? [
          { name: "setup", testMatch: SETUP_FILES, use: chromiumWithTestMicrophone },
          {
            name: "admin",
            testMatch: ADMIN_SPECS,
            dependencies: ["setup"],
            use: { ...chromiumWithTestMicrophone, storageState: ADMIN_STORAGE_STATE },
          },
        ]
      : []),
    {
      name: "chromium",
      testIgnore: [ADMIN_SPECS, SETUP_FILES],
      use: chromiumWithTestMicrophone,
    },
  ],
});
