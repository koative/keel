import { beforeAll, describe, expect, it } from "bun:test";
import { app } from "@/app";
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

/**
 * End to end through the real stack — CORS, wide event, auth guard, validator,
 * handler, service, repository, Postgres — driven by `app.request()` with no
 * socket. The session comes from Better Auth's own sign-up flow.
 */
describe.skipIf(!ready)("internal project routes", () => {
	beforeAll(async () => {
		api.cookie = await signUp();
	});

	it("rejects an anonymous request with the shared envelope", async () => {
		const response = await app.request("/api/projects");
		const body = await api.body<ErrorEnvelope>(response);

		expect(response.status).toBe(401);
		expect(body.error).toMatchObject({
			code: "UNAUTHORIZED",
			message: "Authentication required",
		});
		expect(body.error.requestId).toBeString();
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
		// Fields the public contract deliberately omits.
		expect(data.ownerId).toBeString();
		expect(data.updatedAt).toBeString();

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

	it("hides another tenant's project behind a 404", async () => {
		const { data } = await createProject({ name: "Mine", slug: slug("mine") });

		const intruder = createClient();
		intruder.cookie = await signUp();

		expect((await intruder.request(`/api/projects/${data.id}`)).status).toBe(
			404
		);
	});
});
