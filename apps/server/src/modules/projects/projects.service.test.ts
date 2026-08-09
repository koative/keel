import { beforeEach, describe, expect, it } from "bun:test";
import { parseError } from "evlog";
import {
	type FakeLog,
	type FakeStore,
	fakeContext,
	fakeLog,
	fakeStore,
	projectRow,
} from "./projects.fixtures";
import { createProject, getProject, listProjects } from "./projects.service";

/**
 * Paging, normalisation and not-found behaviour. The tenancy rules the same
 * calls enforce are in `projects.service.tenancy.test.ts`, which seeds two
 * organizations where these tests only ever need one.
 */

let store: FakeStore;
let logger: FakeLog;
const ctx = () => fakeContext(store, logger);

beforeEach(() => {
	store = fakeStore();
	logger = fakeLog();
});

/** Distinct timestamps, newest last, so the expected order is unambiguous. */
const rows = (count: number) =>
	Array.from({ length: count }, (_, index) =>
		projectRow({
			createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
			id: `p${index}`,
		})
	);

describe("list", () => {
	it("returns at most the requested limit, never the probe row", async () => {
		store = fakeStore(rows(5));

		const found = await listProjects({ cursor: null, limit: 2 }, ctx());

		expect(found.items.map((item) => item.id)).toEqual(["p4", "p3"]);
	});

	it("reports a next cursor pointing at the last returned row", async () => {
		store = fakeStore(rows(5));

		const found = await listProjects({ cursor: null, limit: 2 }, ctx());

		expect(found.nextCursor).toEqual({
			createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 3)),
			id: "p3",
		});
	});

	// The store is asked for limit + 1 rows; a short answer is the last page. A
	// full page whose successor is empty must not advertise a further page.
	it.each([
		[3, 3, null],
		[3, 4, "p1"],
	])(
		"over %p rows with limit %p reports nextCursor %p",
		async (limit, seeded, expected) => {
			store = fakeStore(rows(seeded));

			const found = await listProjects({ cursor: null, limit }, ctx());

			expect(found.nextCursor?.id ?? null).toBe(expected);
		}
	);

	it("hands the cursor to the store untouched", async () => {
		store = fakeStore(rows(5));
		const cursor = {
			createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 3)),
			id: "p3",
		};

		const found = await listProjects({ cursor, limit: 2 }, ctx());

		expect(store.calls.pages).toEqual([{ cursor, limit: 2 }]);
		expect(found.items.map((item) => item.id)).toEqual(["p2", "p1"]);
	});
});

describe("create", () => {
	it.each([
		["My-Project", "my-project"],
		["  billing  ", "billing"],
		["BILLING", "billing"],
	])(
		"normalises %p to %p before the uniqueness check",
		async (given, expected) => {
			await createProject(
				{ description: null, name: "Billing", slug: given },
				ctx()
			);

			expect(store.calls.inserted[0]?.slug).toBe(expected);
		}
	);

	it("records the created project on the wide event", async () => {
		await createProject(
			{ description: null, name: "Billing", slug: "billing" },
			ctx()
		);

		expect(logger.fields).toEqual([{ project: { id: "p1", slug: "billing" } }]);
	});
});

describe("get", () => {
	it("returns a project from the active organization", async () => {
		store = fakeStore([projectRow({ id: "ours" })]);

		expect((await getProject("ours", ctx())).id).toBe("ours");
	});

	it("reports a missing project as a 404", async () => {
		const thrown = await getProject("ghost", ctx()).catch(
			(error: unknown) => error
		);
		const parsed = parseError(thrown);

		expect(parsed.status).toBe(404);
		expect(parsed.message).toBe("Project not found");
	});
});
