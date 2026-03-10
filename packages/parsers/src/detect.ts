import { LRCParser } from "./lrc.js";
import { PlainParser } from "./plain.js";
import { QRCParser } from "./qrc.js";
import { SRTParser } from "./srt.js";
import { TTMLParser } from "./ttml.js";
import type { LyricParser } from "./types.js";

const PARSERS_IN_PRIORITY: LyricParser[] = [TTMLParser, LRCParser, SRTParser, QRCParser, PlainParser];

export function detectParser(input: string): LyricParser {
	for (const parser of PARSERS_IN_PRIORITY) {
		if (parser.detect(input)) return parser;
	}
	return PlainParser;
}
