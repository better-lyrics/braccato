#!/bin/bash
# Refuses a manual publish that would ship unversioned packages. Usage: release-guard.sh <package>...

cd "$(dirname "$0")/.."

pending=$(find .changeset -maxdepth 1 -name "*.md" ! -name "README.md" | sort)
if [ -n "$pending" ]; then
	echo "Refusing to publish: these changesets have not been applied yet:" >&2
	echo "$pending" >&2
	echo "CI versions the packages on master: pull its 'chore: version packages' commit and publish from there." >&2
	exit 1
fi

for pkg in "$@"; do
	manifest="packages/$pkg/package.json"
	name=$(node -p "require('./$manifest').name") || exit 1
	version=$(node -p "require('./$manifest').version") || exit 1
	if [ "$version" = "0.0.0" ]; then
		echo "Refusing to publish: $name is still at 0.0.0 in $manifest." >&2
		exit 1
	fi
done
