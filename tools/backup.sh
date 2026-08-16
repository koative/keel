#!/bin/sh
# What the `backup` service in docker-compose.prod.yml runs: a logical dump of
# PGDATABASE every BACKUP_INTERVAL_HOURS into /backups, then delete every dump older
# than BACKUP_RETENTION_DAYS.
#
# A sleep loop rather than cron. The postgres image ships no cron daemon, and
# installing one at startup puts a package download in the path of the backup. The
# loop is one process doing one thing, compose restarts it, and the interval is its
# whole schedule — nothing to read out of a crontab to know when the next dump is.
#
# It dumps first and sleeps after, so a deploy has a backup within seconds rather
# than one interval later.
#
# This is not point-in-time recovery: everything written between two dumps is lost
# on a restore, and the interval is exactly that window. `tools/restore-drill.sh`
# rehearses the restore; the README says what the dumps do not cover.
set -eu

# Compose refuses the deploy when either is unset, naming it. What compose cannot
# check is the shape, and a non-number reaches `sleep` as a broken expression: the
# container exits, the restart policy brings it back, and a typo reads as flapping.
for setting in \
	"BACKUP_INTERVAL_HOURS=${BACKUP_INTERVAL_HOURS:?is required}" \
	"BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:?is required}"; do
	case "${setting#*=}" in
	'' | *[!0-9]*)
		echo "backup: ${setting%%=*} must be a whole number, not '${setting#*=}'." >&2
		exit 1
		;;
	esac
done

: "${PGDATABASE:?is required, and names the database to dump}"

# Every dump holds every row, so it is not a file the volume should hand out at
# 0644 to anything else that mounts it.
umask 077

# A dump is written as `.partial` and renamed on success, so a file with a `.dump`
# name is always a complete one — a redeploy in the middle of a dump would otherwise
# leave something that looks restorable and is not. Which means a killed run can
# leave its partial behind, and this is the run that replaces it.
rm -f /backups/*.dump.partial

while :; do
	stamp=$(date -u +%Y%m%dT%H%M%SZ)
	dump="/backups/${PGDATABASE}-${stamp}.dump"

	# Custom format, not plain SQL: it is compressed, and `pg_restore` can read one
	# table out of it. A plain dump can only be replayed whole, into a database that
	# already matches what it assumes.
	if pg_dump --format=custom --file="${dump}.partial"; then
		mv "${dump}.partial" "$dump"
		echo "backup: wrote $dump ($(du -h "$dump" | cut -f1))"

		# Pruned only after a dump succeeded. Retention on its own timer would empty
		# the volume during an outage: a week of failed dumps and the last good copy
		# is deleted with nothing to replace it. `-mtime +N` counts whole 24-hour
		# periods, so a horizon of N keeps a little more than N days.
		find /backups -maxdepth 1 -name '*.dump' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete
	else
		rm -f "${dump}.partial"
		# The loop stays alive on purpose. Exiting hands this to the restart policy,
		# which dumps again immediately — hammering a database that is already
		# refusing, and burying the first error under a hundred copies of it.
		echo "backup: pg_dump failed, no dump for ${stamp}" >&2
	fi

	sleep "$((BACKUP_INTERVAL_HOURS * 3600))"
done
