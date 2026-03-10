#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo -n "OTP: "
read -r OTP

pnpm build:packages

cd packages/parsers && npm publish --access public --otp="$OTP" && cd ../..
cd packages/rics && npm publish --access public --otp="$OTP" && cd ../..
cd packages/provider-blyrics && npm publish --access public --otp="$OTP" && cd ../..
cd packages/core && npm publish --access public --otp="$OTP" && cd ../..

echo "Published all packages."
