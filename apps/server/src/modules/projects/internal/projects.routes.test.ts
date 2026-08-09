import { beforeAll, describe, expect, it } from "bun:test";
import { skipNotice, testDbReady } from "../../../../test-db";
import {
	createClient,
	type Envelope,
	type ErrorEnvelope,
	signUp,
} from "../../../../test-http";
import type { ProjectResponse } from "./projects.schema";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("projects internal routes"));
}

const api = createClient();
const slug = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

const createProject = async (payload: Record<string, unknown>) => {
	const response = await api.post("/api/projects", payload);
	return {
		data: (await api.body<Envelope<ProjectResponse>>(response)).data,
		response,
	};
};

interface Page<T> {
	data: T;
	meta: { nextCursor: string | null };
}

/**
 * End to end through the real stack — CORS, wide event, auth guard, validator,
 * handler, service, repository, Postgres — driven by `app.request()` with no
 * socket. The session comes from Better Auth's own sign-up flow.
 *
 * Who may reach these routes at all, and what one organization can see of
 * another's, is in `projects.routes.tenancy.test.ts`.
 */
describe.skipIf(!ready)("internal project routes", () => {
	beforeAll(async () => {
		api.cookie = await signUp();
	});

	it("creates and reads back the rich internal shape", async () => {
		const name = slug("billing");
		const { data, response } = await createProject({
			description: "Invoices",
			name: "Billing",
			slug: name,
		});

		expect(response.status).toBe(201);
		expect(data).toMatchObject({
			description: "Invoices",
			name: "Billing",
			slug: name,
		});
		// Fields the public contract deliberately omits — and one it must never
		// carry: the caller is already scoped to a single organization, so the
		// tenant id on each item would be noise the frontend has to ignore.
		expect(data.createdBy).toBeString();
		expect(data.updatedAt).toBeString();
		expect(data).not.toHaveProperty("organizationId");

		const readBack = await api.request(`/api/projects/${data.id}`);
		expect(readBack.status).toBe(200);
		expect((await api.body<Envelope<ProjectResponse>>(readBack)).data).toEqual(
			data
		);
	});

	it("reports a duplicate slug as a 409, not a 500", async () => {
		const name = slug("dup");
		await createProject({ name: "First", slug: name });

		const response = await api.post("/api/projects", {
			name: "Second",
			slug: name,
		});

		expect(response.status).toBe(409);
		expect((await api.body<ErrorEnvelope>(response)).error).toMatchObject({
			code: "CONFLICT",
			fix: "Choose a different slug",
		});
	});

	it("rejects an invalid body as a 422 naming every offending field", async () => {
		const response = await api.post("/api/projects", {
			name: "",
			slug: "not a slug",
		});
		const body = await api.body<ErrorEnvelope>(response);

		expect(response.status).toBe(422);
		expect(body.error.code).toBe("UNPROCESSABLE_ENTITY");
		expect(body.error.why).toContain("name");
		expect(body.error.why).toContain("slug");
	});

	it("rejects a malformed id before it reaches the database", async () => {
		expect((await api.request("/api/projects/not-a-uuid")).status).toBe(422);
	});

	it("deletes with 204 and an empty body", async () => {
		const { data } = await createProject({ name: "Gone", slug: slug("gone") });

		const deleted = await api.request(`/api/projects/${data.id}`, {
			method: "DELETE",
		});

		expect(deleted.status).toBe(204);
		expect(await deleted.text()).toBe("");
		expect((await api.request(`/api/projects/${data.id}`)).status).toBe(404);
	});

	// A bad limit or a hand-written cursor is a client mistake. Each of these
	// would be a 500 if the cursor were decoded in the handler instead of the
	// validator, which is the failure mode this locks down.
	it.each(["limit=0", "limit=101", "limit=abc", "cursor=%20not-a-cursor"])(
		"rejects ?%s as a 422, never a 500",
		async (query) => {
			expect((await api.request(`/api/projects?${query}`)).status).toBe(422);
		}
	);

	it("pages with the cursor from the previous response", async () => {
		// Five of its own, so the assertions hold no matter what the tests above
		// left in this owner's list.
		await Promise.all(
			Array.from({ length: 5 }, (_unused, index) =>
				api.post("/api/projects", {
					name: `Page ${index}`,
					slug: slug("page"),
				})
			)
		);

		const first = await api.body<Page<ProjectResponse[]>>(
			await api.request("/api/projects?limit=2")
		);
		const second = await api.body<Page<ProjectResponse[]>>(
			await api.request(
				`/api/projects?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor ?? "")}`
			)
		);
		const whole = await api.body<Page<ProjectResponse[]>>(
			await api.request("/api/projects?limit=100")
		);

		expect(first.data).toHaveLength(2);
		expect(second.data).toHaveLength(2);
		// A cursor that repeated or skipped a row shows up here as a duplicate.
		expect(
			new Set([...first.data, ...second.data].map((item) => item.id)).size
		).toBe(4);
		// Nothing left to fetch, so the token is null rather than a dead cursor.
		expect(whole.meta.nextCursor).toBeNull();
	});
});
