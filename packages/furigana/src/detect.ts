const KANA_REGEX = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function hasKana(text: string): boolean {
	return KANA_REGEX.test(text);
}

export function songHasKana(lines: readonly string[]): boolean {
	return lines.some(hasKana);
}

export interface JapaneseLineDetectionOptions {
	declaredLanguage?: string | null;
	songHasKana: boolean;
}

/**
 * Checks whether a lyric line should be treated as Japanese for Furigana generation.
 *
 * Rules:
 * - If the line itself contains Hiragana or Katakana, it is unconditionally Japanese.
 * - If the line is Han-only (e.g. Kanji like "運命"), it is treated as Japanese only if
 *   the song contains kana elsewhere AND the declared language is either "ja" or unset.
 * - This prevents Chinese lyrics with pinyin (e.g. "我爱你" + "wo ai ni", "天空" + "tian kong")
 *   from receiving erroneous Japanese kana readings when no kana exists anywhere in the song.
 */
export function isJapaneseLine(text: string, options: JapaneseLineDetectionOptions): boolean {
	if (hasKana(text)) {
		return true;
	}
	if (!options.songHasKana) {
		return false;
	}
	const lang = options.declaredLanguage?.trim().toLowerCase();
	return !lang || lang === "ja" || lang.startsWith("ja-") || lang.startsWith("ja_");
}
