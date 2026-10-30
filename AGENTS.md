# AGENTS.md

Operating notes for AI agents working in this repo. They cover what the config files do not make
obvious; read the package READMEs for the API itself.

## There is no PR CI

`.github/workflows/release.yml` is the only workflow, and it runs on pushes to `master`. Nothing
checks a pull request on GitHub, so these local runs are the whole gate. Run them before calling
work done:

```bash
pnpm lint        # biome check, read-only; pnpm lint:fix writes
pnpm typecheck
pnpm test        # vitest, every package except core
pnpm selfcheck   # core's self-checks (see below)
pnpm build
```

Run `pnpm install` in each git worktree. In a non-interactive shell use `CI=true pnpm install`: pnpm
can stop at a hidden "reinstall from scratch?" prompt, exit 0, and leave packages without
`node_modules`, which then fails the build with `vite: not found`.

`typecheck` and `test` depend on `^build` in Turbo. Running `tsc` or `vitest` directly inside a
package fails on a missing `@braccato/types` (or `@braccato/parsers`) `dist/` until you have built
the workspace once.

## Merging to master publishes

The release workflow applies pending changesets and publishes to npm on every push to `master`.
Better Lyrics pins `@braccato/core`, `@braccato/highlight` and `@braccato/parsers` exactly and auto-merges the Dependabot
bump, so a merged change reaches its users with no further human step.

- Every change to a published package under `packages/` needs a `.changeset/*.md`. Write the body as
  user-facing prose about the behaviour, like the existing ones. Root files, tooling and `demo/`
  (ignored in `.changeset/config.json`) need none.
- Never edit package versions or `CHANGELOG.md` by hand. CI writes both in its
  `chore: version packages` commit.
- `pnpm release` is a manual OTP publish that refuses to run with pending changesets. Do not use it.
- The repo only allows squash merges. The PR title becomes the commit subject:
  `type(scope): lowercase imperative`, for example `fix(core): keep lines apart when the view scrolls far`.

## `@braccato/core` is the Better Lyrics renderer

`packages/core` is the rendering engine Better Lyrics runs on YouTube Music, moved here from
[better-lyrics/better-lyrics](https://github.com/better-lyrics/better-lyrics). Behaviour changes ship
straight into the extension, so check them against it, not only against the demo.

- The demo (`pnpm -C demo dev`, http://localhost:5173/) covers most renderer work. Its audio is
  synthesized from `demo/song.js` by its `predev`/`prebuild` and is gitignored.
- For real-site proof, link this checkout into a Better Lyrics checkout with the `npm link` loop in
  its CONTRIBUTING.md. That repo uses npm; this one uses pnpm.
- Core is built by `tooling/build-package.ts` with plain `tsc`, not Vite. Runtime files may import
  only `@braccato/types` and their siblings, with extensionless relative specifiers (the build adds
  the extensions). Only self-checks may import `node:*` or `typescript`. The emit uses `types: []`, so
  ambient `chrome` or `node` types do not exist there.
- `packages/core/tsconfig.json` and `tooling/tsconfig.package.json` are deliberately self-contained.
  Do not make them extend the root config; `useDefineForClassFields` changes what `element.ts` does.
- The core build runs `tooling/check-api-docs.ts`, which fails if `demo/api.js` or the tables in
  `packages/core/README.md` name a property, attribute, event, class name, custom property or theme
  setting the emitted package lacks. Renaming or adding public API means updating both.

## Tests

Core has no test runner. `pnpm selfcheck` (`tooling/run-selfchecks.ts`) finds every
`*.selfcheck.ts` under `packages/` and runs each as a standalone `tsx` script with
`node:assert`. The DOM, window and custom-element fakes live in `packages/core/src/selfcheck/`.
The other packages use vitest.

Add a self-check when it pins a regression whose cause was not obvious, or tricky pure logic such as
timing, scroll or a state machine. Do not add one that restates the implementation or checks what
`tsc` already proves. Extend the nearest existing `.selfcheck.ts` before creating a file.

The node fakes have no layout or WAAPI. Real-browser checks for image highlights and letter masks are
in `tooling/browser/`; the core README explains how to run them. They need a built `dist/`, are not
part of any gate, and do not belong in the discovered self-check set.

## Formatting

Biome only, with two styles. The root default is tabs. `packages/core`, `demo` and `tooling` use
2-space indents, ES5 trailing commas and bare arrow parameters, with import sorting off. CSS in core
and the demo is not formatted. Let `pnpm lint:fix` decide rather than matching by eye.

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
