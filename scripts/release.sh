#!/bin/bash

cd "$(dirname "$0")/.."

# types first: @braccato/core and @braccato/parsers both depend on it.
PACKAGES=(types parsers highlight rics provider-blyrics core)

bash scripts/release-guard.sh "${PACKAGES[@]}" || exit 1

echo -n "OTP: "
read -r OTP

# Emits every package including the @braccato/core artifact, whose build task is the same
# tooling/build-package.ts that `pnpm package` runs.
pnpm build:packages

for pkg in "${PACKAGES[@]}"; do
	(cd "packages/$pkg" && pnpm publish --access public --no-git-checks --otp="$OTP" 2>&1) || echo "Skipped $pkg (already published or error)"
done

echo "Done."
