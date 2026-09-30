import { type LyricFormat, detectFormat } from "./format.js";
import { LRCParser } from "./lrc.js";
import { PlainParser } from "./plain.js";
import { QRCParser } from "./qrc.js";
import { SRTParser } from "./srt.js";
import { TTMLParser } from "./ttml.js";
import type { LyricParser } from "./types.js";

const PARSER_FOR_FORMAT: Record<LyricFormat, LyricParser> = {
	ttml: TTMLParser,
	lrc: LRCParser,
	srt: SRTParser,
	qrc: QRCParser,
	plain: PlainParser,
};

export function detectParser(input: string): LyricParser {
	return PARSER_FOR_FORMAT[detectFormat(input)];
}
