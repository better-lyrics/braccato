import assert from "node:assert/strict";
import { imageHighlights, imageURL } from "./imageHighlights";
import { parseThemeConfig, setThemeSettings } from "./themeSettings";

assert.equal(imageHighlights.getBooleanValue(), false);
assert.equal(setThemeSettings(parseThemeConfig("/* blyrics-image-highlights = true; */")), true);
assert.equal(imageHighlights.getBooleanValue(), true);
assert.equal(setThemeSettings(parseThemeConfig("/* blyrics-image-highlights = true; */")), false);
assert.equal(setThemeSettings(new Map()), true);
assert.equal(imageHighlights.getBooleanValue(), false);
assert.equal(imageURL('url("data:image/jpeg;base64,AA==")'), "data:image/jpeg;base64,AA==");
assert.equal(imageURL("url('https://example.test/white.jpg')"), "https://example.test/white.jpg");
assert.equal(imageURL("url(white.jpg)"), "white.jpg");
assert.equal(imageURL("none"), null);
assert.equal(imageURL("linear-gradient(white,black)"), null);
assert.equal(imageURL("url(a), url(b)"), null);
console.log("Image highlight opt-in and image-source self-check passed");
