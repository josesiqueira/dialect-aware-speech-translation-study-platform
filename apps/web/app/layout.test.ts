// The tab title of participant pages must not name the research focus
// (spec 6.1, 6.4): it comes from the participant-facing study title.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveStudy = vi.fn();

vi.mock("./globals.css", () => ({}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/server/context", () => ({ getServiceContext: () => ({ db: {} }) }));
vi.mock("@dialect/research", () => ({
  protocols: {
    resolveStudy: (...args: unknown[]) => resolveStudy(...args),
    participantTitleOf: (study: { settingsJson: { participantTitle?: string } | null }) =>
      study.settingsJson?.participantTitle?.trim() || "Research study",
  },
}));

import { metadata as adminMetadata } from "./admin/layout";
import * as rootLayout from "./layout";

const PRIMING = /dialect|murre|murte|regional|variet/i;

describe("root layout metadata", () => {
  beforeEach(() => {
    resolveStudy.mockReset();
  });

  it("uses the participant-facing title, not the internal study name, and has no description", async () => {
    resolveStudy.mockResolvedValue({
      name: "Dialect-Aware Speech Translation Study",
      settingsJson: { participantTitle: "Speech and translation study" },
    });
    const metadata = await rootLayout.generateMetadata();
    expect(metadata.title).toEqual({
      default: "Speech and translation study",
      template: "%s | Speech and translation study",
    });
    expect(metadata.description).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toMatch(PRIMING);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("falls back to a neutral title when no title is set or the study cannot be read", async () => {
    resolveStudy.mockResolvedValue({ name: "Dialect-Aware Speech Translation Study", settingsJson: {} });
    expect((await rootLayout.generateMetadata()).title).toMatchObject({ default: "Research study" });
    resolveStudy.mockImplementation(async () => {
      throw new Error("no database");
    });
    expect((await rootLayout.generateMetadata()).title).toMatchObject({ default: "Research study" });
  });

  it("has no static metadata that could name the research focus", () => {
    expect("metadata" in rootLayout).toBe(false);
  });
});

describe("admin layout metadata", () => {
  it("uses a neutral internal title", () => {
    expect(adminMetadata.title).toEqual({ default: "Research Dashboard", template: "%s | Research Dashboard" });
  });
});
