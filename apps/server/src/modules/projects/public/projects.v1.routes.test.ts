import { beforeAll, describe, expect, it } from "bun:test";
import { skipNotice, testDbReady } from "../../../../test-db";
import {
	createClient,
	type Envelope,
	signUp,
	signUpWithoutOrganization,
} from "../../../../test-http";
import type { ProjectResponse } from "../internal/projects.schema";
import { type ProjectV1, projectV1Schema } from "./projects.v1.schema";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("projects v1 routes"));
}

const api = createClient();
const slug = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

interface Page<T> {
	data: T;
	meta: { nextCursor: string | null };
}

describe.skipIf(!ready)("v1 project routes", () => {
	beforeAll(async () => {
		api.cookie = await signUp();
	});

	it("returns only the four contracted fields", async () => {
		const name = slug("pub");
		const response = await api.post("/v1/projects", {
			name: "Billing",
			slug: name,
		});
		const { data } = await api.body<Envelope<ProjectV1>>(response);

		expect(response.status).toBe(201);
		// The key set, not a parse: `projectV1Schema.parse` strips an extra field
		// and reports success, hiding exactly the leak this guards against.
		expect(Object.keys(data).sort()).toEqual([
			"created_at",
			"id",
			"name",
			"slug",
		]);
		expect(projectV1Schema.safeParse(data).success).toBe(true);
	});

	// The 403 this surface publishes is real, not decorative: the guard is mounted
	// here as well as on /api, and an integration that has not onboarded gets it.
	it("refuses a member with no active organization with a 403", async () => {
		const onboarding = createClient();
		onboarding.cookie = await signUpWithoutOrganization();

		expect((await onboarding.request("/v1/projects")).status).toBe(403);
	});

	it("refuses the slug spelling /api accepts", async () => {
		const mixedCase = `Pub-${crypto.randomUUID().slice(0, 8)}`;

		expect(
			(await api.post("/v1/projects", { name: "Billing", slug: mixedCase }))
				.status
		).toBe(422);
		expect(
			(await api.post("/api/projects", { name: "Billing", slug: mixedCase }))
				.status
		).toBe(201);
	});

	it("ignores a field only the internal surface accepts", async () => {
		const name = slug("strip");
		const { data } = await api.body<Envelope<ProjectV1>>(
			await api.post("/v1/projects", {
				description: "leaked",
				name: "Billing",
				slug: name,
			})
		);

		expect(data).not.toHaveProperty("description");

		const internal = await api.body<Envelope<ProjectResponse>>(
			await api.request(`/api/projects/${data.id}`)
		);
		expect(internal.data.description).toBeNull();
	});

	it("shares the service with /api, so both surfaces see the same row", async () => {
		const { data: created } = await api.body<Envelope<ProjectResponse>>(
			await api.post("/api/projects", { name: "Shared", slug: slug("shared") })
		);

		const listed = await api.body<Envelope<ProjectV1[]>>(
			await api.request("/v1/projects")
		);

		expect(listed.data.map((item) => item.id)).toContain(created.id);
	});

	it("publishes no delete endpoint", async () => {
		const { data } = await api.body<Envelope<ProjectResponse>>(
			await api.post("/api/projects", { name: "Keep", slug: slug("keep") })
		);

		expect(
			(await api.request(`/v1/projects/${data.id}`, { method: "DELETE" }))
				.status
		).toBe(404);
		expect(
			(await api.request(`/api/projects/${data.id}`, { method: "DELETE" }))
				.status
		).toBe(204);
	});

	it.each(["limit=0", "limit=101", "limit=abc", "cursor=%20not-a-cursor"])(
		"rejects ?%s as a 422, never a 500",
		async (query) => {
			expect((await api.request(`/v1/projects?${query}`)).status).toBe(422);
		}
	);

	it("pages with the cursor from the previous response", async () => {
		// Five of its own, so the assertions hold no matter what the tests above
		// left in this owner's list.
		await Promise.all(
			Array.from({ length: 5 }, (_unused, index) =>
				api.post("/v1/projects", {
					name: `Page ${index}`,
					slug: slug("v1page"),
				})
			)
		);

		const first = await api.body<Page<ProjectV1[]>>(
			await api.request("/v1/projects?limit=2")
		);
		const second = await api.body<Page<ProjectV1[]>>(
			await api.request(
				`/v1/projects?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor ?? "")}`
			)
		);
		const whole = await api.body<Page<ProjectV1[]>>(
			await api.request("/v1/projects?limit=100")
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
