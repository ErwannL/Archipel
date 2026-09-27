#!/bin/sh
# Repository rules enforced in CI:
#  - no tracked file longer than 1000 lines (lockfile excepted: generated),
#  - a README.md in every directory holding tracked files,
#  - no coverage-exclusion pragma or lint suppression anywhere in code.
set -eu
status=0
for f in $(git ls-files | grep -v '^package-lock.json$'); do
  n=$(wc -l < "$f")
  if [ "$n" -gt 1000 ]; then echo "too long ($n lines): $f"; status=1; fi
done
for d in $(git ls-files | xargs -n1 dirname | sort -u); do
  if [ ! -f "$d/README.md" ]; then echo "missing README.md in: $d"; status=1; fi
done
if git grep -nIiE '(istanbul|c8|v8) ignore|pragma: no cover|eslint-disable|@ts-ignore|@ts-nocheck' -- '*.ts' '*.js' '*.mjs'; then
  echo 'forbidden pragma found'; status=1
fi
exit $status
