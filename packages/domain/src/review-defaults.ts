// Defaults of the output review (docs/RESEARCH-DESIGN.md, section 3). Researchers
// change them on the Settings page.

// The number of the participant's own recordings shown is a starting value: the
// pilot sets the real one (reports/Source speaker output evaluation.md, "Fatigue
// and number of items").
export const OUTPUT_REVIEW_DEFAULT_MAX_ITEMS = 5;

// The English vocabulary test (LexTALE) is off unless a researcher turns it on:
// the project owner removed it from the participant flow on 2026-10-09, and the
// background questionnaire asks for a self-rating of English reading instead
// (docs/IMPLEMENTATION-STATUS.md, "Deviations").
export const ENGLISH_CHECK_DEFAULT_ENABLED = false;
