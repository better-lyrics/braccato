import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTRUMENTAL_WAVE_PATH_HIGH, INSTRUMENTAL_WAVE_PATH_LOW } from "./instrumental";

const VARIABLES_CSS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "styles/variables.css"), "utf8");

function readDeclaredPath(property: string): string {
  const match = new RegExp(`${property}:\\s*path\\("([^"]*)"\\)\\s*;`).exec(VARIABLES_CSS);
  assert.ok(match, `Given styles/variables.css, When ${property} is read, Then it declares one path() value`);
  return match[1];
}

const declaredHigh = readDeclaredPath("--blyrics-instrumental-wave-path-high");
const declaredLow = readDeclaredPath("--blyrics-instrumental-wave-path-low");

assert.equal(
  declaredHigh,
  INSTRUMENTAL_WAVE_PATH_HIGH,
  "Given the high wave path lives in both the module and its stylesheet, When the two are compared, Then a theme that overrides nothing sees the shape the module would have drawn anyway"
);

assert.equal(
  declaredLow,
  INSTRUMENTAL_WAVE_PATH_LOW,
  "Given the low wave path lives in both the module and its stylesheet, When the two are compared, Then a theme that overrides nothing sees the shape the module would have drawn anyway"
);

function pathSignature(path: string): string {
  const segments = path.match(/[A-Za-z][^A-Za-z]*/g);
  assert.ok(segments, `Given the path "${path}", When it is split, Then it holds at least one command`);
  return segments
    .map(segment => {
      const command = segment[0];
      const argumentCount = segment.slice(1).match(/-?\d*\.?\d+/g)?.length ?? 0;
      return `${command}${argumentCount}`;
    })
    .join(" ");
}

assert.equal(
  pathSignature("M -4 3 Q 1 2 5 3 Z"),
  "M2 Q4 Z0",
  "Given a path of known shape, When its signature is taken, Then each command carries the count of numbers that followed it"
);

assert.equal(
  pathSignature(INSTRUMENTAL_WAVE_PATH_LOW),
  pathSignature(INSTRUMENTAL_WAVE_PATH_HIGH),
  "Given the two shapes the ripple morphs between, When their signatures are compared, Then a browser interpolates them smoothly rather than snapping at the halfway point"
);

console.log(`Instrumental wave self-check passed over ${pathSignature(INSTRUMENTAL_WAVE_PATH_HIGH)}`);
