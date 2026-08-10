import { describe, expect, it } from "bun:test";
import { SANDBOX_MAIL_FROM } from "@keel/env/server";
import { type MailEnv, resolveMailConfig } from "./mail";

const VERIFIED_FROM = "Keel <hello@keel.test>";

/** Each guard is identified by the variable it names, which is its whole job. */
const MISSING_KEY = /RESEND_API_KEY/;
const SANDBOX_SENDER = /MAIL_FROM/;

function envWith(overrides: Partial<MailEnv>): MailEnv {
	return { MAIL_DRIVER: "log", MAIL_FROM: SANDBOX_MAIL_FROM, ...overrides };
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
});
