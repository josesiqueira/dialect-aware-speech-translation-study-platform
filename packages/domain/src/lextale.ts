// Scoring of the English LexTALE test. The items and the source are in
// lextale-en.ts. Pure functions, shared by the browser and the server.
import { LEXTALE_EN_ITEMS, LEXTALE_EN_VERSION, type LexTaleItem } from "./lextale-en";

export { LEXTALE_EN_ITEMS, LEXTALE_EN_VERSION, type LexTaleItem };

export type LexTaleScore = {
  wordsCorrect: number;
  nonwordsCorrect: number;
  // "% correct av" of the published scoring: the mean of the percentage of words
  // correct (out of 40) and of nonwords correct (out of 20). Dummies are not scored.
  score: number;
};

const WORD_COUNT = LEXTALE_EN_ITEMS.filter((item) => !item.dummy && item.isWord).length;
const NONWORD_COUNT = LEXTALE_EN_ITEMS.filter((item) => !item.dummy && !item.isWord).length;

// answers[i] is the "yes" (true) or "no" (false) answer to LEXTALE_EN_ITEMS[i].
export function scoreLexTale(answers: readonly boolean[]): LexTaleScore {
  if (answers.length !== LEXTALE_EN_ITEMS.length) {
    throw new Error(`LexTALE needs ${LEXTALE_EN_ITEMS.length} answers, got ${answers.length}.`);
  }
  let wordsCorrect = 0;
  let nonwordsCorrect = 0;
  LEXTALE_EN_ITEMS.forEach((item, index) => {
    if (item.dummy) return;
    const yes = answers[index] === true;
    if (item.isWord && yes) wordsCorrect += 1;
    if (!item.isWord && !yes) nonwordsCorrect += 1;
  });
  const score = ((wordsCorrect / WORD_COUNT) * 100 + (nonwordsCorrect / NONWORD_COUNT) * 100) / 2;
  return { wordsCorrect, nonwordsCorrect, score: Math.round(score * 100) / 100 };
}
