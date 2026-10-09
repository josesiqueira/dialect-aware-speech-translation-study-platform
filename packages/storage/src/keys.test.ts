import { describe, expect, it } from "vitest";
import { assertValidObjectKey, exportArchiveKey, isUuid, sourceAudioKey, ttsAudioKey } from "./keys";
import { UNSAFE_KEYS } from "./testing/adapterContract";

const SESSION = "3f0e6c1a-58a4-4d3b-9c55-0f6a2f3b7c11";
const UTTERANCE = "9b2d7c44-1e0a-4f6e-8a3d-5c7e9f1b2a30";
const ASSET = "5d1c3e7a-2b4f-4a6c-9e8d-1f3a5b7c9d2e";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("sourceAudioKey", () => {
  it("builds the key from the study slug and UUIDs", () => {
    expect(
      sourceAudioKey({ studySlug: "dialect-study", sessionId: SESSION, utteranceId: UTTERANCE, assetId: ASSET, extension: "wav" }),
    ).toBe(`studies/dialect-study/sessions/${SESSION}/utterances/${UTTERANCE}/source/${ASSET}.wav`);
  });

  it("lowercases UUIDs and accepts an extension with a dot or in upper case", () => {
    expect(
      sourceAudioKey({
        studySlug: "dialect-study",
        sessionId: SESSION.toUpperCase(),
        utteranceId: UTTERANCE,
        assetId: ASSET,
        extension: ".WEBM",
      }),
    ).toBe(`studies/dialect-study/sessions/${SESSION}/utterances/${UTTERANCE}/source/${ASSET}.webm`);
  });

  it("rejects ids that are not UUIDs, such as participant codes or names", () => {
    const base = { studySlug: "dialect-study", sessionId: SESSION, utteranceId: UTTERANCE, assetId: ASSET, extension: "wav" };
    for (const bad of ["P-7K4M9Q", "Matti Meikalainen", "", "../x", `${SESSION}/x`, "3f0e6c1a58a44d3b9c550f6a2f3b7c11"]) {
      expect(() => sourceAudioKey({ ...base, sessionId: bad })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
      expect(() => sourceAudioKey({ ...base, utteranceId: bad })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
      expect(() => sourceAudioKey({ ...base, assetId: bad })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
  });

  it("rejects an unsafe study slug or extension", () => {
    const base = { studySlug: "dialect-study", sessionId: SESSION, utteranceId: UTTERANCE, assetId: ASSET, extension: "wav" };
    for (const bad of ["", "Dialect Study", "a/b", "..", "-leading", "UPPER"]) {
      expect(() => sourceAudioKey({ ...base, studySlug: bad })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
    for (const bad of ["", "wav/..", "w v", "toolongextension", "."]) {
      expect(() => sourceAudioKey({ ...base, extension: bad })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
  });
});

describe("ttsAudioKey", () => {
  it("builds the generated audio key", () => {
    expect(ttsAudioKey({ studySlug: "dialect-study", synthesisId: OTHER, assetId: ASSET, extension: "wav" })).toBe(
      `studies/dialect-study/generated/syntheses/${OTHER}/${ASSET}.wav`,
    );
  });

  it("rejects ids that are not UUIDs", () => {
    expect(() => ttsAudioKey({ studySlug: "dialect-study", synthesisId: "latest", assetId: ASSET, extension: "wav" })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });
});

describe("exportArchiveKey", () => {
  it("builds the export key", () => {
    expect(exportArchiveKey({ studySlug: "dialect-study", exportJobId: OTHER, fileName: "dataset_v1.zip" })).toBe(
      `studies/dialect-study/exports/${OTHER}/dataset_v1.zip`,
    );
  });

  it("rejects unsafe file names", () => {
    for (const bad of ["", "../x.zip", "a/b.zip", "a..zip", ".hidden", "name with space.zip", "a\\b.zip"]) {
      expect(() => exportArchiveKey({ studySlug: "dialect-study", exportJobId: OTHER, fileName: bad })).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });
});

describe("assertValidObjectKey", () => {
  it("accepts every key produced by the builders", () => {
    const keys = [
      sourceAudioKey({ studySlug: "dialect-study", sessionId: SESSION, utteranceId: UTTERANCE, assetId: ASSET, extension: "wav" }),
      ttsAudioKey({ studySlug: "dialect-study", synthesisId: OTHER, assetId: ASSET, extension: "mp3" }),
      exportArchiveKey({ studySlug: "dialect-study", exportJobId: OTHER, fileName: "dataset.zip" }),
    ];
    for (const key of keys) expect(() => assertValidObjectKey(key)).not.toThrow();
  });

  it("rejects keys that could leave the storage root", () => {
    for (const key of UNSAFE_KEYS) {
      expect(() => assertValidObjectKey(key)).toThrowError(expect.objectContaining({ code: "STORAGE_ERROR" }));
    }
    expect(() => assertValidObjectKey("a".repeat(1025))).toThrowError(expect.objectContaining({ code: "STORAGE_ERROR" }));
  });
});

describe("isUuid", () => {
  it("recognizes UUIDs", () => {
    expect(isUuid(SESSION)).toBe(true);
    expect(isUuid(SESSION.toUpperCase())).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
