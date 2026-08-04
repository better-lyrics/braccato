#!/bin/bash

cd "$(dirname "$0")/.."

echo -n "OTP: "
read -r OTP

# Emits every package including the @braccato/core artifact, whose build task is the same
# tooling/build-package.ts that `pnpm package` runs.
pnpm build:packages

# types first: @braccato/core and @braccato/parsers both depend on it.
for pkg in types parsers rics provider-blyrics core; do
	(cd "packages/$pkg" && pnpm publish --access public --no-git-checks --otp="$OTP" 2>&1) || echo "Skipped $pkg (already published or error)"
done

echo "Done."
