import { describe, expect, it } from "bun:test";
import { registry } from "./registry";

/**
 * The wiring, not the handlers.
 *
 * Each handler is covered where it lives — `mail.test.ts`, the AI suites, the
 * webhooks route suite. What none of them could see is whether the worker will
 * actually reach one: `webhook.process` shipped a release registered inside the
 * `ai.generate` handler's body, so a worker that never ran an AI job held two
 * kinds instead of three, and every webhook delivery it claimed failed with
 * "no handler registered" until it exhausted its attempts. Every suite was
 * green, because every suite called the handler directly.
 *
 * A missing kind is therefore a test failure now, and adding a kind means adding
 * it here.
 */
describe("job registry", () => {
	it.each(["mail.send", "ai.generate", "webhook.process"])(
		"has a handler for %s",
		(kind) => {
			expect(registry.get(kind)).toBeFunction();
		}
	);

	// The list above is the whole contract: a kind registered somewhere unreachable
	// would leave this count short, and a kind added without a case above would
	// leave it long.
	it("registers exactly the kinds this worker ships", () => {
		expect([...registry.keys()].sort()).toEqual([
			"ai.generate",
			"mail.send",
			"webhook.process",
		]);
	});
});
