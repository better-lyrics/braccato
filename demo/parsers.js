// Turning a lyrics file into the `Lyric[]` the element takes.
//
// @braccato/core parses nothing, on purpose: the array is the interface, and a package that also
// owned five file formats would be two packages. @braccato/parsers is the other half, and pairing
// the two is what a consumer with a .lrc file actually does, so the page does it too.
//
// It resolves to the copy in this workspace rather than a published one, because the two packages
// live side by side and a page demonstrating last month's parsers against this morning's renderer
// would be demonstrating something nobody can install.
//
// The import stays dynamic now that there is a bundler in front of the page, because the reason for
// it survived the move: this and `fast-xml-parser` under it are the largest thing the page can load,
// and a reader who never opens a lyrics file never needs them. What was a fetch of a hand-built
// bundle is a fetch of a chunk, and it still happens on the first file rather than on load.
//
// Nothing here assumes the chunk arrives. `loadParsers` resolves to null on failure and the import
// controls say so; every other control on the page is untouched.

// The package detects a format by returning the parser that claimed it, and a parser has no name to
// print. So the names live here, keyed by the object identity the module hands back.
const FORMAT_NAMES = [
  ["TTMLParser", "TTML"],
  ["LRCParser", "LRC"],
  ["SRTParser", "SRT"],
  ["QRCParser", "QRC"],
  ["PlainParser", "Plain text"],
];

// What LRC needs when the last line has no line after it to end against, and the page has no track
// loaded to ask. Five minutes is the playground's own answer to the same question.
const ASSUMED_DURATION_MS = 300000;

let loading = null;

/**
 * The parsers module, or null if it could not be loaded. Loaded once and shared: a reader who drops
 * three files in a row pays for the fetch on the first one only, and a reader whose copy is missing
 * is told once rather than after every drop.
 */
export function loadParsers() {
  loading ??= import("@braccato/parsers")
    .then(module => ({
      detectParser: module.detectParser,
      names: new Map(FORMAT_NAMES.map(([exported, name]) => [module[exported], name])),
    }))
    .catch(() => null);
  return loading;
}

/**
 * What the page names the other half as, for a reader to install rather than guess at. No version:
 * this is built from source beside the renderer, so a number here would be a claim about a release
 * the page is not running.
 */
export const PARSERS_SPECIFIER = "@braccato/parsers";

/**
 * The lines in `text`, and the format they were recognised as. `durationMs` is what an LRC file
 * needs to end its last line on, so the caller passes the loaded track's duration when it has one.
 *
 * No parser in the package throws, which is why the emptiness check is here: a file that parsed to
 * nothing and a file that was never a lyrics file look the same from the outside, and both are worth
 * saying out loud rather than clearing the view over.
 */
export function parseLyrics(parsers, text, durationMs) {
  const parser = parsers.detectParser(text);
  const format = parsers.names.get(parser) ?? "an unrecognised format";
  const lyrics = parser.parse(text, durationMs > 0 ? durationMs : ASSUMED_DURATION_MS);

  if (lyrics.length === 0 || lyrics.every(line => String(line.words ?? "").trim() === "")) {
    throw new Error(`Read as ${format}, and no lines came out of it.`);
  }

  return { lyrics, format };
}
