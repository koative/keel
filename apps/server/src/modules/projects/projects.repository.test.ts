import { describe, expect, it } from "bun:test";
import { parseError } from "evlog";
import {
	deleteUser,
	seedOrganization,
	seedUser,
	skipNotice,
	testDbReady,
} from "../../../test-db";
import {
	deleteById,
	findById,
	insert,
	listByOrganization,
} from "./projects.repository";

const UUID = /^[0-9a-f-]{36}$/;

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("projects.repository"));
}

/**
 * Integration, against real Postgres. Drizzle is not mocked: the thing under
 * test is whether the query is correct, and a mock would only assert that the
 * query builder was called the way this file already assumes.
 *
 * Keyset pagination has its own suite next door; this one covers the row
 * lifecycle and the tenancy filter every statement carries.
 */
describe.skipIf(!ready)("projects.repository", () => {
	it("round-trips a row with server-side defaults", async () => {
		const [organizationId, createdBy] = await Promise.all([
			seedOrganization(),
			seedUser(),
		]);

		const created = await insert({
			createdBy,
			description: "Invoices",
			name: "Billing",
			organizationId,
			slug: "billing",
		});

		expect(created.id).toMatch(UUID);
		expect(created.createdBy).toBe(createdBy);
		expect(created.createdAt).toBeDate();
		expect(created.updatedAt).toBeDate();
		expect(await findById(created.id, organizationId)).toEqual(created);
	});

	it("returns undefined rather than throwing for a missing id", async () => {
		expect(
			await findById(crypto.randomUUID(), await seedOrganization())
		).toBeUndefined();
	});

	// The tenancy filter is the whole reason the service can answer 404 without
	// comparing anything: a row from another organization is simply not returned,
	// so "forbidden" is never a state the layer above can observe.
	it("hides a row belonging to another organization", async () => {
		const organizationId = await seedOrganization();
		const created = await insert({
			createdBy: null,
			description: null,
			name: "Theirs",
			organizationId,
			slug: "theirs",
		});

		expect(
			await findById(created.id, await seedOrganization())
		).toBeUndefined();
	});

	/**
	 * The list needs its own case, and it is the more important of the two. Dropping
	 * the tenancy predicate from `findById` breaks a test; dropping it from
	 * `listByOrganization` broke nothing, because every other tenancy test reads a
	 * single row by id. A collection endpoint is also the worse leak: one request
	 * returns every tenant's rows rather than one guessed id.
	 */
	it("lists only the asking organization's rows", async () => {
		const [mine, theirs] = await Promise.all([
			seedOrganization(),
			seedOrganization(),
		]);
		await insert({
			createdBy: null,
			description: null,
			name: "Mine",
			organizationId: mine,
			slug: "mine",
		});
		await insert({
			createdBy: null,
			description: null,
			name: "Theirs",
			organizationId: theirs,
			slug: "theirs",
		});

		const rows = await listByOrganization(mine, { cursor: null, limit: 25 });

		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("Mine");
	});

	it("refuses to delete a row belonging to another organization", async () => {
		const organizationId = await seedOrganization();
		const created = await insert({
			createdBy: null,
			description: null,
			name: "Theirs",
			organizationId,
			slug: "theirs",
		});

		await deleteById(created.id, await seedOrganization());

		expect(await findById(created.id, organizationId)).toEqual(created);
	});

	// `createdBy` is `set null`, not `cascade`: a member leaving must not take the
	// organization's work with them.
	it("keeps the row when the member who created it is removed", async () => {
		const [organizationId, createdBy] = await Promise.all([
			seedOrganization(),
			seedUser(),
		]);
		const created = await insert({
			createdBy,
			description: null,
			name: "Billing",
			organizationId,
			slug: "billing",
		});

		await deleteUser(createdBy);

		expect(await findById(created.id, organizationId)).toMatchObject({
			createdBy: null,
			id: created.id,
		});
	});

	// The same slug under a different organization must be allowed: two tenants
	// may both want "billing". That is why the constraint is composite.
	it("allows the same slug in a different organization", async () => {
		const [organizationId, otherId] = await Promise.all([
			seedOrganization(),
			seedOrganization(),
		]);
		const billing = {
			createdBy: null,
			description: null,
			name: "Billing",
			slug: "billing",
		};

		await insert({ ...billing, organizationId });

		expect((await insert({ ...billing, organizationId: otherId })).slug).toBe(
			"billing"
		);
	});

	it("turns a duplicate slug into a 409 instead of letting the driver error escape", async () => {
		const organizationId = await seedOrganization();
		await insert({
			createdBy: null,
			description: null,
			name: "Billing",
			organizationId,
			slug: "billing",
		});

		const thrown = await insert({
			createdBy: null,
			description: null,
			name: "Billing again",
			organizationId,
			slug: "billing",
		}).catch((error: unknown) => error);
		const parsed = parseError(thrown);

		expect(parsed.status).toBe(409);
		expect(parsed.code).toBe("CONFLICT");
		expect(parsed.fix).toBe("Choose a different slug");
	});

	it("deletes by id", async () => {
		const organizationId = await seedOrganization();
		const created = await insert({
			createdBy: null,
			description: null,
			name: "Billing",
			organizationId,
			slug: "billing",
		});

		await deleteById(created.id, organizationId);

		expect(await findById(created.id, organizationId)).toBeUndefined();
	});
});
