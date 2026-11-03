#!/bin/sh
# Print the id of a successful FULL ci.yml run for the given commit sha and exit 0; otherwise exit 1.
# Only a full run counts: ci.yml names its runs "CI full ..." (push to main, or workflow_dispatch with full=true) or "CI affected ..."
# (branch pushes that run only the tests a change can reach). An affected run never authorises skipping verify.
# Fail-closed: a missing/unauthenticated `gh`, a query error, or no matching run all exit 1 (caller runs the full verify).
# `GH_BIN` overrides the gh executable (used by tests with a fake gh).
sha="$1"
[ -n "$sha" ] || exit 1
gh_bin="${GH_BIN:-gh}"
command -v "$gh_bin" >/dev/null 2>&1 || exit 1
out=$("$gh_bin" run list --commit "$sha" --workflow ci.yml --status success --limit 50 --json databaseId,headSha,displayTitle --jq '.[] | [.databaseId, .headSha, .displayTitle] | @tsv' 2>/dev/null) || exit 1
id=$(printf '%s\n' "$out" | awk -F '\t' -v sha="$sha" '$2 == sha && index($3, "CI full") == 1 { print $1; exit }')
case "$id" in
  ''|*[!0-9]*) exit 1 ;;
esac
printf '%s\n' "$id"
