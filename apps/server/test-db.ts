import { db } from "@keel/db";
import { user } from "@keel/db/schema/auth";
import { job } from "@keel/db/schema/job";
import { member, organization } from "@keel/db/schema/organization";
import { eq, inArray, sql } from "drizzle-orm";
import { type ClaimedJob, claim } from "@/lib/jobs.repository";

/**
 * Claims until the given row comes back, then puts every other row back.
 *
 * One claim is not enough for any suite that asserts its own row was taken.
 * `claim` is global and orders by `run_at`, so a row whose `run_at` is recent is
 * last in line — a freshly enqueued one, or one the reaper requeued, since that
 * sets `run_at = now()`. Every older due row is claimed first, and a single
 * batch misses the row entirely once `limit` others are waiting, which is what a
 * concurrent suite or an interrupted run leaves behind.
 *
 * The rows this walks past belong to other suites, and `claim` leaves what it
 * takes `running` under this worker. Draining without undoing that is how a run
 * strands a peer's row: nothing here hands it to a handler, no reaper runs in a
 * test database, and the next suite to claim finds it gone. So the passed-over
 * ids are collected and released in one statement at the end — only at the end,
 * because releasing a row before the target is found puts it straight back in
 * front of the next claim and the drain never terminates. `claim` writes only
 * `status`, `locked_by` and `locked_at`, so restoring those three is exact:
 * `attempts` was never spent and `run_at` still holds the row's place in line.
 */
export async function claimUntilFound(
	id: string,
	workerId: string,
	limit: number
): Promise<ClaimedJob | undefined> {
	const passedOver: string[] = [];
	let mine: ClaimedJob | undefined;
	let batch = await claim(workerId, limit);

	while (batch.length > 0) {
		mine = batch.find((entry) => entry.id === id);
		for (const entry of batch) {
			if (entry.id !== id) {
				passedOver.push(entry.id);
			}
		}
		if (mine !== undefined) {
			break;
		}

		// biome-ignore lint/performance/noAwaitInLoops: each claim has to see what the previous one moved out of `pending`; overlapping claims would read the same rows and never drain.
		batch = await claim(workerId, limit);
	}

	if (passedOver.length > 0) {
		await db
			.update(job)
			.set({ lockedAt: null, lockedBy: null, status: "pending" })
			.where(inArray(job.id, passedOver));
	}

	return mine;
}

/**
 * Whether a table is present, which is what a suite for a table that does not
 * exist yet gates on. `to_regclass` accepts a name that was never created and
 * returns null, so this asks without throwing. The name is qualified because an
 * unqualified one is resolved through the session's `search_path`.
 */
export async function tableExists(name: string): Promise<boolean> {
	const result = await db.execute(
		sql`select to_regclass(${`public.${name}`}) is not null as present`
	);
	return result.rows[0]?.present === true;
}

/**
 * Integration tests need a real Postgres, and a developer without Docker running
 * should still get a green `bun test` for everything else. Tests that need the
 * database gate on this and announce the skip loudly rather than silently
 * reporting success.
 *
 * `project` is the probe table: it has existed since the first migration, so its
 * presence answers "is this database migrated at all?".
 *
 * Start it with `bun run db:test:start && bun run db:test:migrate`.
 */
export async function testDbReady(): Promise<boolean> {
	try {
		return await tableExists("project");
	} catch {
		return false;
	}
}

export const skipNotice = (suite: string) =>
	`\n[skip] ${suite} needs the test database.\n        bun run db:test:start && bun run db:test:migrate\n`;

/**
 * Every test owns its own user, so suites never contend over rows and no test
 * has to truncate a table another test is reading.
 */
export async function seedUser(): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(user).values({
		email: `${id}@keel.test`,
		id,
		name: "Test Owner",
	});
	return id;
}

/**
 * The tenant every tenant-scoped row hangs off. Like `seedUser`, each caller gets
 * a fresh one so suites never contend; `slug` is a UUID because the column is
 * unique and the value is never read back.
 */
export async function seedOrganization(): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(organization).values({
		id,
		name: "Test Org",
		slug: id,
	});
	return id;
}

/**
 * The row that makes a user a member, and therefore the row `requireOrg` reads to
 * authorize a request. Seeded separately from the organization because the
 * interesting case is the one where it is ABSENT while a session still points at
 * the tenant — which is exactly how a removed member used to keep access.
 */
export async function seedMember(
	organizationId: string,
	userId: string,
	role = "member"
): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(member).values({ id, organizationId, role, userId });
	return id;
}

/**
 * Removing a member is the event `project.createdBy` is nullable for, so a test
 * that asserts the organization keeps its work needs to be able to stage it.
 */
export async function deleteUser(id: string): Promise<void> {
	await db.delete(user).where(eq(user.id, id));
}
