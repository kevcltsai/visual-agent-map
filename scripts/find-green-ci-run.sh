#!/bin/sh
# Print the id of a successful ci.yml run for the given commit sha and exit 0; otherwise exit 1.
# Fail-closed: a missing/unauthenticated `gh`, a query error, or no matching run all exit 1 (caller runs the full verify).
# `GH_BIN` overrides the gh executable (used by tests with a fake gh).
sha="$1"
[ -n "$sha" ] || exit 1
gh_bin="${GH_BIN:-gh}"
command -v "$gh_bin" >/dev/null 2>&1 || exit 1
out=$("$gh_bin" run list --commit "$sha" --workflow ci.yml --status success --limit 1 --json databaseId,headSha --jq ".[] | select(.headSha == \"$sha\") | .databaseId" 2>/dev/null) || exit 1
id=$(printf '%s\n' "$out" | head -n 1)
case "$id" in
  ''|*[!0-9]*) exit 1 ;;
esac
printf '%s\n' "$id"
