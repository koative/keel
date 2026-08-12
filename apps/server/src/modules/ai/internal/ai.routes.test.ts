import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq, inArray } from "drizzle-orm";
import { skipNotice, testDbReady } from "../../../../test-db";
import {
	createClient,
	type Envelope,
	type ErrorEnvelope,
	signUp,
	signUpWithoutOrganization,
} from "../../../../test-http";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("ai internal routes"));
}

const api = createClient();

/**
 * Ids this suite enqueued, so cleanup only ever removes its own rows: the
 * server and mail suites run concurrently against one database, and a full
 * table delete in `afterEach` would wipe another suite's rows mid-assertion.
 * Same staged-id discipline as the job suite.
 */
const staged: string[] = [];

afterEach(async () => {
	if (staged.length > 0) {
		await db.delete(job).where(inArray(job.id, staged.splice(0)));
	}
});

/** A unique key per run, so a previous run's pending row cannot collapse it. */
const dedupeKey = () => `ai:${crypto.randomUUID()}`;

const prompt = () => `Summarise this document: ${crypto.randomUUID()}`;

interface Generation {
	created: boolean;
	jobId: string | null;
}

/**
 * End to end through the real stack — auth guard, validator, handler, the real
 * `enqueueGeneration`, Postgres — driven by `app.request()` with no socket.
 * The session comes from Better Auth's own sign-up flow, so the 401 and 403
 * are the guards that run in production.
 */
describe.skipIf(!ready)("internal ai routes", () => {
	beforeAll(async () => {
		api.cookie = await signUp();
	});

	it("rejects an anonymous request with a 401", async () => {
		const response = await createClient().post("/api/ai/generate", {
			prompt: "hello",
		});

		expect(response.status).toBe(401);
		expect((await api.body<ErrorEnvelope>(response)).error.code).toBe(
			"UNAUTHORIZED"
		);
	});

	it("rejects a member with no active organization with a 403", async () => {
		const onboarding = createClient();
		onboarding.cookie = await signUpWithoutOrganization();

		const response = await onboarding.post("/api/ai/generate", {
			prompt: "hello",
		});

		expect(response.status).toBe(403);
		expect((await api.body<ErrorEnvelope>(response)).error.code).toBe(
			"FORBIDDEN"
		);
	});

	it("rejects an empty prompt as a 422, never a 500", async () => {
		const response = await api.post("/api/ai/generate", { prompt: "" });

		expect(response.status).toBe(422);
		expect((await api.body<ErrorEnvelope>(response)).error.code).toBe(
			"UNPROCESSABLE_ENTITY"
		);
	});

	it("rejects a prompt past the persisted-payload bound as a 422", async () => {
		const response = await api.post("/api/ai/generate", {
			prompt: "x".repeat(32_001),
		});

		expect(response.status).toBe(422);
	});

	it("enqueues a generation and returns its job id", async () => {
		const text = prompt();
		const response = await api.post("/api/ai/generate", {
			dedupeKey: dedupeKey(),
			prompt: text,
		});
		const { data } = await api.body<Envelope<Generation>>(response);

		expect(response.status).toBe(200);
		expect(data.created).toBe(true);
		expect(data.jobId).toBeString();

		// The row the worker will pick up is really there, under the caller's
		// tenant — the route test asserting the row exists is the smoke check.
		const [row] = await db
			.select({ kind: job.kind, payload: job.payload })
			.from(job)
			.where(eq(job.id, data.jobId ?? ""));
		const payload = row?.payload as { organizationId: string; prompt: string };

		expect(row?.kind).toBe("ai.generate");
		expect(payload.organizationId).toBeString();
		expect(payload.prompt).toBe(text);
		staged.push(data.jobId ?? "");
	});

	it("collapses a repeat of a keyed generation into the in-flight job", async () => {
		const key = dedupeKey();
		const first = await api.post("/api/ai/generate", {
			dedupeKey: key,
			prompt: prompt(),
		});
		const firstBody = await api.body<Envelope<Generation>>(first);
		expect(firstBody.data.created).toBe(true);
		expect(firstBody.data.jobId).toBeString();

		const second = await api.post("/api/ai/generate", {
			dedupeKey: key,
			prompt: prompt(),
		});
		const secondBody = await api.body<Envelope<Generation>>(second);

		// The queue reports the collapse honestly: nothing was created, and the
		// insert did not return an id — the first job is the work now.
		expect(secondBody.data.created).toBe(false);
		expect(secondBody.data.jobId).toBeNull();

		// One row carries the key, not two — the collapse is in the database.
		const rows = await db
			.select({ id: job.id })
			.from(job)
			.where(eq(job.dedupeKey, key));
		expect(rows).toHaveLength(1);
		staged.push(firstBody.data.jobId ?? "");
	});

	it("queues again when no dedupe key is given", async () => {
		const text = prompt();
		const first = await api.post("/api/ai/generate", { prompt: text });
		const firstBody = await api.body<Envelope<Generation>>(first);
		const second = await api.post("/api/ai/generate", { prompt: text });
		const secondBody = await api.body<Envelope<Generation>>(second);

		// No key means "always enqueue" — the cost of omitting one is that a
		// retry runs the work again instead of joining it.
		expect(firstBody.data.created).toBe(true);
		expect(secondBody.data.created).toBe(true);
		expect(secondBody.data.jobId).not.toBe(firstBody.data.jobId);
		staged.push(firstBody.data.jobId ?? "", secondBody.data.jobId ?? "");
	});
});
