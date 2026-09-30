export function isTtml(input: string): boolean {
	return input.includes("<tt") && input.includes("</tt>");
}

export function isLrc(input: string): boolean {
	return /\[\d+:\d+\.\d+\]/.test(input);
}

export function isSrt(input: string): boolean {
	// Anchoring the cue number at the start of its digit run keeps a long run of digits linear.
	return /(?<!\d)\d+\r?\n\d{2}:\d{2}:\d{2}[,.]\d+ --> \d{2}:\d{2}:\d{2}[,.]\d+/.test(input);
}

export function isQrc(input: string): boolean {
	if (input.includes("<QrcInfos>") || input.includes("LyricContent=")) return true;
	return /\[\d+,\d+\]/.test(input) && /\(\d+,\d+\)/.test(input);
}
