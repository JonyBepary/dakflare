#!/usr/bin/env bash
#
# Prove that migrations/*.sql produce the schema production already has.
#
# The baseline was dumped from a deployment that ran the eleven migrations it
# replaced, and every migration after it is additive. This script checks that
# claim instead of trusting it: it applies every migration in order to a scratch
# SQLite database and diffs `sqlite_master` against the real one. An empty diff
# means the two agree object for object.
#
# Applying ALL of them, not just the baseline, is what keeps the check honest
# after 0002: comparing production against 0001 alone would report every v6 table
# as a difference and then be ignored, which is how a parity check dies.
#
#   worker/scripts/verify-baseline.sh <d1-database-id>
#
# Requires `cf` (authenticated) and `sqlite3`.
set -euo pipefail

DB_ID="${1:-}"
if [ -z "$DB_ID" ]; then
  echo "usage: $0 <d1-database-id>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="$HERE/../migrations"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

QUERY="SELECT type, name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
          AND name != 'd1_migrations'
        ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"

# One formatter for both sides: `sqlite3 -json` and `cf` disagree about shape,
# and a diff of two different shapes reports every object as different.
# `cf` wraps its rows in `[{"results": [...]}]`; `sqlite3 -json` returns a bare
# array. One formatter that unwraps either, so the diff compares schema text.
FORMAT='import sys,json
raw = sys.stdin.read()
i = raw.find("[")
data = json.loads(raw[i:])
rows = data[0]["results"] if data and isinstance(data[0], dict) and "results" in data[0] else data
for row in rows:
    print(row["sql"].strip().rstrip(";") + ";")'

cf d1 query "$DB_ID" --sql "$QUERY" | python3 -c "$FORMAT" > "$WORK/prod.sql"

# Sorted, so 0001 runs before 0002. `glob` order is not guaranteed to be sorted
# on every filesystem, and a migration applied out of order fails on a missing
# table rather than on anything readable.
for migration in "$MIGRATIONS_DIR"/*.sql; do
  sqlite3 "$WORK/base.db" < "$migration"
done
sqlite3 -json "$WORK/base.db" "$QUERY" | python3 -c "$FORMAT" > "$WORK/base.sql"

if diff -q "$WORK/prod.sql" "$WORK/base.sql" >/dev/null; then
  echo "migrations match production ($(grep -c 'CREATE' "$WORK/base.sql") objects)"
else
  echo "migrations do NOT match production:" >&2
  diff "$WORK/prod.sql" "$WORK/base.sql" >&2
  exit 1
fi
