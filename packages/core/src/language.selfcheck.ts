import { strict as assert } from "node:assert";
import { ROMANIZED_LYRICS_CLASS, TRANSLATED_LYRICS_CLASS } from "./constants";
import { injectRomanization, injectTranslation } from "./inject";
import { resolveLyricLanguages } from "./language";
import { createLyricsRenderer } from "./renderer";
import { asDocument, asElement, FakeDocument } from "./selfcheck/fakeDom";
import { asWindow, FakeWindow, installFakeDOMRect } from "./selfcheck/fakeWindow";

const lyrics = (words: string[]) => words.map(words => ({ words, startTimeMs: 0, durationMs: 0 }));
const han = "刃直海角骨入";
assert.deepEqual(resolveLyricLanguages(lyrics([han]), "ja-JP"), ["ja-JP"]);
assert.deepEqual(resolveLyricLanguages(lyrics([han]), "ko-KR"), ["ko-KR"]);
assert.deepEqual(resolveLyricLanguages(lyrics([han]), "zh_TW"), ["zh-TW"]);
assert.deepEqual(resolveLyricLanguages(lyrics([han]), "zh-Hans-CN"), ["zh-Hans-CN"]);
assert.deepEqual(resolveLyricLanguages(lyrics([han]), "yue-Hant-HK"), ["yue-Hant-HK"]);
assert.deepEqual(resolveLyricLanguages(lyrics(["海の声", han])), ["ja", "ja"]);
assert.deepEqual(resolveLyricLanguages(lyrics(["海の声", han]), "en"), ["ja", "ja"]);
assert.deepEqual(resolveLyricLanguages(lyrics(["한글", han])), ["ko", "ko"]);
assert.deepEqual(resolveLyricLanguages(lyrics(["ｶﾀｶﾅ", han])), ["ja", "ja"]);
assert.deepEqual(resolveLyricLanguages(lyrics(["海の声", "한글", han]), "ja"), ["ja", "ko", "ja"]);
assert.deepEqual(resolveLyricLanguages(lyrics(["海の声", "한글", han])), ["ja", "ko", ""]);
assert.deepEqual(resolveLyricLanguages(lyrics(["hello"]), "en_US"), ["en-US"]);
assert.deepEqual(resolveLyricLanguages(lyrics(["bonjour"]), "fr"), ["fr"]);
assert.deepEqual(resolveLyricLanguages([{ words: "間奏", isInstrumental: true }, { words: han }]), ["", ""]);
for (const language of [undefined, null, "", "und", "auto", "not a tag", "en"]) {
  assert.deepEqual(resolveLyricLanguages(lyrics([han]), language), [""], "Han alone must not be guessed as Chinese");
}

installFakeDOMRect();
class LanguageDocument extends FakeDocument {
  readonly fonts = { ready: new Promise<void>(() => {}) };
  readonly documentElement = this.createElement("html");
}

for (const language of ["ja", "zh-Hant", "ko-KR"]) {
  const doc = new LanguageDocument();
  let measurements = 0;
  const renderer = createLyricsRenderer({
    document: asDocument(doc),
    window: asWindow(new FakeWindow()),
    mount: asElement<HTMLElement>(doc.createElement("div")),
    host: { debug: { beginFrame: () => null, resize: () => measurements++ } },
  });
  renderer.setLyrics(lyrics(["海の声", han]));
  assert.deepEqual(
    renderer.lines.map(line => line.lyricElement.lang),
    ["ja", "ja"],
    "inference works without decorations"
  );
  renderer.setLyrics(lyrics([han]), { language });
  const line = renderer.lines[0];
  assert.equal(line.lyricElement.lang, language);
  injectRomanization(asDocument(doc), line.lyricElement, line, "umi");
  injectTranslation(asDocument(doc), line.lyricElement, "海", "zh_TW");
  const translated = line.lyricElement.querySelector<HTMLElement>(`.${TRANSLATED_LYRICS_CLASS}`)!;
  const romanized = line.lyricElement.querySelector<HTMLElement>(`.${ROMANIZED_LYRICS_CLASS}`)!;
  assert.equal(translated.lang, "zh-TW", "translations keep their own language");
  assert.equal(romanized.lang, `${new Intl.Locale(language).language}-Latn`);

  renderer.setLanguage("ja-JP");
  assert.equal(renderer.lines[0], line, "late detection preserves the render records and animations");
  assert.equal(line.lyricElement.lang, "ja-JP");
  assert.equal(romanized.lang, "ja-Latn");
  assert.equal(translated.lang, "zh-TW", "late detection does not relabel translations");
  const measuredBeforeRepeat = measurements;
  renderer.setLanguage("ja_JP");
  assert.equal(measurements, measuredBeforeRepeat, "equivalent language updates do not re-measure the song");

  renderer.setLanguage(null);
  assert.equal(line.lyricElement.lang, "", "clearing language does not retain a previous hint");
  renderer.setLyrics(lyrics([han]));
  assert.equal(renderer.lines[0].lyricElement.lang, "", "new songs do not inherit a previous song's language");
  injectTranslation(asDocument(doc), renderer.lines[0].lyricElement, "unknown");
  assert.equal(
    renderer.lines[0].lyricElement.querySelector<HTMLElement>(`.${TRANSLATED_LYRICS_CLASS}`)!.lang,
    "",
    "legacy translation calls do not inherit the source language"
  );
  renderer.clear();
  renderer.setLanguage("ja");
  assert.equal(renderer.lines.length, 0);
  renderer.destroy();
  renderer.setLanguage("ko");
}

console.log("Lyric language self-checks passed");
