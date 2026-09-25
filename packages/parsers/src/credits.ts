const FREE_TEXT_SEPARATORS = /[/、，,]/;
const CREDIT_LINE_REGEX = /^([^:：]+)[:：]\s*(.+)$/;

// The credits that name who wrote the song. `编曲` (arrangement) ends in `曲` too and is not one.
const SONGWRITER_ROLES = ["词", "作词", "曲", "作曲", "writtenby", "lyricsby", "composedby", "lyricist", "composer"];

const CREDIT_ROLES = [
	...SONGWRITER_ROLES,
	"编曲",
	"和声",
	"混音",
	"吉他",
	"制作人",
	"演唱",
	"原唱",
	"翻唱",
	"后期",
	"和音",
	"录音",
	"策划",
	"伴奏",
	"美工",
	"海报",
	"旁白",
	"producedby",
	"arrangedby",
	"mixing",
	"mastering",
	"vocal",
	"vocals",
	"guitar",
	"bass",
	"drums",
	"producer",
	"arranger",
];

function normalizeRole(role: string): string {
	return role.toLowerCase().replace(/\s+/g, "");
}

/** Whether the text before a colon names a credit role, such as `作词` or `Produced by`, rather than a singer. */
export function isCreditRole(role: string): boolean {
	const n = normalizeRole(role);
	return CREDIT_ROLES.includes(n) || n.endsWith("词") || n.endsWith("曲") || n.endsWith("声") || n.endsWith("音");
}

/** Whether a lyric line's text is a credit, such as `作词：周杰伦`, rather than a sung line. */
export function isCreditLine(text: string): boolean {
	const credit = text.trim().match(CREDIT_LINE_REGEX);
	return credit !== null && isCreditRole(credit[1]);
}

/** The names a songwriting credit line lists, or none when the line credits anything else. */
export function songwritersInCreditLine(text: string): string[] {
	const credit = text.trim().match(CREDIT_LINE_REGEX);
	if (!credit || !SONGWRITER_ROLES.includes(normalizeRole(credit[1]))) return [];
	return splitCreditNames(credit[2]);
}

export function splitCreditNames(value: string): string[] {
	return value
		.split(FREE_TEXT_SEPARATORS)
		.map((name) => name.trim())
		.filter(Boolean);
}

/** Trims, drops empty names and keeps the first of each exact duplicate, in order. */
export function uniqueNames(names: Iterable<string>): string[] {
	const seen = new Set<string>();
	for (const name of names) {
		const trimmed = name.trim();
		if (trimmed) seen.add(trimmed);
	}
	return [...seen];
}
