const FREE_TEXT_SEPARATORS = /[/、，,]/;

/** Splits a free text credit such as "A / B、C" into names. */
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
