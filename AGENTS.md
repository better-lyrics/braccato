# AGENTS.md

Operating notes for AI agents working in this repo. They cover what the config files do not make
obvious; read the package READMEs for the API itself.

## Nothing runs the test suite on PRs

`.github/workflows/release.yml` is the only GitHub Actions workflow, and it runs on pushes to
`master`. The checks a PR gets (Cloudflare Pages, Socket Security, Graphite) do not lint, typecheck
or test, so these local runs are the whole gate. Run them before calling work done:

```bash
pnpm lint        # biome check, read-only; pnpm lint:fix writes
pnpm typecheck
pnpm test        # vitest: parsers, highlight, provider-blyrics, rics
pnpm selfcheck   # core's self-checks (see below)
pnpm build
```

Run `pnpm install` in each git worktree. In a non-interactive shell use `CI=true pnpm install`: pnpm
can stop at a hidden "reinstall from scratch?" prompt and leave packages without `node_modules`,
which then fails the build with `vite: not found`.

`typecheck` and `test` depend on `^build` in Turbo. Running `tsc` or `vitest` directly inside a
package fails on a missing `@braccato/types` (or `@braccato/parsers`) `dist/` until you have built
the workspace once.

## Merging to master publishes

The release workflow applies pending changesets and publishes to npm on every push to `master`.
Better Lyrics pins `@braccato/core`, `@braccato/highlight` and `@braccato/parsers` exactly and auto-merges
minor and patch Dependabot bumps once its CI passes and a maintainer approves. That approval sees
only the version bump, so review here is the only review the code gets.

- Every change to a published package under `packages/` needs a `.changeset/*.md`. Write the body as
  user-facing prose about the behaviour, like the existing ones. Root files, tooling and `demo/`
  (ignored in `.changeset/config.json`) need none.
- Never edit package versions or `CHANGELOG.md` by hand. CI writes both in its
  `chore: version packages` commit.
- `pnpm release` is a manual OTP publish that refuses to run with pending changesets. Do not use it.
- The repo only allows squash merges. The PR title becomes the commit subject:
  `type(scope): lowercase imperative`, for example `fix(core): keep lines apart when the view scrolls far`.

### `next` publishes betas

`next` holds the next major version. The release workflow runs on it too, and while
`.changeset/pre.json` is there (changesets' pre mode, entered with `pnpm changeset pre enter beta`)
every release from it is a prerelease such as `2.0.0-beta.3`, published under the npm `beta` tag.
`latest` stays with what `master` publishes.

- Open pull requests for the next major version against `next`. Fixes to the current version go to
  `master` as usual.
- Pre mode releases every package with a changeset on `next` as a beta, so only changes that belong
  to the next major version get one there.
- `next` is kept rebased onto `master`.
- To release the major version, run `pnpm changeset pre exit` on `next`, then squash-merge `next`
  into `master`.

## `@braccato/core` is the Better Lyrics renderer

`packages/core` is the rendering engine Better Lyrics runs on YouTube Music, moved here from
[better-lyrics/better-lyrics](https://github.com/better-lyrics/better-lyrics). Behaviour changes ship
straight into the extension, so check them against it, not only against the demo.

- The demo (`pnpm -C demo dev`, http://localhost:5173/) covers most renderer work. It imports core's
  built `dist/`, and nothing watches core, so run `pnpm package` after each renderer edit and reload
  (`pnpm build` once in a fresh worktree). Its audio is synthesized from `demo/song.js` by its
  `predev`/`prebuild` and is gitignored.
- For real-site proof, link this checkout into a Better Lyrics checkout with the `npm link` loop in
  its CONTRIBUTING.md. That repo uses npm; this one uses pnpm.
- Core is built by `tooling/build-package.ts` with plain `tsc`, not Vite. Runtime files may import
  only their siblings, with extensionless relative specifiers (the build adds the extensions), plus
  `import type` from `@braccato/types`. The published leaves `constants`, `text`, `themeSettings`
  and `util` import nothing at all. Only self-checks may import `node:*` or `typescript`.
  `boundary.selfcheck.ts` enforces the import rules. The emit uses `types: []`, so
  ambient `chrome` or `node` types do not exist there.
- `packages/core/tsconfig.json` and `tooling/tsconfig.package.json` are deliberately self-contained.
  Do not make them extend the root config; `useDefineForClassFields` changes what `element.ts` does.
- The core build runs `tooling/check-api-docs.ts`, which fails if `demo/api.js` or the tables in
  `packages/core/README.md` name a property, attribute, event, class name, custom property, stylesheet
  or theme setting the emitted package lacks. Renaming public API breaks the build until both are
  updated; adding it should update both too.

## `@braccato/core-rs` is the Rust + WebGL2 rewrite

`packages/core-rs` renders the same lyrics as core from one canvas (see its README). It is private and
not published, so it needs no changeset, and `build:packages` (the release build) leaves it out.
Building it needs Rust with the `wasm32-unknown-unknown` target and `wasm-pack`. `scripts/run.mjs`
skips its build and test with a notice when those are missing, so the gate above still runs without
Rust; with Rust installed, check that the notice did not appear.

- `cargo test --lib` in the package covers the pure logic (song building, scroll, stage, clock).
  `cargo clippy --target wasm32-unknown-unknown` is expected to be clean.
- The shader is `src/shaders/quad.wgsl`. `build.rs` validates it with naga and writes GLSL ES 3.00
  into `OUT_DIR`, together with the uniform block and sampler names naga chose; `gpu.rs` binds by
  those generated constants, so never hard-code a `_group_0_binding_*` name. naga is a
  build-dependency only and must stay out of `[dependencies]`.
- Rust doc comments are copied into the generated JavaScript as block comments, so one containing
  `*/` breaks the glue file. Write theme settings as `blyrics-key = value;` in docs.
- Visual parity is checked on `demo/compare.html` (dev server only: the deployed demo has no Rust),
  which puts both renderers on one clock. Diff the
  two panes rather than eyeballing them; `window.compareRects()` gives the crop rectangles.
- The hidden layout DOM shares core's class names so a page's `--blyrics-*` variables reach it, which
  also means core's stylesheets do. `style.rs` therefore pins every transform, animation and
  `::before` in that DOM: anything that moves it skews the measurement.

## Tests

Core has no test runner. `pnpm selfcheck` (`tooling/run-selfchecks.ts`) finds every
`*.selfcheck.ts` under `packages/` and runs each as a standalone `tsx` script with
`node:assert`. The DOM, window and custom-element fakes live in `packages/core/src/selfcheck/`.
Parsers, highlight, provider-blyrics and rics use vitest.

Add a self-check when it pins a regression whose cause was not obvious, or tricky pure logic such as
timing, scroll or a state machine. Do not add one that restates the implementation or checks what
`tsc` already proves. Extend the nearest existing `.selfcheck.ts` before creating a file.

The node fakes have no layout or WAAPI. Real-browser checks for image highlights and letter masks are
in `tooling/browser/`; the core README explains how to run them. They need a built `dist/`, are not
part of any gate, and do not belong in the discovered self-check set.

## Attribution for agent-authored PRs

Any pull request opened by an AI agent must disclose it in the PR description, naming the model and
the person it is acting for. There is no PR template, so add the section yourself:

```markdown
## Authorship

- [x] This PR was opened by an AI agent, disclosed below.

> Opened by <model name> working on behalf of @<github-handle>.
```

Fill in the model that actually wrote the change and the GitHub handle of the person it is acting
for. Keep the line even when the human reviews and amends the work. No generated-by footers or
commit trailers are expected on top of it.
