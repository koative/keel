import { beforeAll, describe, expect, it, type Mock, mock } from "bun:test";
import type { Storage } from "@keel/storage/client";
import { skipNotice, testDbReady } from "../../../../test-db";
import type { Envelope, ErrorEnvelope } from "../../../../test-http";
import type { StorageEnv } from "../../../lib/storage";
import { CREDENTIALS } from "../../../lib/storage.fixtures";

/**
 * The handlers resolve storage through `@/lib/storage`. This suite pins the
 * resolver's SOURCE, never its wiring: the mock below delegates to the real
 * `resolveStorage`, and each request that reaches the handler picks which
 * environment the real guard sees.
 *
 * The real function is pinned before `mock.module` is registered: registering
 * first would make even a pre-captured namespace hand back the mock, because
 * Bun rewires the module's exports to the mock.
 */
const { resolveStorage: realResolveStorage } = await import(
	"../../../lib/storage"
);

mock.module("@/lib/storage", () => {
	const resolveStorage = mock((source?: StorageEnv) =>
		realResolveStorage(source ?? {})
	);

	return { resolveStorage };
});

// Imported after the mock is registered, so the whole app graph — and the
// handlers with their own `@/lib/storage` import — sees the mocked resolver.
const { createClient, signUp, signUpWithoutOrganization } = await import(
	"../../../../test-http"
);

/** The runtime binding is the mock above; TypeScript still sees the real types. */
const { resolveStorage } = await import("@/lib/storage");
const resolveStorageMock = resolveStorage as unknown as Mock<
	(source?: StorageEnv) => Storage
>;

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("storage internal routes"));
}

const api = createClient();

/**
 * A fully configured storage environment: the shared credentials fixture the
 * real `resolveStorage` guard accepts in `lib/storage.test.ts`, plus a `custom`
 * provider so the endpoint and addressing style are stated outright and the
 * signed URL has a host and path this suite can assert on. Presigned URLs are
 * signed by the real S3 client, exactly as in the package's own tests.
 */
const CONFIGURED: StorageEnv = {
	...CREDENTIALS,
	STORAGE_ENDPOINT: "http://localhost:9000",
	STORAGE_FORCE_PATH_STYLE: true,
	STORAGE_PROVIDER: "custom",
};

const SIGNATURE = /^[0-9a-f]{64}$/;

/** The key always lands under the caller's own organization prefix. */
const TENANT_KEY_PATH = /^\/keel-files\/org_[^/]+\/avatars\/me\.png$/;

/**
 * End to end through the real stack — auth guard, validator, handler, resolver,
 * presigning client — driven by `app.request()` with no socket. The session
 * comes from Better Auth's own sign-up flow, so the 401 and 403 are the guards
 * that run in production.
 */
describe.skipIf(!ready)("internal storage routes", () => {
	beforeAll(async () => {
		api.cookie = await signUp();
	});

	it("rejects an anonymous request with a 401", async () => {
		const response = await createClient().request(
			"/api/storage/upload-url?key=avatars/me.png&expiresInSeconds=60"
		);

		expect(response.status).toBe(401);
		expect((await api.body<ErrorEnvelope>(response)).error.code).toBe(
			"UNAUTHORIZED"
		);
	});

	it("rejects a member with no active organization with a 403", async () => {
		const onboarding = createClient();
		onboarding.cookie = await signUpWithoutOrganization();

		const response = await onboarding.request(
			"/api/storage/upload-url?key=avatars/me.png&expiresInSeconds=60"
		);

		expect(response.status).toBe(403);
		expect((await api.body<ErrorEnvelope>(response)).error.code).toBe(
			"FORBIDDEN"
		);
	});

	it("returns a presigned upload URL scoped to the caller's tenant", async () => {
		// The handler calls the resolver with no source; the real guard runs
		// against the configured environment this once.
		resolveStorageMock.mockImplementationOnce(() =>
			realResolveStorage(CONFIGURED)
		);

		const response = await api.request(
			"/api/storage/upload-url?key=avatars/me.png&contentType=image/png&expiresInSeconds=60"
		);
		const { data } = await api.body<Envelope<{ uploadUrl: string }>>(response);

		expect(response.status).toBe(200);
		const url = new URL(data.uploadUrl);
		expect(url.host).toBe("localhost:9000");
		expect(url.pathname).toMatch(TENANT_KEY_PATH);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(SIGNATURE);
	});

	it("returns a presigned download URL carrying the requested lifetime", async () => {
		resolveStorageMock.mockImplementationOnce(() =>
			realResolveStorage(CONFIGURED)
		);

		const response = await api.request(
			"/api/storage/download-url?key=avatars/me.png&expiresInSeconds=300"
		);
		const { data } =
			await api.body<Envelope<{ downloadUrl: string }>>(response);

		expect(response.status).toBe(200);
		const url = new URL(data.downloadUrl);
		expect(url.host).toBe("localhost:9000");
		expect(url.pathname).toMatch(TENANT_KEY_PATH);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(SIGNATURE);
	});

	// A bad query is a client mistake and must stay a 422: a longer window, a
	// fractional one, a missing key or lifetime, an empty key, or a key whose
	// segments could widen it past the tenant prefix.
	it.each([
		"expiresInSeconds=0",
		"expiresInSeconds=604801",
		"expiresInSeconds=1.5",
		"key=avatars/me.png",
		"key=&expiresInSeconds=60",
		"key=../secret.pdf&expiresInSeconds=60",
		"key=photos/../../org_other/secret.pdf&expiresInSeconds=60",
		"key=avatars//me.png&expiresInSeconds=60",
		"key=/avatars/me.png&expiresInSeconds=60",
	])("rejects ?%s as a 422, never a 500", async (query) => {
		const response = await api.request(`/api/storage/upload-url?${query}`);

		expect(response.status).toBe(422);
		expect((await api.body<ErrorEnvelope>(response)).error.code).toBe(
			"UNPROCESSABLE_ENTITY"
		);
	});

	it("names the missing STORAGE_* keys when storage is not configured", async () => {
		// No implementationOnce: the mock's default delegates to the real
		// resolveStorage, whose guard throws the message this envelope carries.
		const response = await api.request(
			"/api/storage/upload-url?key=avatars/me.png&expiresInSeconds=60"
		);
		const body = await api.body<ErrorEnvelope>(response);

		expect(response.status).toBe(503);
		expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
		// The guard's report travels in `why`, per the shared envelope: the
		// message stays the fixed 503 line every caller can branch on.
		expect(body.error.why).toContain("STORAGE_PROVIDER");
		expect(body.error.why).toContain("STORAGE_BUCKET");
		expect(body.error.why).toContain("STORAGE_ACCESS_KEY_ID");
		expect(body.error.why).toContain("STORAGE_SECRET_ACCESS_KEY");
	});
});
