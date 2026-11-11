const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Canonical_Combining_Class=Virama minus the ones that stay visible; Sinhala al-lakuna joins only beside a ZWJ.
const CONJUNCT_VIRAMA_REGEX =
  /(?:[\u{94D}\u{9CD}\u{A4D}\u{ACD}\u{B4D}\u{C4D}\u{CCD}\u{D4D}\u{1039}\u{17D2}\u{1A60}\u{1B44}\u{1BAB}\u{2D7F}\u{A9C0}\u{AAF6}\u{10A3F}\u{11046}\u{1107F}\u{110B9}\u{11133}\u{111C0}\u{11235}\u{1134D}\u{113D0}\u{11442}\u{114C2}\u{115BF}\u{1163F}\u{116B6}\u{11839}\u{1193E}\u{119E0}\u{11A47}\u{11A99}\u{11C3F}\u{11D45}\u{11D97}\u{11F42}]\u200D?|\u200D\u0DCA|\u0DCA\u200D)$/u;
const LETTER_START_REGEX = /^\p{L}/u;
const MARK_START_REGEX = /^\p{M}/u;

const joinsTamilLigature = (previous: string, next: string): boolean =>
  (previous.endsWith("க்") && next.startsWith("ஷ")) || (previous.endsWith("ஸ்") && next.startsWith("ரீ"));

export function letterClusters(text: string): string[] {
  return joinLetterSegments(Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment));
}

export function joinLetterSegments(segments: Iterable<string>): string[] {
  const clusters: string[] = [];
  let previous = "";
  for (const segment of segments) {
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
