import { ROMANIZED_LYRICS_CLASS } from "./constants";

interface LyricText {
  words: string;
  isInstrumental?: boolean;
}

export function normalizeLanguage(language?: string | null): string {
  if (!language || language === "auto" || language === "und") return "";
  try {
    return Intl.getCanonicalLocales(language.trim().replaceAll("_", "-"))[0] ?? "";
  } catch {
    return "";
  }
}

function detectCjkLanguage(text: string): string | null {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  // Han alone cannot distinguish Japanese, Korean, or the Chinese writing systems.
  return null;
}

function isCjkLanguage(language: string): boolean {
  return /^(ja|ko|zh|yue)(-|$)|-(Hans|Hant)(-|$)/i.test(language);
}

export function resolveLyricLanguages(lyrics: readonly LyricText[], sourceLanguage?: string | null): string[] {
  const language = normalizeLanguage(sourceLanguage);
  const hints = lyrics.map(line => (line.isInstrumental ? null : detectCjkLanguage(line.words)));
  const songHints = new Set(hints.filter(hint => hint !== null));
  const songHint = songHints.size === 1 ? [...songHints][0] : "";
  const fallback = isCjkLanguage(language) ? language : songHint || language;

  return lyrics.map((line, index) => {
    if (line.isInstrumental) return "";
    const hint = hints[index];
    if (hint && fallback.split("-")[0] !== hint) return hint;
    if (/\p{Script=Han}/u.test(line.words) && !isCjkLanguage(fallback)) return "";
    return fallback;
  });
}

/** Tags only lyric content, leaving the host UI and source footer in their own language. */
export function applyLyricLanguage(element: HTMLElement, language?: string | null): void {
  const normalized = normalizeLanguage(language);
  element.lang = normalized;
  const romanization = element.querySelector<HTMLElement>(`.${ROMANIZED_LYRICS_CLASS}`);
  if (romanization) romanization.lang = `${normalized ? new Intl.Locale(normalized).language : "und"}-Latn`;
}
