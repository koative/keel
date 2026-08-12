import { describe, expect, it } from "bun:test";
import { SANDBOX_MAIL_FROM } from "@keel/env/server";
import { type MailEnv, resolveMailConfig } from "./mail";

const VERIFIED_FROM = "Keel <hello@keel.test>";

/** Each guard is identified by the variable it names, which is its whole job. */
const MISSING_KEY = /RESEND_API_KEY/;
const SANDBOX_SENDER = /MAIL_FROM/;
const LOG_IN_PRODUCTION = /NODE_ENV=production/;

// `development` is what `.env.example` ships, so this is the shape a fresh
// checkout resolves and the baseline every case here departs from by one field.
function envWith(overrides: Partial<MailEnv>): MailEnv {
	return {
		MAIL_DRIVER: "log",
		MAIL_FROM: SANDBOX_MAIL_FROM,
		NODE_ENV: "development",
		...overrides,
	};
}

describe("resolveMailConfig", () => {
	it("refuses to boot when resend is selected without a key", () => {
		expect(() => resolveMailConfig(envWith({ MAIL_DRIVER: "resend" }))).toThrow(
			MISSING_KEY
		);
	});

	it("treats an empty key as absent", () => {
		// `emptyStringAsUndefined` covers an unset variable, but a deployment that
		// writes `RESEND_API_KEY=` into a compose file must not slip past the guard.
		expect(() =>
			resolveMailConfig(envWith({ MAIL_DRIVER: "resend", RESEND_API_KEY: "" }))
		).toThrow(MISSING_KEY);
	});

	it("refuses to boot when resend would send from the sandbox address", () => {
		expect(() =>
			resolveMailConfig(
				envWith({ MAIL_DRIVER: "resend", RESEND_API_KEY: "re_test" })
			)
		).toThrow(SANDBOX_SENDER);
	});

	it("carries the key through when resend is fully configured", () => {
		const config = resolveMailConfig(
			envWith({
				MAIL_DRIVER: "resend",
				MAIL_FROM: VERIFIED_FROM,
				RESEND_API_KEY: "re_test",
			})
		);

		expect(config).toEqual({
			apiKey: "re_test",
			driver: "resend",
			from: VERIFIED_FROM,
		});
	});

	it("accepts the sandbox address on the log driver", () => {
		// Nothing leaves the process, so the sender is never checked by anyone.
		// This is the default a fresh checkout boots with, and it has to work.
		expect(resolveMailConfig(envWith({}))).toEqual({
			driver: "log",
			from: SANDBOX_MAIL_FROM,
		});
	});

	it("refuses to boot when the log driver would print into production logs", () => {
		// The log driver prints `message.text` and `message.html`, and a
		// verification or password-reset body holds a live one-time link. On a
		// server that dump lands in retained, aggregated container logs — a
		// credential store nobody chose. The deployment that does this looks
		// completely healthy, which is why it has to be refused rather than warned
		// about.
		expect(() => resolveMailConfig(envWith({ NODE_ENV: "production" }))).toThrow(
			LOG_IN_PRODUCTION
		);
	});

	it.each(["development", "test"] as const)(
		"keeps the log driver working on NODE_ENV=%s",
		(nodeEnv) => {
			// The guard is about one deployment, not about the driver. A laptop and
			// a CI run both need this path: it is how a contributor opens a
			// verification link, and it is what `.env.test` selects.
			expect(resolveMailConfig(envWith({ NODE_ENV: nodeEnv }))).toEqual({
				driver: "log",
				from: SANDBOX_MAIL_FROM,
			});
		}
	);

	it("resolves resend in production, which is the way out of the refusal", () => {
		expect(
			resolveMailConfig(
				envWith({
					MAIL_DRIVER: "resend",
					MAIL_FROM: VERIFIED_FROM,
					NODE_ENV: "production",
					RESEND_API_KEY: "re_test",
				})
			)
		).toEqual({ apiKey: "re_test", driver: "resend", from: VERIFIED_FROM });
	});

	it("names the way out, not just the problem", () => {
		// The message is the whole interface of a startup refusal: whoever reads it
		// is holding a crashed worker and a compose file, and has to know both which
		// variable is wrong and what to write instead.
		expect(() => resolveMailConfig(envWith({ NODE_ENV: "production" }))).toThrow(
			/set MAIL_DRIVER to resend/
		);
	});
});
