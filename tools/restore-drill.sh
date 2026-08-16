#!/bin/sh
# Restores a backup, to prove it can be restored. A backup nobody has restored is a
# belief: it dumps the database the way `tools/backup.sh` does, restores that dump
# into a scratch database beside it, compares schema and row counts against the
# source, and drops the scratch.
#
# The connection arrives in the standard libpq variables — PGHOST, PGPORT, PGUSER,
# PGPASSWORD, PGDATABASE — because every tool below reads them itself, so there is no
# connection string for this script to parse and no second spelling of it to
# disagree with the compose file. In production the `backup` service already exports
# all five and holds the matching client version:
#
#   docker compose -f docker-compose.prod.yml exec backup /opt/keel/restore-drill.sh
#
# From a checkout, against the test database:
#
#   PGHOST=localhost PGPORT=5433 PGUSER=postgres PGPASSWORD=password \
#     PGDATABASE=keel_test tools/restore-drill.sh
#
# Nothing is written to PGDATABASE. The scratch database is a full second copy of the
# data, so the server needs the room for one while the drill runs.
set -eu

: "${PGDATABASE:?is required, and names the database to drill}"

work=$(mktemp -d)
scratch="${PGDATABASE}_drill_$(date -u +%Y%m%d%H%M%S)"

# The scratch database goes away even when a step below fails. A failed drill that
# leaves a half-restored copy behind is what makes the next drill run out of disk.
trap 'dropdb --force --if-exists "$scratch" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

# One query, run against both copies, so the two answers are comparable line for
# line. `user` is quoted because it is a reserved word.
cat >"$work/counts.sql" <<'SQL'
select 'user' as name, count(*) as rows from "user"
union all select 'organization', count(*) from organization
union all select 'member', count(*) from member
union all select 'project', count(*) from project
union all select 'job', count(*) from job
order by name;
SQL

echo "drill: dumping $PGDATABASE"

KEEL_DRILL_DUMP="$work/source.dump"
KEEL_DRILL_SCHEMA="$work/source.schema.sql"
export KEEL_DRILL_DUMP KEEL_DRILL_SCHEMA

# Both dumps and the counts they are checked against come out of one snapshot: the
# transaction below exports it, `\!` runs pg_dump inside it with `--snapshot`, and
# the counts are the last thing that transaction does. Counting outside it would
# compare two instants, and on a database taking writes the rows written between the
# dump and the count read as rows the restore lost.
{
	cat <<'SQL'
begin transaction isolation level repeatable read;
select pg_export_snapshot() as snapshot \gset
\setenv KEEL_DRILL_SNAPSHOT :snapshot
\! pg_dump --format=custom --snapshot="$KEEL_DRILL_SNAPSHOT" --file="$KEEL_DRILL_DUMP"
\! pg_dump --schema-only --snapshot="$KEEL_DRILL_SNAPSHOT" --file="$KEEL_DRILL_SCHEMA"
SQL
	cat "$work/counts.sql"
	echo "commit;"
} | psql --no-psqlrc --quiet --no-align --tuples-only --set=ON_ERROR_STOP=1 >"$work/source.counts"

# `\!` reports a failing pg_dump on stderr and psql carries on regardless, so the
# dump is checked here rather than discovered missing three steps later.
if ! [ -s "$KEEL_DRILL_DUMP" ]; then
	echo "drill: pg_dump wrote no dump. Nothing was restored and nothing was changed." >&2
	exit 1
fi

echo "drill: restoring into $scratch"
createdb "$scratch"
pg_restore --dbname="$scratch" --exit-on-error "$KEEL_DRILL_DUMP"

pg_dump --schema-only --dbname="$scratch" --file="$work/scratch.schema.sql"

# pg_dump 18 opens and closes a plain dump with `\restrict <token>` / `\unrestrict
# <token>`, psql's guard against a dump replayed with meta-commands injected. The
# token is minted per dump and is not schema, so neither side is compared on it.
strip='/^\\restrict /d;/^\\unrestrict /d'
sed "$strip" "$KEEL_DRILL_SCHEMA" >"$work/source.schema"
sed "$strip" "$work/scratch.schema.sql" >"$work/scratch.schema"

if ! diff -u "$work/source.schema" "$work/scratch.schema"; then
	echo "drill: the restored schema is not the schema that was dumped." >&2
	exit 1
fi

psql --no-psqlrc --quiet --no-align --tuples-only --dbname="$scratch" \
	--file="$work/counts.sql" >"$work/scratch.counts"

if ! diff -u "$work/source.counts" "$work/scratch.counts"; then
	echo "drill: the restored copy does not hold the rows the dump was taken from." >&2
	exit 1
fi

awk -F'|' '{ printf "  %-14s %s rows\n", $1, $2 }' "$work/source.counts"
echo "drill: schema identical, rows identical, from a $(du -h "$KEEL_DRILL_DUMP" | cut -f1) dump"

dropdb --force "$scratch"
echo "drill: dropped $scratch"
