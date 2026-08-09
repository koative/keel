import { beforeEach, describe, expect, it } from "bun:test";
import { parseError } from "evlog";
import type { LogPort } from "@/lib/log";
import {
	type CreateProject,
	createProject,
	deleteProject,
	getProject,
	listProjects,
	type Project,
	type ProjectContext,
	type ProjectStore,
} from "./projects.service";

const ACTOR = "actor-1";
const OTHER = "actor-2";

const row = (overrides: Partial<Project> = {}): Project => ({
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	description: null,
	id: "p1",
	name: "Billing",
	ownerId: ACTOR,
	slug: "billing",
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	...overrides,
});

interface StoreCalls {
	deleted: string[];
	inserted: (CreateProject & { ownerId: string })[];
	listedFor: string[];
}

interface FakeStore {
	calls: StoreCalls;
	store: ProjectStore;
}

interface FakeLog {
	fields: unknown[];
	log: LogPort;
}

/**
 * The whole point of taking the store and the logger as parameters: no database,
 * no HTTP server, no container. A fake store is an object literal and a fake
 * logger is four no-ops.
 */
function fakeStore(seed: Project[] = []): FakeStore {
	const calls: StoreCalls = { deleted: [], inserted: [], listedFor: [] };

	return {
		calls,
		store: {
			deleteById(id) {
				calls.deleted.push(id);
				return Promise.resolve();
			},
			findById(id) {
				return Promise.resolve(seed.find((item) => item.id === id));
			},
			insert(input) {
				calls.inserted.push(input);
				return Promise.resolve(row(input));
			},
			listByOwner(ownerId) {
				calls.listedFor.push(ownerId);
				return Promise.resolve(seed.filter((item) => item.ownerId === ownerId));
			},
		},
	};
}

function fakeLog(): FakeLog {
	const fields: unknown[] = [];

	return {
		fields,
		log: {
			error: () => undefined,
			info: () => undefined,
			set: (context) => {
				fields.push(context);
			},
			warn: () => undefined,
		},
	};
}

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
			row({ id: "mine" }),
			row({ id: "theirs", ownerId: OTHER }),
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
		store = fakeStore([row({ id: "mine" })]);

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
		store = fakeStore([row({ id: "theirs", ownerId: OTHER })]);

		const thrown = await getProject("theirs", ctx()).catch(
			(error: unknown) => error
		);

		expect(parseError(thrown).status).toBe(404);
	});
});

describe("remove", () => {
	it("deletes the actor's own project", async () => {
		store = fakeStore([row({ id: "mine" })]);

		await deleteProject("mine", ctx());

		expect(store.calls.deleted).toEqual(["mine"]);
	});

	it("refuses to delete another tenant's project", async () => {
		store = fakeStore([row({ id: "theirs", ownerId: OTHER })]);

		const thrown = await deleteProject("theirs", ctx()).catch(
			(error: unknown) => error
		);

		expect(parseError(thrown).status).toBe(404);
		expect(store.calls.deleted).toEqual([]);
	});
});
