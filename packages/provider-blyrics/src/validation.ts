export function stringSimilarity(str1: string, str2: string, substringLength = 2, caseSensitive = false): number {
	const a = caseSensitive ? str1 : str1.toLowerCase();
	const b = caseSensitive ? str2 : str2.toLowerCase();
	if (a.length < substringLength || b.length < substringLength) return 0;

	const map = new Map<string, number>();
	for (let i = 0; i < a.length - (substringLength - 1); i++) {
		const substr = a.substring(i, i + substringLength);
		map.set(substr, (map.get(substr) ?? 0) + 1);
	}

	let match = 0;
	for (let j = 0; j < b.length - (substringLength - 1); j++) {
		const substr = b.substring(j, j + substringLength);
		const count = map.get(substr) ?? 0;
		if (count > 0) {
			map.set(substr, count - 1);
			match++;
		}
	}

	return (match * 2) / (a.length + b.length - (substringLength - 1) * 2);
}

export function createSimilarityValidator(referenceText: string, threshold = 0.5) {
	return (result: { lyrics: { words: string }[] | null }) => {
		if (!result.lyrics || result.lyrics.length === 0) return false;

		const resultText = result.lyrics.map((l) => l.words).join("\n");
		const similarity = stringSimilarity(referenceText, resultText);
		return similarity >= threshold;
	};
}
