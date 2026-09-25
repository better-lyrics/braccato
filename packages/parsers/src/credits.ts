const FREE_TEXT_SEPARATORS = /[/、，,]/;
const CREDIT_LINE_REGEX = /^([^:：]+)[:：]\s*(.+)$/;

// The credits that name who wrote the song. `编曲` (arrangement) ends in `曲` too and is not one.
const SONGWRITER_ROLES = [
	"词",
	"詞",
	"作词",
	"作詞",
	"曲",
	"作曲",
	"writtenby",
	"lyricsby",
	"composedby",
	"lyricist",
	"composer",
];

const CREDIT_ROLES = [
	...SONGWRITER_ROLES,
	"编曲",
	"編曲",
	"和声",
	"和聲",
	"混音",
	"吉他",
	"制作人",
	"製作人",
	"演唱",
	"原唱",
	"翻唱",
	"后期",
	"後期",
	"和音",
	"录音",
	"錄音",
	"策划",
	"策劃",
	"伴奏",
	"美工",
	"海报",
	"海報",
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

// An unlisted CJK role still counts when it ends in a role noun, but only at role length, or a sung
// clause such as `我听见你的声音` would read as one.
const ROLE_NOUN_SUFFIXES = ["词", "詞", "曲", "声", "聲", "音"];
const ROLE_NOUN_MAX_LENGTH = 4;
const ROLE_SEPARATORS = /[/&、,，]/;

function normalizeRole(role: string): string {
	return role.toLowerCase().replace(/\s+/g, "");
}

function isRoleNoun(part: string): boolean {
	if (CREDIT_ROLES.includes(part)) return true;
	return part.length <= ROLE_NOUN_MAX_LENGTH && ROLE_NOUN_SUFFIXES.some((noun) => part.endsWith(noun));
}

// QQ Music joins roles (`作曲/编曲`) and tags them in Latin (`Rap作词`), so a CJK role is read part by part.
function cjkRoleParts(normalized: string): string[] {
	return normalized
		.replace(/[a-z]+/g, "")
		.split(ROLE_SEPARATORS)
		.filter(Boolean);
}

/** Whether the text before a colon names a credit role, such as `作词` or `Produced by`, rather than a singer. */
export function isCreditRole(role: string): boolean {
	const n = normalizeRole(role);
	if (CREDIT_ROLES.includes(n)) return true;
	const parts = cjkRoleParts(n);
	return parts.length > 0 && parts.every(isRoleNoun);
}

function isSongwriterRole(role: string): boolean {
	const n = normalizeRole(role);
	if (SONGWRITER_ROLES.includes(n)) return true;
	return isCreditRole(role) && cjkRoleParts(n).some((part) => SONGWRITER_ROLES.includes(part));
}

/** Whether a lyric line's text is a credit, such as `作词：周杰伦`, rather than a sung line. */
export function isCreditLine(text: string): boolean {
	const credit = text.trim().match(CREDIT_LINE_REGEX);
	return credit !== null && isCreditRole(credit[1]);
}

/** The names a songwriting credit line lists, or none when the line credits anything else. */
export function songwritersInCreditLine(text: string): string[] {
	const credit = text.trim().match(CREDIT_LINE_REGEX);
	if (!credit || !isSongwriterRole(credit[1])) return [];
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
