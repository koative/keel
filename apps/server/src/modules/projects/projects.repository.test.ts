import { describe, expect, it } from "bun:test";
import { parseError } from "evlog";
import { seedUser, skipNotice, testDbReady } from "../../../test-db";
import {
	deleteById,
	findById,
	insert,
	listByOwner,
} from "./projects.repository";

const UUID = /^[0-9a-f-]{36}$/;
const PAGE = { cursor: null, limit: 25 };

/** Rows for one owner, created concurrently: nothing below depends on the order
 * they went in, only on the order the query promises. */
const seedProjects = (ownerId: string, count: number) =>
	Promise.all(
		Array.from({ length: count }, () =>
			insert({
				description: null,
				name: "Seeded",
				ownerId,
				slug: crypto.randomUUID(),
			})
		)
	);

/**
 * The published order — `created_at` descending, id as the tiebreak — restated
 * here rather than read back out of the query, so an assertion cannot pass by
 * simply echoing whatever the SQL did.
 *
 * The tiebreak is the common case, not a corner case: `created_at` is compared
 * at millisecond resolution and concurrent inserts share a millisecond often.
 */
const newestFirst = (rows: { createdAt: Date; id: string }[]) =>
	[...rows]
		.sort(
			(a, b) =>
				b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)
		)
		.map((row) => row.id);

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("projects.repository"));
}

/**
 * Integration, against real Postgres. Drizzle is not mocked: the thing under
 * test is whether the query is correct, and a mock would only assert that the
 * query builder was called the way this file already assumes.
 */
describe.skipIf(!ready)("projects.repository", () => {
	it("round-trips a row with server-side defaults", async () => {
		const ownerId = await seedUser();

		const created = await insert({
			description: "Invoices",
			name: "Billing",
			ownerId,
			slug: "billing",
		});

		expect(created.id).toMatch(UUID);
		expect(created.createdAt).toBeDate();
		expect(created.updatedAt).toBeDate();
		expect(await findById(created.id)).toEqual(created);
	});

	it("returns undefined rather than throwing for a missing id", async () => {
		expect(await findById(crypto.randomUUID())).toBeUndefined();
	});

	it("lists only the owner's rows, newest first", async () => {
		const ownerId = await seedUser();
		const mine = await seedProjects(ownerId, 3);
		await seedProjects(await seedUser(), 2);

		const found = await listByOwner(ownerId, PAGE);

		expect(found.map((item) => item.id)).toEqual(newestFirst(mine));
	});

	// The probe row is what tells the service another page exists, so the query
	// must overshoot by exactly one and never by more.
	it("fetches one row beyond the limit, and stops there", async () => {
		const ownerId = await seedUser();
		await seedProjects(ownerId, 4);

		expect(await listByOwner(ownerId, { cursor: null, limit: 2 })).toHaveLength(
			3
		);
		expect(await listByOwner(ownerId, { cursor: null, limit: 9 })).toHaveLength(
			4
		);
	});

	/**
	 * The property that matters: walking the cursor two rows at a time
	 * reproduces the published order exactly — no row returned twice, none
	 * skipped — while a second owner's rows sit in the same table and in the
	 * same milliseconds, and must stay invisible throughout.
	 *
	 * Recursive rather than a loop because each request needs the cursor from
	 * the response before it; there is nothing here to run concurrently.
	 */
	it("pages through every row exactly once", async () => {
		const ownerId = await seedUser();
		const [mine] = await Promise.all([
			seedProjects(ownerId, 7),
			seedProjects(await seedUser(), 3),
		]);

		const walk = async (
			cursor: { createdAt: Date; id: string } | null,
			seen: string[]
		): Promise<string[]> => {
			const rows = await listByOwner(ownerId, { cursor, limit: 2 });
			const items = rows.slice(0, 2);
			const ids = [...seen, ...items.map((item) => item.id)];
			const last = items.at(-1);

			return rows.length > 2 && last
				? await walk({ createdAt: last.createdAt, id: last.id }, ids)
				: ids;
		};

		expect(await walk(null, [])).toEqual(newestFirst(mine));
	});

	// The same slug under a different owner must be allowed: two tenants may both
	// want "billing". That is why the constraint is composite.
	it("allows the same slug for a different owner", async () => {
		const ownerId = await seedUser();
		const otherId = await seedUser();

		await insert({
			description: null,
			name: "Billing",
			ownerId,
			slug: "billing",
		});

		expect(
			(
				await insert({
					description: null,
					name: "Billing",
					ownerId: otherId,
					slug: "billing",
				})
			).slug
		).toBe("billing");
	});

	it("turns a duplicate slug into a 409 instead of letting the driver error escape", async () => {
		const ownerId = await seedUser();
		await insert({
			description: null,
			name: "Billing",
			ownerId,
			slug: "billing",
		});

		const thrown = await insert({
			description: null,
			name: "Billing again",
			ownerId,
			slug: "billing",
		}).catch((error: unknown) => error);
		const parsed = parseError(thrown);

		expect(parsed.status).toBe(409);
		expect(parsed.code).toBe("CONFLICT");
		expect(parsed.fix).toBe("Choose a different slug");
	});

	it("deletes by id", async () => {
		const ownerId = await seedUser();
		const created = await insert({
			description: null,
			name: "Billing",
			ownerId,
			slug: "billing",
		});

		await deleteById(created.id);

		expect(await findById(created.id)).toBeUndefined();
	});
});
