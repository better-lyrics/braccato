#!/bin/bash

cd "$(dirname "$0")/.."

echo -n "OTP: "
read -r OTP

# Emits every package including the @braccato/core artifact, whose build task is the same
# tooling/build-package.ts that `pnpm package` runs.
pnpm build:packages

# types first: @braccato/core and @braccato/parsers both depend on it.
for pkg in types parsers rics provider-blyrics; do
	(cd "packages/$pkg" && pnpm publish --access public --no-git-checks --otp="$OTP" 2>&1) || echo "Skipped $pkg (already published or error)"
done

# @braccato/core last, and not from packages/core, whose package.json is private and exists only to
# make the directory a workspace member. The manifest that goes to npm is generated beside the code.
(cd packages/core/dist/package && npm publish --access public --otp="$OTP" 2>&1) || echo "Skipped core (already published or error)"

echo "Done."
