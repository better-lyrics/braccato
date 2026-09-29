import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LETTER_CLASS, ROMANIZED_LYRICS_CLASS, RTL_CLASS, WORD_HIGHLIGHT_CLASS } from "./constants";
import { applyDirection, createLyricsLine, injectRomanization, newLineData } from "./inject";
import { asDocument, asElement, collectTree, FakeDocument, type FakeNode } from "./selfcheck/fakeDom";
import { setThemeSettings } from "./themeSettings";

// The engine reads RTL from the highlight's own class, so the stylesheet must never read it from an ancestor.

const STYLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "styles");

function selectorsIn(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]+)\{/g)]
    .map(match => match[1].trim())
    .filter(prelude => !prelude.startsWith("@"))
    .flatMap(prelude => prelude.split(","))
    .map(selector => selector.trim())
    .filter(Boolean);
}

for (const sheet of readdirSync(STYLES_DIR).filter(name => name.endsWith(".css"))) {
  const directionalHighlightSelectors = selectorsIn(readFileSync(resolve(STYLES_DIR, sheet), "utf8")).filter(
    selector => selector.includes(`.${RTL_CLASS}`) && selector.includes(`.${WORD_HIGHLIGHT_CLASS}`)
  );
  for (const selector of directionalHighlightSelectors) {
    const compounds = selector.split(/\s*[\s>+~]\s*/);
    const highlightCompound = compounds.find(compound => compound.includes(`.${WORD_HIGHLIGHT_CLASS}`));
    const rtlCompounds = compounds.filter(compound => new RegExp(`\\.${RTL_CLASS}(?![\\w-])`).test(compound));
    assert.deepEqual(
      rtlCompounds,
      [highlightCompound],
      `Given "${selector}" in styles/${sheet}, When its direction is read, Then it comes from the highlight itself and never from an ancestor`
    );
  }
}

// -- An LTR romanization under an RTL line keeps its own direction --------------------------------------------

const hasClass = (name: string) => (node: FakeNode) => node.classList.contains(name);

for (const letterWave of ["true", "false"]) {
  setThemeSettings(new Map([["blyrics-letter-wave", letterWave]]));
  const doc = new FakeDocument();
  const lyricElement = doc.createElement("div");
  lyricElement.classList.add(RTL_CLASS);
  const target = asElement<HTMLElement>(lyricElement);
  const line = newLineData(target, 0, 2000);

  createLyricsLine(
    asDocument(doc),
    [
      { startTimeMs: 0, words: "يا ", durationMs: 500 },
      { startTimeMs: 500, words: "love ", durationMs: 500 },
      { startTimeMs: 1000, words: "حبيبي", durationMs: 1000 },
    ],
    line,
    target
  );
  injectRomanization(asDocument(doc), target, line, "Ya habibi", [
    { startTimeMs: 0, words: "Ya ", durationMs: 500 },
    { startTimeMs: 500, words: "habibi", durationMs: 1500 },
  ]);

  const romanization = collectTree(lyricElement).find(hasClass(ROMANIZED_LYRICS_CLASS));
  assert.ok(romanization, `Given timed romanization (letter wave ${letterWave}), When injected, Then it is built`);
  const romanizedHighlights = collectTree(romanization).filter(hasClass(WORD_HIGHLIGHT_CLASS));
  const mainHighlights = collectTree(lyricElement)
    .filter(hasClass(WORD_HIGHLIGHT_CLASS))
    .filter(node => !romanizedHighlights.includes(node));

  assert.deepEqual(
    romanizedHighlights.map(node => [node.dataset.content, node.classList.contains(RTL_CLASS)]),
    [
      ["Ya", false],
      ["habibi", false],
    ],
    `Given a Latin romanization under an RTL line (letter wave ${letterWave}), When built, Then no highlight in it is marked RTL`
  );
  assert.deepEqual(
    mainHighlights.map(node => [node.dataset.content, node.classList.contains(RTL_CLASS)]),
    [
      ["يا", true],
      ["love", false],
      ["حبيبي", true],
    ],
    `Given a mixed-script RTL line (letter wave ${letterWave}), When built, Then each highlight is marked by its own script`
  );
  assert.equal(
    romanizedHighlights.every(node => collectTree(node).some(hasClass(LETTER_CLASS))),
    letterWave === "true",
    `Given letter wave ${letterWave}, When the romanization is built, Then its highlights ${letterWave === "true" ? "are" : "are not"} split into letters`
  );
}

// -- Every right-to-left script is detected as RTL ------------------------------------------------------------

const RTL_SAMPLES: [script: string, word: string][] = [
  ["Arabic", "حبيبي"],
  ["Hebrew", "שלום"],
  ["Syriac", "ܫܠܡܐ"],
  ["Thaana", "ދިވެހި"],
  ["N'Ko", "ߒߞߏ"],
  ["Adlam", "\u{1E900}\u{1E923}\u{1E924}\u{1E922}\u{1E925}"],
  ["Mandaic", "ࡌࡀࡍࡃࡀ"],
  ["Hanifi Rohingya", "\u{10D0C}\u{10D1F}\u{10D11}"],
  ["Samaritan", "ࠔࠌࠓ"],
];

setThemeSettings(new Map());
for (const [script, word] of RTL_SAMPLES) {
  const doc = new FakeDocument();
  const lyricElement = doc.createElement("div");
  const target = asElement<HTMLElement>(lyricElement);
  applyDirection(target, word);
  createLyricsLine(
    asDocument(doc),
    [{ startTimeMs: 0, words: word, durationMs: 500 }],
    newLineData(target, 0, 500),
    target
  );

  assert.equal(
    target.dataset.direction,
    "rtl",
    `Given a ${script} line, When its direction is applied, Then the line is marked RTL`
  );
  assert.ok(
    collectTree(lyricElement)
      .filter(hasClass(WORD_HIGHLIGHT_CLASS))
      .every(node => node.classList.contains(RTL_CLASS)),
    `Given a ${script} word, When built, Then its highlight is marked RTL so the swipe runs right to left`
  );
}

console.log("direction self-check passed");
