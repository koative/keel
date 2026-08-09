import { db } from "@keel/db";
import { user } from "@keel/db/schema/auth";
import { sql } from "drizzle-orm";

/**
 * Integration tests need a real Postgres, and a developer without Docker running
 * should still get a green `bun test` for everything else. Tests that need the
 * database gate on this and announce the skip loudly rather than silently
 * reporting success.
 *
 * Start it with `bun run db:test:start && bun run db:test:migrate`.
 */
export async function testDbReady(): Promise<boolean> {
	try {
		const result = await db.execute(
			sql`select to_regclass('public.project') is not null as ready`
		);
		return result.rows[0]?.ready === true;
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
