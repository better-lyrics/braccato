export type LyricFormat = "ttml" | "lrc" | "srt" | "qrc" | "plain";

export function isTtml(input: string): boolean {
	return input.includes("<tt") && input.includes("</tt>");
}

export function isLrc(input: string): boolean {
	return /\[\d+:\d+\.\d+\]/.test(input);
}

export function isSrt(input: string): boolean {
	return /\d+\r?\n\d{2}:\d{2}:\d{2}[,.]\d+ --> \d{2}:\d{2}:\d{2}[,.]\d+/.test(input);
}

export function isQrc(input: string): boolean {
	if (input.includes("<QrcInfos>") || input.includes("LyricContent=")) return true;
	return /\[\d+,\d+\]/.test(input) && /\(\d+,\d+\)/.test(input);
}

// Priority matters: a TTML file can contain LRC-looking text, and LRC can sit beside QRC stamps.
export function detectFormat(input: string): LyricFormat {
	if (isTtml(input)) return "ttml";
	if (isLrc(input)) return "lrc";
	if (isSrt(input)) return "srt";
	if (isQrc(input)) return "qrc";
	return "plain";
}
