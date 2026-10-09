import { describe, expect, it } from "vitest";
import { LEXTALE_EN_ITEMS, scoreLexTale } from "./lextale";

describe("LexTALE (English)", () => {
  it("has the published structure: three dummies first, then 60 items, 40 words and 20 nonwords, numbered 1 to 60", () => {
    expect(LEXTALE_EN_ITEMS).toHaveLength(63);
    expect(LEXTALE_EN_ITEMS.slice(0, 3).every((item) => item.dummy && item.number === 0)).toBe(true);
    const scored = LEXTALE_EN_ITEMS.slice(3);
    expect(scored.map((item) => item.number)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(scored.filter((item) => item.isWord)).toHaveLength(40);
    expect(scored.filter((item) => !item.isWord)).toHaveLength(20);
    expect(scored.some((item) => item.dummy)).toBe(false);
  });

  it("scores with the averaged percentage correct and ignores the dummies", () => {
    const perfect = LEXTALE_EN_ITEMS.map((item) => item.isWord);
    expect(scoreLexTale(perfect)).toEqual({ wordsCorrect: 40, nonwordsCorrect: 20, score: 100 });
    // Saying yes to everything: all words right, all nonwords wrong.
    expect(scoreLexTale(LEXTALE_EN_ITEMS.map(() => true))).toEqual({ wordsCorrect: 40, nonwordsCorrect: 0, score: 50 });
    // Wrong answers to the dummies change nothing.
    const dummiesWrong = perfect.map((answer, i) => (i < 3 ? !answer : answer));
    expect(scoreLexTale(dummiesWrong).score).toBe(100);
    // 30 of 40 words and 15 of 20 nonwords: (75 + 75) / 2.
    let words = 0;
    let nonwords = 0;
    const mixed = LEXTALE_EN_ITEMS.map((item) => {
      if (item.dummy) return true;
      if (item.isWord) return (words += 1) <= 30;
      return !((nonwords += 1) <= 15) ? true : false;
    });
    expect(scoreLexTale(mixed)).toEqual({ wordsCorrect: 30, nonwordsCorrect: 15, score: 75 });
  });

  it("refuses an answer list of the wrong length", () => {
    expect(() => scoreLexTale([true])).toThrow(/63 answers/);
  });
});
