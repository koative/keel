import { beforeEach, describe, expect, it } from "bun:test";
import { parseError } from "evlog";
import {
	ACTOR,
	type FakeLog,
	type FakeStore,
	fakeContext,
	fakeLog,
	fakeStore,
	ORGANIZATION,
	OTHER_ORGANIZATION,
	projectRow,
} from "./projects.fixtures";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
} from "./projects.service";

/**
 * What the service does with the tenant on the context: every call is confined
 * to it, and another organization's row is invisible rather than refused.
 *
 * Kept apart from `projects.service.test.ts` because these are the only tests
 * that seed two organizations, and the rule they defend is one a reader should
 * be able to check in one sitting.
 */

let store: FakeStore;
let logger: FakeLog;
const ctx = () => fakeContext(store, logger);

beforeEach(() => {
	store = fakeStore();
	logger = fakeLog();
});

const PAGE = { cursor: null, limit: 25 };

describe("list", () => {
	it("scopes the query to the active organization, never to the actor", async () => {
		store = fakeStore([
			projectRow({ id: "ours" }),
			projectRow({ id: "theirs", organizationId: OTHER_ORGANIZATION }),
		]);

		const found = await listProjects(PAGE, ctx());

		expect(store.calls.listedFor).toEqual([ORGANIZATION]);
		expect(found.items.map((item) => item.id)).toEqual(["ours"]);
	});
});

describe("create", () => {
	// The tenant comes from the guard and the actor is recorded beside it: the
	// row belongs to the organization, the member merely made it.
	it("files the row under the active organization and stamps the actor", async () => {
		await createProject(
			{ description: null, name: "Billing", slug: "billing" },
			ctx()
		);

		expect(store.calls.inserted).toEqual([
			{
				createdBy: ACTOR,
				description: null,
				name: "Billing",
				organizationId: ORGANIZATION,
				slug: "billing",
			},
		]);
	});
});

describe("get", () => {
	// A 403 here would confirm the id exists, which is enough to walk another
	// tenant's project ids one guess at a time. The store never returns the row,
	// so 404 is not a policy the service applies — it is all it knows.
	it("reports another organization's project as missing, not forbidden", async () => {
		store = fakeStore([
			projectRow({ id: "theirs", organizationId: OTHER_ORGANIZATION }),
		]);

		const thrown = await getProject("theirs", ctx()).catch(
			(error: unknown) => error
		);

		expect(parseError(thrown).status).toBe(404);
	});
});

describe("remove", () => {
	it("deletes a project from the active organization, scoped to it", async () => {
		store = fakeStore([projectRow({ id: "ours" })]);

		await deleteProject("ours", ctx());

		expect(store.calls.deleted).toEqual([
			{ id: "ours", organizationId: ORGANIZATION },
		]);
	});

	it("refuses to delete another organization's project", async () => {
		store = fakeStore([
			projectRow({ id: "theirs", organizationId: OTHER_ORGANIZATION }),
		]);

		const thrown = await deleteProject("theirs", ctx()).catch(
			(error: unknown) => error
		);

		expect(parseError(thrown).status).toBe(404);
		expect(store.calls.deleted).toEqual([]);
	});
});
