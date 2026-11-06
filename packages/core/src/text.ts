// Script detection for the text the module renders. Pure string work, no DOM and no host state.

export const testRtl = (text: string): boolean =>
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Mandaic}\p{Script=Hanifi_Rohingya}\p{Script=Samaritan}\p{Script=Yezidi}\p{Script=Mende_Kikakui}\p{Script=Old_Hungarian}]/u.test(
    text
  );

export const testJoiningScript = (text: string): boolean =>
  /[\p{Script_Extensions=Arabic}\p{Script_Extensions=Syriac}\p{Script_Extensions=Nko}\p{Script_Extensions=Mongolian}\p{Script_Extensions=Adlam}\p{Script_Extensions=Mandaic}\p{Script_Extensions=Hanifi_Rohingya}]/u.test(
    text
  );

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Canonical_Combining_Class=Virama minus the visible ones (Tamil pulli, Myanmar asat, Thai, Lao, Tagalog, Hanunoo).
const CONJUNCT_VIRAMA_REGEX =
  /[\u{94D}\u{9CD}\u{A4D}\u{ACD}\u{B4D}\u{C4D}\u{CCD}\u{D3B}-\u{D3C}\u{D4D}\u{DCA}\u{F84}\u{1039}\u{17D2}\u{1A60}\u{1B44}\u{1BAA}-\u{1BAB}\u{1BF2}-\u{1BF3}\u{2D7F}\u{A806}\u{A82C}\u{A8C4}\u{A953}\u{A9C0}\u{AAF6}\u{ABED}\u{10A3F}\u{11046}\u{11070}\u{1107F}\u{110B9}\u{11133}-\u{11134}\u{111C0}\u{11235}\u{112EA}\u{1134D}\u{113CE}-\u{113D0}\u{11442}\u{114C2}\u{115BF}\u{1163F}\u{116B6}\u{1172B}\u{11839}\u{1193D}-\u{1193E}\u{119E0}\u{11A34}\u{11A47}\u{11A99}\u{11C3F}\u{11D44}-\u{11D45}\u{11D97}\u{11F41}-\u{11F42}\u{1612F}]\u200D?$/u;
const LETTER_START_REGEX = /^\p{L}/u;
const MARK_START_REGEX = /^\p{M}/u;

const joinsTamilLigature = (previous: string, next: string): boolean =>
  (previous.endsWith("க்") && next.startsWith("ஷ")) || (previous.endsWith("ஸ்") && next.startsWith("ரீ"));

export function letterClusters(text: string): string[] {
  const clusters: string[] = [];
  let previous = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const joins =
      clusters.length > 0 &&
      (MARK_START_REGEX.test(segment) ||
        (LETTER_START_REGEX.test(segment) &&
          (CONJUNCT_VIRAMA_REGEX.test(previous) || joinsTamilLigature(previous, segment))));
    if (joins) clusters[clusters.length - 1] += segment;
    else clusters.push(segment);
    previous = segment;
  }
  return clusters;
}

/**
 * This regex is designed to detect any characters that are outside of the
 * standard "Basic Latin" and "Latin-1 Supplement" Unicode blocks, as well
 * as common "smart" punctuation like curved quotes.
 *
 * How it works:
 * [^...]     - This is a negated set, which matches any character NOT inside the brackets.
 * \x00-\xFF  - This range covers both the "Basic Latin" (ASCII) and "Latin-1 Supplement"
 * blocks. This includes English letters, numbers, common punctuation, and
 * most accented characters used in Western European languages (e.g., á, ö, ñ).
 * ‘-” - This range covers common "smart" or curly punctuation, including single
 * and double quotation marks/apostrophes (‘, ’, “, ”).
 */
const nonLatinRegex = /[^\p{Script_Extensions=Latin}\p{Script_Extensions=Common}]/u;

/**
 * Checks if a given string contains any non-Latin characters.
 * @param text The string to check.
 * @returns True if a non-Latin character is found, otherwise false.
 */
export function containsNonLatin(text: string): boolean {
  return nonLatinRegex.test(text);
}

const SCRIPT_TO_LANG = [
  [/\p{Script=Hiragana}|\p{Script=Katakana}/u, "ja"],
  [/\p{Script=Hangul}/u, "ko"],
  [/\p{Script=Han}/u, "zh"],
  [/\p{Script=Cyrillic}/u, "ru"],
  [/\p{Script=Devanagari}/u, "hi"],
  [/\p{Script=Arabic}/u, "ar"],
  [/\p{Script=Thai}/u, "th"],
  [/\p{Script=Greek}/u, "el"],
  [/\p{Script=Hebrew}/u, "he"],
  [/\p{Script=Bengali}/u, "bn"],
  [/\p{Script=Tamil}/u, "ta"],
  [/\p{Script=Telugu}/u, "te"],
  [/\p{Script=Malayalam}/u, "ml"],
  [/\p{Script=Kannada}/u, "kn"],
  [/\p{Script=Gujarati}/u, "gu"],
  [/\p{Script=Gurmukhi}/u, "pa"],
  [/\p{Script=Sinhala}/u, "si"],
  [/\p{Script=Myanmar}/u, "my"],
  [/\p{Script=Georgian}/u, "ka"],
  [/\p{Script=Khmer}/u, "km"],
  [/\p{Script=Lao}/u, "lo"],
] as const;

type NonLatinLanguageCode = (typeof SCRIPT_TO_LANG)[number][1];

export function detectNonLatinLanguage(text: string): NonLatinLanguageCode | null {
  for (const [regex, lang] of SCRIPT_TO_LANG) {
    if (regex.test(text)) return lang;
  }
  return null;
}

const comparable = (text: string): string => text.toLowerCase().replaceAll(/\p{P}/gu, "").trim();

export const isSameText = (a: string, b: string): boolean => comparable(a) === comparable(b);
