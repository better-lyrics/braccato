// Emits the npm artifact for packages/core/.
//
// The renderer imports nothing outside its own directory, so there is nothing to bundle and no
// bundler here: tsc produces both the JavaScript and the types. The one thing it cannot do is write
// the file extension a browser and Node both require on a relative specifier, because the sources
// are written extensionless, which is the spelling a bundler wants, so the emitted files are
// rewritten afterwards.

import { execFileSync } from "child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { checkApiDocs } from "./check-api-docs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const packageDir = join(root, "packages", "core");
const rendererDir = join(packageDir, "src");
const isWatchBuild = process.env.BRACCATO_PACKAGE_WATCH === "1";
const publishedOutDir = join(packageDir, "dist");
const outDir = isWatchBuild ? mkdtempSync(join(packageDir, ".dist-watch-")) : publishedOutDir;

const removeStagingDir = () => {
  if (isWatchBuild) rmSync(outDir, { recursive: true, force: true });
};
if (isWatchBuild) process.once("exit", removeStagingDir);

// The manifest is `packages/core/package.json`, hand written and published from where it sits like
// every other package here. What this script owes it is the other half of the promise: every subpath
// it names has to be a file this run emitted, checked below.
interface PackageManifest {
  version: string;
  exports: Record<string, string | { types: string; import: string }>;
}

const manifest: PackageManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

// Where the exports map's targets sit relative to the manifest beside them, which is the one thing
// the check below has to undo to compare them against what tsc wrote.
const EMITTED_PREFIX = "./dist/";

// -- Emit --------------------------------------------

// A watch build is compiled, rewritten, copied, and checked in staging. Only the complete artifact
// reaches dist, so linked consumers never observe tsc's extensionless imports or a missing package.
// A one-off/package release build still cleans the published directory directly.
if (!isWatchBuild) rmSync(outDir, { recursive: true, force: true });

execFileSync("npx", ["tsc", "-p", join(__dirname, "tsconfig.package.json"), "--outDir", outDir], {
  stdio: "inherit",
  cwd: root,
});

// -- Extensions --------------------------------------------

// Rewriting every quoted relative path rather than the import statements alone is safe on generated
// code in a way it would not be on hand-written sources: the only quoted relative paths in the
// shipped renderer are its own imports, and the self-checks, which carry import-shaped string
// literals as fixtures, are excluded from the emit. Comments survive into the emit as well, so a
// comment that quotes a relative path would be rewritten too.
const RELATIVE_SPECIFIER = /(["'])(\.\.?\/[^"']+)\1/g;

// A dotted module basename (`./foo.helpers`) reads as an extension here and would go out unrewritten
// and unresolvable. No module in this package has one, and this is the predicate rather than a real
// extension parser because the alternative is guessing which dotted suffixes are extensions.
const HAS_EXTENSION = /\.\w+$/;

const emitted = readdirSync(outDir, { recursive: true, encoding: "utf8" }).filter(
  name => name.endsWith(".js") || name.endsWith(".d.ts")
);

for (const name of emitted) {
  const path = join(outDir, name);
  const source = readFileSync(path, "utf8");
  const rewritten = source.replace(RELATIVE_SPECIFIER, (match, quote: string, specifier: string) =>
    HAS_EXTENSION.test(specifier) ? match : `${quote}${specifier}.js${quote}`
  );
  if (rewritten !== source) {
    writeFileSync(path, rewritten);
  }
}

// -- What the exports map promises --------------------------------------------

// A subpath whose target is a string is a file copied through rather than compiled, and the
// stylesheet wildcard is the only one: it is answered by the copy below instead. Everything else is
// an entry point, and an entry point the emit did not produce is a package that installs and then
// fails to resolve, which nothing downstream of here would notice.
for (const [subpath, target] of Object.entries(manifest.exports)) {
  if (typeof target === "string") continue;
  for (const file of [target.types, target.import]) {
    if (!file.startsWith(EMITTED_PREFIX)) {
      throw new Error(`"${subpath}" points at ${file}, which is outside what this emits`);
    }
    if (!emitted.includes(file.slice(EMITTED_PREFIX.length))) {
      throw new Error(`${file} is in the exports map but was not emitted`);
    }
  }
}

// -- Stylesheets, README, licence --------------------------------------------

// Copied by whatever is there rather than by name, because the exports map publishes them under a
// wildcard, so a sheet added under styles/ is published without touching this file.
const stylesheets = readdirSync(join(rendererDir, "styles")).filter(name => name.endsWith(".css"));

mkdirSync(join(outDir, "styles"), { recursive: true });
for (const name of stylesheets) {
  cpSync(join(rendererDir, "styles", name), join(outDir, "styles", name));
}

// README.md is the npm package page and is written for a consumer. It is the package root's, so npm
// picks it up from there, and the copy here is what puts it beside the code it describes for anyone
// reading the artifact rather than the registry. Everything a contributor to this repository needs
// instead lives in the module's own file headers, which the emit carries along with the code they
// annotate.
cpSync(join(packageDir, "README.md"), join(outDir, "README.md"));
cpSync(join(packageDir, "LICENSE"), join(outDir, "LICENSE"));

// -- What the docs promise --------------------------------------------

// Same shape as the exports check above, one consumer further out: the page in demo/ and the README
// copied in beside this artifact both document the API by name, so the emit is the moment to find
// out whether they still describe it. The version travels with them, because it is the manifest's
// now rather than something this emit writes.
checkApiDocs(outDir, manifest.version);

if (isWatchBuild) {
  mkdirSync(publishedOutDir, { recursive: true });
  cpSync(outDir, publishedOutDir, { recursive: true, force: true });
  removeStagingDir();
  process.removeListener("exit", removeStagingDir);
}

console.log(
  `Emitted @braccato/core ${manifest.version} to packages/core/dist: ${emitted.length} files, ${stylesheets.length} stylesheets`
);
