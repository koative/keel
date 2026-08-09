import { beforeEach, describe, expect, it } from "bun:test";
import { parseError } from "evlog";
import {
	ACTOR,
	type FakeLog,
	type FakeStore,
	fakeLog,
	fakeStore,
	OTHER_ACTOR,
	projectRow,
} from "./projects.fixtures";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	type ProjectContext,
} from "./projects.service";

let store: FakeStore;
let logger: FakeLog;
const ctx = (): ProjectContext => ({
	actorId: ACTOR,
	log: logger.log,
	repository: store.store,
});

beforeEach(() => {
	store = fakeStore();
	logger = fakeLog();
});

describe("list", () => {
	it("scopes the query to the actor, never to a caller-supplied owner", async () => {
		store = fakeStore([
			projectRow({ id: "mine" }),
			projectRow({ id: "theirs", ownerId: OTHER_ACTOR }),
		]);

		const found = await listProjects(ctx());

		expect(store.calls.listedFor).toEqual([ACTOR]);
		expect(found.map((item) => item.id)).toEqual(["mine"]);
	});
});

describe("create", () => {
	it("stamps the actor as owner", async () => {
		await createProject(
			{ description: null, name: "Billing", slug: "billing" },
			ctx()
		);

		expect(store.calls.inserted).toEqual([
			{ description: null, name: "Billing", ownerId: ACTOR, slug: "billing" },
		]);
	});

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
	it("returns the actor's own project", async () => {
		store = fakeStore([projectRow({ id: "mine" })]);

		expect((await getProject("mine", ctx())).id).toBe("mine");
	});

	it("reports a missing project as a 404", async () => {
		const thrown = await getProject("ghost", ctx()).catch(
			(error: unknown) => error
		);
		const parsed = parseError(thrown);

		expect(parsed.status).toBe(404);
		expect(parsed.message).toBe("Project not found");
	});

	// A 403 here would confirm the id exists, which is enough to walk another
	// tenant's project ids one guess at a time.
	it("reports another tenant's project as missing, not forbidden", async () => {
		store = fakeStore([projectRow({ id: "theirs", ownerId: OTHER_ACTOR })]);

		const thrown = await getProject("theirs", ctx()).catch(
			(error: unknown) => error
		);

		expect(parseError(thrown).status).toBe(404);
	});
});

describe("remove", () => {
	it("deletes the actor's own project", async () => {
		store = fakeStore([projectRow({ id: "mine" })]);

		await deleteProject("mine", ctx());

		expect(store.calls.deleted).toEqual(["mine"]);
	});

	it("refuses to delete another tenant's project", async () => {
		store = fakeStore([projectRow({ id: "theirs", ownerId: OTHER_ACTOR })]);

		const thrown = await deleteProject("theirs", ctx()).catch(
			(error: unknown) => error
		);

		expect(parseError(thrown).status).toBe(404);
		expect(store.calls.deleted).toEqual([]);
	});
});
