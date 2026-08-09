import { beforeAll, describe, expect, it } from "bun:test";
import { app } from "@/app";
import { skipNotice, testDbReady } from "../../../../test-db";
import {
	createClient,
	type Envelope,
	type ErrorEnvelope,
	signUp,
	signUpWithoutOrganization,
} from "../../../../test-http";
import type { ProjectResponse } from "./projects.schema";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("projects internal route tenancy"));
}

const api = createClient();

/**
 * Who may reach the internal project routes, and what one organization can see
 * of another's rows. Three sessions with different standing — anonymous, signed
 * in without an organization, and signed in with a different one — each of
 * which has to be turned away differently.
 *
 * Separate from `projects.routes.test.ts` because these are the assertions a
 * tenancy regression would trip, and they should be readable end to end without
 * the CRUD and validation cases in between.
 */
describe.skipIf(!ready)("internal project route tenancy", () => {
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

	// The other half of CONTRACT A's failure modes: authenticated but not yet in
	// an organization is a 403, so the SPA can route to onboarding instead of
	// showing an empty project list or bouncing the user back to sign-in.
	it("refuses a member with no active organization with a 403", async () => {
		const onboarding = createClient();
		onboarding.cookie = await signUpWithoutOrganization();

		const response = await onboarding.request("/api/projects");

		expect(response.status).toBe(403);
		expect((await api.body<ErrorEnvelope>(response)).error.code).toBe(
			"FORBIDDEN"
		);
	});

	// 404 and not 403: a 403 would confirm the id exists, which is enough to walk
	// another organization's project ids one guess at a time. The intruder is
	// signed in and has an organization of their own, so the only thing standing
	// between them and the row is the repository's tenancy filter.
	it("hides another organization's project behind a 404, never a 403", async () => {
		const created = await api.post("/api/projects", {
			name: "Ours",
			slug: `ours-${crypto.randomUUID().slice(0, 8)}`,
		});
		const { data } = await api.body<Envelope<ProjectResponse>>(created);

		const intruder = createClient();
		intruder.cookie = await signUp();

		const response = await intruder.request(`/api/projects/${data.id}`);

		expect(response.status).toBe(404);
		expect((await api.body<ErrorEnvelope>(response)).error.code).toBe(
			"NOT_FOUND"
		);
	});
});
