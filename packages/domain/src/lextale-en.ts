// The English LexTALE test (Lemhöfer & Broersma 2012, Behavior Research Methods
// 44, 325-343, doi 10.3758/s13428-011-0146-0), as published by its authors at
// https://www.lextale.com/downloads/ExperimenterInstructionsEnglish.pdf
// ("Word list and instructions for use with other software", downloaded
// 2026-10-09, sha256 9b60e485fc549ad2eb4d9d947a2e453fd0745a692c4ce140c066fa4e107d8f25).
// The rows below were extracted from that PDF by a script, not typed by hand.
// The authors allow use for research ("Please feel free to use the LexTALE for
// your research purposes", lextale.com/contact.html) and ask publications to
// cite www.lextale.com and Lemhöfer & Broersma (2012).
//
// Rules of the published instructions, kept by the participant flow:
// - present the items one by one in exactly this order, never shuffled;
// - the first three items are dummies and are not scored;
// - the test is not speeded;
// - score = ((words correct / 40 * 100) + (nonwords correct / 20 * 100)) / 2.

export interface LexTaleItem {
  /** 0 for the three dummies, 1 to 60 for the scored items (the PDF's first column). */
  number: number;
  item: string;
  /** true: an existing English word; false: a nonword. */
  isWord: boolean;
  dummy: boolean;
}

export const LEXTALE_EN_VERSION = "lextale-en-2011";

export const LEXTALE_EN_ITEMS: readonly LexTaleItem[] = [
  { number: 0, item: "platery", isWord: false, dummy: true },
  { number: 0, item: "denial", isWord: true, dummy: true },
  { number: 0, item: "generic", isWord: true, dummy: true },
  { number: 1, item: "mensible", isWord: false, dummy: false },
  { number: 2, item: "scornful", isWord: true, dummy: false },
  { number: 3, item: "stoutly", isWord: true, dummy: false },
  { number: 4, item: "ablaze", isWord: true, dummy: false },
  { number: 5, item: "kermshaw", isWord: false, dummy: false },
  { number: 6, item: "moonlit", isWord: true, dummy: false },
  { number: 7, item: "lofty", isWord: true, dummy: false },
  { number: 8, item: "hurricane", isWord: true, dummy: false },
  { number: 9, item: "flaw", isWord: true, dummy: false },
  { number: 10, item: "alberation", isWord: false, dummy: false },
  { number: 11, item: "unkempt", isWord: true, dummy: false },
  { number: 12, item: "breeding", isWord: true, dummy: false },
  { number: 13, item: "festivity", isWord: true, dummy: false },
  { number: 14, item: "screech", isWord: true, dummy: false },
  { number: 15, item: "savoury", isWord: true, dummy: false },
  { number: 16, item: "plaudate", isWord: false, dummy: false },
  { number: 17, item: "shin", isWord: true, dummy: false },
  { number: 18, item: "fluid", isWord: true, dummy: false },
  { number: 19, item: "spaunch", isWord: false, dummy: false },
  { number: 20, item: "allied", isWord: true, dummy: false },
  { number: 21, item: "slain", isWord: true, dummy: false },
  { number: 22, item: "recipient", isWord: true, dummy: false },
  { number: 23, item: "exprate", isWord: false, dummy: false },
  { number: 24, item: "eloquence", isWord: true, dummy: false },
  { number: 25, item: "cleanliness", isWord: true, dummy: false },
  { number: 26, item: "dispatch", isWord: true, dummy: false },
  { number: 27, item: "rebondicate", isWord: false, dummy: false },
  { number: 28, item: "ingenious", isWord: true, dummy: false },
  { number: 29, item: "bewitch", isWord: true, dummy: false },
  { number: 30, item: "skave", isWord: false, dummy: false },
  { number: 31, item: "plaintively", isWord: true, dummy: false },
  { number: 32, item: "kilp", isWord: false, dummy: false },
  { number: 33, item: "interfate", isWord: false, dummy: false },
  { number: 34, item: "hasty", isWord: true, dummy: false },
  { number: 35, item: "lengthy", isWord: true, dummy: false },
  { number: 36, item: "fray", isWord: true, dummy: false },
  { number: 37, item: "crumper", isWord: false, dummy: false },
  { number: 38, item: "upkeep", isWord: true, dummy: false },
  { number: 39, item: "majestic", isWord: true, dummy: false },
  { number: 40, item: "magrity", isWord: false, dummy: false },
  { number: 41, item: "nourishment", isWord: true, dummy: false },
  { number: 42, item: "abergy", isWord: false, dummy: false },
  { number: 43, item: "proom", isWord: false, dummy: false },
  { number: 44, item: "turmoil", isWord: true, dummy: false },
  { number: 45, item: "carbohydrate", isWord: true, dummy: false },
  { number: 46, item: "scholar", isWord: true, dummy: false },
  { number: 47, item: "turtle", isWord: true, dummy: false },
  { number: 48, item: "fellick", isWord: false, dummy: false },
  { number: 49, item: "destription", isWord: false, dummy: false },
  { number: 50, item: "cylinder", isWord: true, dummy: false },
  { number: 51, item: "censorship", isWord: true, dummy: false },
  { number: 52, item: "celestial", isWord: true, dummy: false },
  { number: 53, item: "rascal", isWord: true, dummy: false },
  { number: 54, item: "purrage", isWord: false, dummy: false },
  { number: 55, item: "pulsh", isWord: false, dummy: false },
  { number: 56, item: "muddy", isWord: true, dummy: false },
  { number: 57, item: "quirty", isWord: false, dummy: false },
  { number: 58, item: "pudour", isWord: false, dummy: false },
  { number: 59, item: "listless", isWord: true, dummy: false },
  { number: 60, item: "wrought", isWord: true, dummy: false },
];
