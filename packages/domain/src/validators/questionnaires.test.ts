import { describe, expect, it } from "vitest";
import {
  addItemBodySchema,
  createDraftBodySchema,
  diffQuestionnaireItems,
  findIdentifyingFieldWarnings,
  findPublishProblems,
  formatAnswerForDisplay,
  slugifyKey,
  updateDraftBodySchema,
  validateItemConfig,
  validateQuestionnaireAnswers,
  type QuestionnaireItemDefinition,
  type QuestionnaireItemView,
} from "./questionnaires";

const colors = [
  { value: "red", label: "Red" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
];

function item(overrides: Partial<QuestionnaireItemDefinition> & Pick<QuestionnaireItemDefinition, "itemKey" | "type">) {
  return { prompt: "Question?", helpText: null, required: false, config: {}, ...overrides };
}

const ITEMS: QuestionnaireItemDefinition[] = [
  item({ itemKey: "natural", type: "likert", required: true, config: { scaleMin: 1, scaleMax: 7 } }),
  item({ itemKey: "color", type: "single_choice", required: true, config: { options: colors } }),
  item({ itemKey: "colors", type: "multi_choice", config: { options: colors } }),
  item({ itemKey: "comment", type: "free_text", config: { maxLength: 20 } }),
  item({ itemKey: "region", type: "short_text", required: true, config: { maxLength: 10 } }),
  item({ itemKey: "years", type: "integer", config: { min: 0, max: 120 } }),
  item({ itemKey: "changed", type: "boolean", required: true }),
];

const VALID = { natural: 7, color: "green", region: "Oulu", changed: false };

function errorsOf(answers: Record<string, unknown>, items = ITEMS) {
  const result = validateQuestionnaireAnswers(items, answers);
  if (result.ok) throw new Error("expected the answers to be rejected");
  return result;
}

describe("validateQuestionnaireAnswers", () => {
  it("accepts a valid answer of every type and returns typed values", () => {
    const result = validateQuestionnaireAnswers(ITEMS, {
      natural: 1,
      color: "red",
      colors: ["blue", "red"],
      comment: "  fine  ",
      region: "Turku",
      years: 0,
      changed: true,
    });
    expect(result).toEqual({
      ok: true,
      values: {
        natural: 1,
        color: "red",
        // Stored in option order, without duplicates.
        colors: ["red", "blue"],
        comment: "fine",
        region: "Turku",
        years: 0,
        changed: true,
      },
    });
  });

  it("leaves unanswered optional items out: absent, null, empty text and empty list", () => {
    for (const empty of [undefined, null, "", "   ", []]) {
      const result = validateQuestionnaireAnswers(ITEMS, { ...VALID, colors: empty, comment: empty, years: empty });
      expect(result).toEqual({ ok: true, values: VALID });
    }
  });

  it("keeps false and 0 as answers", () => {
    const result = validateQuestionnaireAnswers(ITEMS, { ...VALID, years: 0 });
    expect(result.ok && result.values).toMatchObject({ changed: false, years: 0 });
  });

  it("requires every required item", () => {
    const result = errorsOf({});
    expect(Object.keys(result.errors).sort()).toEqual(["changed", "color", "natural", "region"]);
    expect(result.errorCodes.natural).toBe("required");
    expect(result.errors.natural).toBe("Please answer this question.");
    expect(errorsOf({ ...VALID, region: "   " }).errorCodes).toEqual({ region: "required" });
    expect(errorsOf({ ...VALID, changed: null }).errorCodes).toEqual({ changed: "required" });
  });

  it("rejects a Likert answer outside the scale, not whole, or of the wrong type", () => {
    expect(errorsOf({ ...VALID, natural: 0 }).errorCodes).toEqual({ natural: "out_of_range" });
    expect(errorsOf({ ...VALID, natural: 8 }).errorCodes).toEqual({ natural: "out_of_range" });
    expect(errorsOf({ ...VALID, natural: 2.5 }).errorCodes).toEqual({ natural: "not_integer" });
    expect(errorsOf({ ...VALID, natural: "3" }).errorCodes).toEqual({ natural: "invalid_type" });
    expect(errorsOf({ ...VALID, natural: Number.NaN }).errorCodes).toEqual({ natural: "invalid_type" });
  });

  it("uses the scale 1 to 5 when a Likert item has no bounds", () => {
    const items = [item({ itemKey: "a", type: "likert" })];
    expect(validateQuestionnaireAnswers(items, { a: 5 }).ok).toBe(true);
    expect(errorsOf({ a: 6 }, items).errorCodes).toEqual({ a: "out_of_range" });
  });

  it("rejects an unknown option and a wrong type for choices", () => {
    expect(errorsOf({ ...VALID, color: "purple" }).errorCodes).toEqual({ color: "unknown_option" });
    expect(errorsOf({ ...VALID, color: ["red"] }).errorCodes).toEqual({ color: "invalid_type" });
    expect(errorsOf({ ...VALID, colors: ["red", "purple"] }).errorCodes).toEqual({ colors: "unknown_option" });
    expect(errorsOf({ ...VALID, colors: "red" }).errorCodes).toEqual({ colors: "invalid_type" });
    expect(errorsOf({ ...VALID, colors: ["red", 2] }).errorCodes).toEqual({ colors: "invalid_type" });
  });

  it("rejects text that is too long or not text", () => {
    expect(errorsOf({ ...VALID, region: "x".repeat(11) }).errorCodes).toEqual({ region: "too_long" });
    expect(errorsOf({ ...VALID, comment: "x".repeat(21) }).errorCodes).toEqual({ comment: "too_long" });
    expect(errorsOf({ ...VALID, comment: 12 }).errorCodes).toEqual({ comment: "invalid_type" });
    expect(validateQuestionnaireAnswers(ITEMS, { ...VALID, region: "x".repeat(10) }).ok).toBe(true);
  });

  it("rejects an integer out of range, not whole, or of the wrong type", () => {
    expect(errorsOf({ ...VALID, years: -1 }).errorCodes).toEqual({ years: "out_of_range" });
    expect(errorsOf({ ...VALID, years: 121 }).errorCodes).toEqual({ years: "out_of_range" });
    expect(errorsOf({ ...VALID, years: 1.5 }).errorCodes).toEqual({ years: "not_integer" });
    expect(errorsOf({ ...VALID, years: "12" }).errorCodes).toEqual({ years: "invalid_type" });
    const open = [item({ itemKey: "n", type: "integer" })];
    expect(validateQuestionnaireAnswers(open, { n: -5000 }).ok).toBe(true);
  });

  it("rejects a boolean of the wrong type", () => {
    expect(errorsOf({ ...VALID, changed: "yes" }).errorCodes).toEqual({ changed: "invalid_type" });
    expect(errorsOf({ ...VALID, changed: 1 }).errorCodes).toEqual({ changed: "invalid_type" });
  });

  it("rejects an unknown item key", () => {
    const result = errorsOf({ ...VALID, shoe_size: 43 });
    expect(result.errorCodes).toEqual({ shoe_size: "unknown_item" });
    expect(errorsOf({ ...VALID, toString: "x" }).errorCodes).toEqual({ toString: "unknown_item" });
  });

  it("reports every problem at once", () => {
    const result = errorsOf({ natural: 9, color: "purple", region: "Oulu", changed: true, years: 1.5 });
    expect(result.errorCodes).toEqual({ natural: "out_of_range", color: "unknown_option", years: "not_integer" });
  });
});

describe("validateItemConfig", () => {
  it("accepts a Likert scale of 2 to 11 points with optional end labels", () => {
    expect(validateItemConfig("likert", { scaleMin: 1, scaleMax: 5 })).toEqual({
      ok: true,
      config: { scaleMin: 1, scaleMax: 5 },
    });
    expect(
      validateItemConfig("likert", { scaleMin: 0, scaleMax: 10, scaleMinLabel: "Not at all", scaleMaxLabel: "Fully" }),
    ).toEqual({ ok: true, config: { scaleMin: 0, scaleMax: 10, scaleMinLabel: "Not at all", scaleMaxLabel: "Fully" } });
    expect(validateItemConfig("likert", { scaleMin: 1, scaleMax: 2 }).ok).toBe(true);
  });

  it("rejects a Likert scale that is missing, reversed, fractional or too long", () => {
    expect(validateItemConfig("likert", {}).ok).toBe(false);
    expect(validateItemConfig("likert", { scaleMin: 5, scaleMax: 1 }).ok).toBe(false);
    expect(validateItemConfig("likert", { scaleMin: 3, scaleMax: 3 }).ok).toBe(false);
    expect(validateItemConfig("likert", { scaleMin: 1.5, scaleMax: 5 }).ok).toBe(false);
    expect(validateItemConfig("likert", { scaleMin: 1, scaleMax: 12 }).ok).toBe(false);
    expect(validateItemConfig("likert", { scaleMin: 1, scaleMax: 5, scaleMinLabel: 3 }).ok).toBe(false);
  });

  it("requires at least two options with unique non-empty values and labels", () => {
    for (const type of ["single_choice", "multi_choice"] as const) {
      expect(validateItemConfig(type, { options: colors })).toEqual({ ok: true, config: { options: colors } });
      expect(validateItemConfig(type, {}).ok).toBe(false);
      expect(validateItemConfig(type, { options: [colors[0]] }).ok).toBe(false);
      expect(validateItemConfig(type, { options: [colors[0], { value: "red", label: "Again" }] }).ok).toBe(false);
      expect(validateItemConfig(type, { options: [colors[0], { value: " ", label: "Empty" }] }).ok).toBe(false);
      expect(validateItemConfig(type, { options: [colors[0], { value: "x", label: "" }] }).ok).toBe(false);
    }
  });

  it("checks integer bounds", () => {
    expect(validateItemConfig("integer", {})).toEqual({ ok: true, config: {} });
    expect(validateItemConfig("integer", { min: 3, max: 3 })).toEqual({ ok: true, config: { min: 3, max: 3 } });
    expect(validateItemConfig("integer", { min: 4, max: 3 }).ok).toBe(false);
    expect(validateItemConfig("integer", { min: 0.5 }).ok).toBe(false);
  });

  it("checks the text length limit and accepts a boolean without configuration", () => {
    expect(validateItemConfig("short_text", { maxLength: 200 })).toEqual({ ok: true, config: { maxLength: 200 } });
    expect(validateItemConfig("free_text", {}).ok).toBe(true);
    expect(validateItemConfig("free_text", { maxLength: 0 }).ok).toBe(false);
    expect(validateItemConfig("boolean", {})).toEqual({ ok: true, config: {} });
  });

  it("keeps only the keys the type uses and rejects a non-object", () => {
    expect(validateItemConfig("boolean", { options: colors, scaleMin: 1 })).toEqual({ ok: true, config: {} });
    expect(validateItemConfig("likert", null).ok).toBe(false);
    expect(validateItemConfig("likert", []).ok).toBe(false);
  });
});

describe("findPublishProblems", () => {
  const view = (overrides: Partial<QuestionnaireItemView>): QuestionnaireItemView => ({
    id: "id",
    itemKey: "a",
    type: "boolean",
    prompt: "Question?",
    helpText: null,
    required: false,
    orderIndex: 0,
    config: {},
    ...overrides,
  });

  it("needs at least one item", () => {
    expect(findPublishProblems([])).toEqual(["Add at least one item."]);
  });

  it("reports duplicate keys, empty prompts and invalid configurations", () => {
    const problems = findPublishProblems([
      view({}),
      view({ prompt: "  " }),
      view({ itemKey: "scale", type: "likert", config: { scaleMin: 5, scaleMax: 1 } }),
      view({ itemKey: "Bad Key" }),
    ]);
    expect(problems).toHaveLength(4);
    expect(problems.join(" ")).toContain("used more than once");
    expect(problems.join(" ")).toContain("the prompt is empty");
    expect(problems.join(" ")).toContain("Scale minimum must be lower");
    expect(problems.join(" ")).toContain("must start with a letter");
    expect(findPublishProblems([view({})])).toEqual([]);
  });
});

describe("findIdentifyingFieldWarnings", () => {
  it("warns about name, address, identity code and email", () => {
    expect(findIdentifyingFieldWarnings({ itemKey: "full_name", prompt: "?" })).toHaveLength(1);
    expect(findIdentifyingFieldWarnings({ itemKey: "q1", prompt: "What is your home address?" })).toHaveLength(1);
    expect(findIdentifyingFieldWarnings({ itemKey: "q1", prompt: "Henkilötunnuksesi?" })).toHaveLength(1);
    expect(findIdentifyingFieldWarnings({ itemKey: "contact_email", prompt: "Your e-mail" })).toHaveLength(1);
  });

  it("does not warn about ordinary research variables", () => {
    expect(findIdentifyingFieldWarnings({ itemKey: "age_range", prompt: "What is your age range?" })).toEqual([]);
    expect(
      findIdentifyingFieldWarnings({ itemKey: "region_grew_up", prompt: "In which municipality did you grow up?" }),
    ).toEqual([]);
  });
});

describe("diffQuestionnaireItems", () => {
  const base = [
    { itemKey: "a", type: "likert", prompt: "A?", helpText: null, required: true, orderIndex: 0, config: { scaleMin: 1, scaleMax: 5 } },
    { itemKey: "b", type: "free_text", prompt: "B?", helpText: null, required: false, orderIndex: 1, config: {} },
    { itemKey: "c", type: "boolean", prompt: "C?", helpText: null, required: false, orderIndex: 2, config: {} },
  ] as const;

  it("finds added, removed, reworded and rescaled items", () => {
    const diff = diffQuestionnaireItems(base, [
      { ...base[0], prompt: "A, reworded?", config: { scaleMin: 1, scaleMax: 7 } },
      { ...base[2], orderIndex: 1 },
      { itemKey: "d", type: "short_text", prompt: "D?", helpText: null, required: false, orderIndex: 2, config: {} },
    ]);
    expect(diff.added.map((entry) => entry.itemKey)).toEqual(["d"]);
    expect(diff.removed.map((entry) => entry.itemKey)).toEqual(["b"]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ itemKey: "a", changes: ["wording", "scale"] });
    expect(diff.unchangedCount).toBe(1);
  });

  it("reports a change of position among the shared items", () => {
    const diff = diffQuestionnaireItems(base, [
      { ...base[1], orderIndex: 0 },
      { ...base[0], orderIndex: 1 },
      { ...base[2], orderIndex: 2 },
    ]);
    expect(diff.changed.map((entry) => [entry.itemKey, entry.changes])).toEqual([
      ["b", ["order"]],
      ["a", ["order"]],
    ]);
  });

  it("reports nothing for identical lists", () => {
    const diff = diffQuestionnaireItems(base, base);
    expect(diff).toMatchObject({ added: [], removed: [], changed: [], unchangedCount: 3 });
  });
});

