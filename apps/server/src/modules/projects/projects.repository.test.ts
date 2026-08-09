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
		const otherId = await seedUser();

		const first = await insert({
			description: null,
			name: "One",
			ownerId,
			slug: "one",
		});
		const second = await insert({
			description: null,
			name: "Two",
			ownerId,
			slug: "two",
		});
		await insert({
			description: null,
			name: "Theirs",
			ownerId: otherId,
			slug: "one",
		});

		const found = await listByOwner(ownerId);

		expect(found.map((item) => item.id)).toEqual([second.id, first.id]);
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
