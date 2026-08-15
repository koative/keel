import { describe, expect, it } from "bun:test";
import { serverUrlSchema } from "./server-url";

/**
 * The accept set is not a style preference: it is the union of what
 * `apps/web/src/lib/server-url.ts` can resolve. An absolute origin is used as
 * given; a root-relative path is resolved against `window.location.origin`,
 * which is how the Docker and Vercel deployments are wired. Anything this
 * schema accepts and that resolver cannot resolve is a boot crash, and
 * anything it rejects that the resolver handles is this bug again.
 */
describe("VITE_SERVER_URL", () => {
	it.each(["http://localhost:3000", "https://api.example.com"])(
		"accepts the absolute origin %p",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(true);
		}
	);

	it.each(["/api", "/api/v1"])(
		"accepts the root-relative path %p that the Docker and Vercel wiring uses",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(true);
		}
	);

	// `serverOrigin` strips a trailing slash, so `/` reduces to the empty string
	// and `new URL("/api/auth", "")` throws at module import.
	it("rejects a bare slash, which the resolver reduces to nothing", () => {
		expect(serverUrlSchema.safeParse("/").success).toBe(false);
	});

	// A protocol-relative value looks root-relative and is not: the browser would
	// resolve `//evil.example` to another origin entirely.
	it.each(["//evil.example", "//evil.example/api"])(
		"rejects the protocol-relative %p",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(false);
		}
	);

	it.each(["javascript:alert(1)", "file:///etc/passwd"])(
		"rejects the non-http scheme %p",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(false);
		}
	);

	it.each(["not a url", "", "localhost:3000"])(
		"rejects %p, which resolves to nothing",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(false);
		}
	);

	it("names both accepted shapes when it rejects", () => {
		const result = serverUrlSchema.safeParse("not a url");

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("/api");
			expect(result.error.issues[0]?.message).toContain("https://");
		}
	});
});
