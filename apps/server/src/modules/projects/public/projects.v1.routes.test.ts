import { beforeAll, describe, expect, it } from "bun:test";
import { skipNotice, testDbReady } from "../../../../test-db";
import { createClient, type Envelope, signUp } from "../../../../test-http";
import type { ProjectResponse } from "../internal/projects.schema";
import { type ProjectV1, projectV1Schema } from "./projects.v1.schema";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("projects v1 routes"));
}

const api = createClient();
const slug = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

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
});
