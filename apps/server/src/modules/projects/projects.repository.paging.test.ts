import { describe, expect, it } from "bun:test";
import { seedOrganization, skipNotice, testDbReady } from "../../../test-db";
import { insert, listByOrganization } from "./projects.repository";

const PAGE = { cursor: null, limit: 25 };

/** Rows for one organization, created concurrently: nothing below depends on the
 * order they went in, only on the order the query promises. */
const seedProjects = (organizationId: string, count: number) =>
	Promise.all(
		Array.from({ length: count }, () =>
			insert({
				createdBy: null,
				description: null,
				name: "Seeded",
				organizationId,
				slug: crypto.randomUUID(),
			})
		)
	);

/**
 * The published order — `created_at` descending, id as the tiebreak — restated
 * here so the expectation is derived from the rows the test actually created
 * rather than from a second copy of the query. Rows seeded concurrently can
 * share a millisecond, which is exactly the case the tiebreak exists for and
 * the reason this cannot be a plain insertion-order array.
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
	process.stdout.write(skipNotice("projects.repository paging"));
}

/**
 * Keyset pagination against real Postgres. Split from the lifecycle suite
 * because these tests share the seeding and ordering helpers above and nothing
 * else does.
 */
describe.skipIf(!ready)("projects.repository paging", () => {
	it("lists only the organization's rows, newest first", async () => {
		const organizationId = await seedOrganization();
		const ours = await seedProjects(organizationId, 3);
		await seedProjects(await seedOrganization(), 2);

		const found = await listByOrganization(organizationId, PAGE);

		expect(found.map((item) => item.id)).toEqual(newestFirst(ours));
	});

	// The probe row is what tells the service another page exists, so the query
	// must overshoot by exactly one and never by more.
	it("fetches one row beyond the limit, and stops there", async () => {
		const organizationId = await seedOrganization();
		await seedProjects(organizationId, 4);

		expect(
			await listByOrganization(organizationId, { cursor: null, limit: 2 })
		).toHaveLength(3);
		expect(
			await listByOrganization(organizationId, { cursor: null, limit: 9 })
		).toHaveLength(4);
	});

	/**
	 * The property that matters: walking the cursor two rows at a time
	 * reproduces the published order exactly — no row returned twice, none
	 * skipped — while a second organization's rows sit in the same table and in
	 * the same milliseconds, and must stay invisible throughout.
	 *
	 * Recursive rather than a loop because each request needs the cursor from
	 * the response before it; there is nothing here to run concurrently.
	 */
	it("pages through every row exactly once", async () => {
		const organizationId = await seedOrganization();
		const [ours] = await Promise.all([
			seedProjects(organizationId, 7),
			seedProjects(await seedOrganization(), 3),
		]);

		const walk = async (
			cursor: { createdAt: Date; id: string } | null,
			seen: string[]
		): Promise<string[]> => {
			const rows = await listByOrganization(organizationId, {
				cursor,
				limit: 2,
			});
			const items = rows.slice(0, 2);
			const ids = [...seen, ...items.map((item) => item.id)];
			const last = items.at(-1);

			return rows.length > 2 && last
				? await walk({ createdAt: last.createdAt, id: last.id }, ids)
				: ids;
		};

		expect(await walk(null, [])).toEqual(newestFirst(ours));
	});
});
