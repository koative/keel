import { describe, expect, it } from "bun:test";
import { type ClientIpEnv, resolveClientIpPosture } from "./client-ip";

/** Each guard is identified by the variable it names, which is its whole job. */
const MISSING_HEADER = /TRUSTED_IP_HEADER/;
const MISSING_PROXIES = /TRUSTED_PROXIES/;

function envWith(overrides: Partial<ClientIpEnv>): ClientIpEnv {
	return { NODE_ENV: "development", ...overrides };
}

describe("resolveClientIpPosture", () => {
	it("refuses a production boot with no trusted header", () => {
		expect(() =>
			resolveClientIpPosture(envWith({ NODE_ENV: "production" }))
		).toThrow(MISSING_HEADER);
	});

	it("treats an empty header as absent", () => {
		// `emptyStringAsUndefined` covers an unset variable, but the prod compose
		// writes `TRUSTED_IP_HEADER: ${TRUSTED_IP_HEADER:-}`, and a deployment that
		// exports the name with no value must not slip past the guard.
		expect(() =>
			resolveClientIpPosture(
				envWith({ NODE_ENV: "production", TRUSTED_IP_HEADER: "" })
			)
		).toThrow(MISSING_HEADER);
	});

	it("refuses a named header with no proxy list", () => {
		// Not production-only: a header nobody rewrites is taken at face value in
		// every environment, so the mistake is worth learning about on a laptop.
		expect(() =>
			resolveClientIpPosture(envWith({ TRUSTED_IP_HEADER: "x-forwarded-for" }))
		).toThrow(MISSING_PROXIES);
	});

	it("treats an empty proxy list as absent", () => {
		expect(() =>
			resolveClientIpPosture(
				envWith({ TRUSTED_IP_HEADER: "x-forwarded-for", TRUSTED_PROXIES: [] })
			)
		).toThrow(MISSING_PROXIES);
	});

	it("names the forgeable default when it lets a laptop boot unconfigured", () => {
		// A fresh checkout has neither key and has to start. What it must not do is
		// stay quiet about what Better Auth does instead.
		const posture = resolveClientIpPosture(envWith({}));

		expect(posture).toContain("x-forwarded-for");
		expect(posture).toContain("127.0.0.1");
	});

	it("reports the header and the number of trusted ranges when configured", () => {
		expect(
			resolveClientIpPosture(
				envWith({
					NODE_ENV: "production",
					TRUSTED_IP_HEADER: "x-forwarded-for",
					TRUSTED_PROXIES: ["10.0.0.0/8", "172.16.0.0/12"],
				})
			)
		).toBe("client IP from `x-forwarded-for`, past 2 trusted range(s)");
	});
});
