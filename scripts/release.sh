#!/bin/bash

cd "$(dirname "$0")/.."

echo -n "OTP: "
read -r OTP

pnpm build:packages

# @braccato/core is published from the better-lyrics repository, not from here. See MIGRATION.md.
for pkg in parsers rics provider-blyrics; do
	(cd "packages/$pkg" && pnpm publish --access public --no-git-checks --otp="$OTP" 2>&1) || echo "Skipped $pkg (already published or error)"
done

echo "Done."
