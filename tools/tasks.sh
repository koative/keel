#!/bin/sh
# What the `tasks` service in docker-compose.prod.yml runs: `bun dist/tasks.mjs` every
# $1 minutes, from the image's own working directory.
#
# A sleep loop rather than cron, the same answer `tools/backup.sh` gives: the runtime
# image ships no cron daemon, installing one at startup puts a package download in
# front of the first sweep, and a second scheduling mechanism beside the first is one
# more place the schedule can be wrong. The loop is one process doing one thing,
# compose restarts it, and the interval is its whole schedule.
#
# It sweeps first and sleeps after, so a deploy reclaims the jobs the previous one
# stranded on its way down instead of leaving them for one interval.
#
# The interval arrives as an argument rather than in the environment because every
# service in that file passes `environment: *app-env` unchanged, and `@keel/env`
# declares no schedule for it to carry — the app reads the interval nowhere, only this
# loop does.
set -eu

# Compose refuses the deploy when the variable behind this argument is unset, naming
# it. What compose cannot check is the shape, and a non-number reaches `sleep` as a
# broken arithmetic expression: the container exits, the restart policy brings it
# back, and a typo reads as flapping.
interval_minutes=${1:-}

case "$interval_minutes" in
'' | 0 | *[!0-9]*)
	echo "tasks: the only argument is the interval in minutes, a whole number above zero — got '$interval_minutes'." >&2
	exit 1
	;;
esac

while :; do
	# `dist/tasks.mjs` exits non-zero when a sweep failed, having already named which
	# one on stderr. The loop stays alive on purpose, the way backup.sh stays alive on
	# a failed dump: exiting hands this to the restart policy, which sweeps again
	# immediately against a database that is already refusing and buries the first
	# error under a hundred copies of it. Every statement the sweep runs is
	# idempotent, so the only cost of waiting one interval is that interval.
	bun dist/tasks.mjs || echo "tasks: run failed, next run in ${interval_minutes}m" >&2

	sleep "$((interval_minutes * 60))"
done
