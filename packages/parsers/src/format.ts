import { isLrc, isQrc, isSrt, isTtml } from "./formatPredicates.js";

export type LyricFormat = "ttml" | "lrc" | "srt" | "qrc" | "plain";

// Priority matters: a TTML file can contain LRC-looking text, and LRC can sit beside QRC stamps.
export function detectFormat(input: string): LyricFormat {
	if (isTtml(input)) return "ttml";
	if (isLrc(input)) return "lrc";
	if (isSrt(input)) return "srt";
	if (isQrc(input)) return "qrc";
	return "plain";
}
