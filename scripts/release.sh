#!/bin/bash

cd "$(dirname "$0")/.."

echo -n "OTP: "
read -r OTP

pnpm build:packages

for pkg in parsers rics provider-blyrics core; do
	(cd "packages/$pkg" && npm publish --access public --otp="$OTP" 2>&1) || echo "Skipped $pkg (already published or error)"
done

echo "Done."