describe("formatAnswerForDisplay", () => {
  it("resolves option labels and writes the other types as text", () => {
    expect(formatAnswerForDisplay({ type: "single_choice", config: { options: colors } }, "green")).toBe("Green");
    expect(formatAnswerForDisplay({ type: "multi_choice", config: { options: colors } }, ["red", "blue"])).toBe("Red; Blue");
    expect(formatAnswerForDisplay({ type: "likert", config: { scaleMin: 1, scaleMax: 7 } }, 4)).toBe("4 (scale 1 to 7)");
    expect(formatAnswerForDisplay({ type: "boolean", config: {} }, false)).toBe("No");
    expect(formatAnswerForDisplay({ type: "integer", config: {} }, 0)).toBe("0");
    expect(formatAnswerForDisplay({ type: "free_text", config: {} }, "Hello")).toBe("Hello");
    expect(formatAnswerForDisplay({ type: "free_text", config: {} }, null)).toBeNull();
    expect(formatAnswerForDisplay({ type: "single_choice", config: { options: colors } }, "gone")).toContain("gone");
  });
});

describe("request schemas and keys", () => {
  it("accepts any well-formed questionnaire key and rejects a malformed one", () => {
    expect(createDraftBodySchema.safeParse({ key: "source_speaker_evaluation", name: "Evaluation" }).success).toBe(true);
    expect(createDraftBodySchema.safeParse({ key: "Source Speaker", name: "Evaluation" }).success).toBe(false);
    expect(createDraftBodySchema.safeParse({ key: "ok", name: "" }).success).toBe(false);
    expect(createDraftBodySchema.safeParse({ key: "ok", name: "N", extra: 1 }).success).toBe(false);
  });

  it("validates items of a draft save", () => {
    const good = { itemKey: "a", type: "likert", prompt: "A?", required: true, config: { scaleMin: 1, scaleMax: 5 } };
    expect(updateDraftBodySchema.safeParse({ items: [good] }).success).toBe(true);
    expect(updateDraftBodySchema.safeParse({ items: [{ ...good, type: "slider" }] }).success).toBe(false);
    expect(updateDraftBodySchema.safeParse({ items: [{ ...good, config: { unknown: 1 } }] }).success).toBe(false);
    expect(addItemBodySchema.safeParse({ type: "boolean", prompt: "Yes?" }).success).toBe(true);
  });

  it("builds a stable slug", () => {
    expect(slugifyKey("How natural did it feel?")).toBe("how_natural_did_it_feel");
    expect(slugifyKey("Äidinkieli (ensimmäinen)")).toBe("aidinkieli_ensimmainen");
    expect(slugifyKey("3 things")).toBe("things");
    expect(slugifyKey("???")).toBe("");
    expect(slugifyKey("How naturally did you feel you were speaking?")).toBe("how_naturally_did_you_feel_you_were");
    expect(slugifyKey("x".repeat(60))).toHaveLength(40);
  });
});
