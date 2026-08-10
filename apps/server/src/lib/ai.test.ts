import { describe, expect, it } from "bun:test";
import { type AiEnv, resolveAi } from "./ai";

/** Each guard is identified by the variable it names, which is its whole job. */
const MISSING_KEY = /AI_API_KEY/;
const MISSING_MODEL = /AI_MODEL/;

function envWith(overrides: Partial<AiEnv>): AiEnv {
	return { AI_MODEL: "openai/gpt-4o-mini", ...overrides };
}

describe("resolveAi", () => {
	it("refuses a call when no key is configured", () => {
		expect(() => resolveAi(envWith({}))).toThrow(MISSING_KEY);
	});

	it("treats an empty key as absent", () => {
		// `emptyStringAsUndefined` covers an unset variable, but a deployment that
		// writes `AI_API_KEY=` into a compose file must not slip past the guard.
		expect(() => resolveAi(envWith({ AI_API_KEY: "" }))).toThrow(MISSING_KEY);
	});

	it("refuses a call when no model is configured", () => {
		// Both halves are optional in the schema — a deployment that set a key and
		// forgot the model must not fall through to a model this repo picked.
		expect(() =>
			resolveAi(envWith({ AI_API_KEY: "sk-or-test", AI_MODEL: undefined }))
		).toThrow(MISSING_MODEL);
	});

	it("carries the key and the model through when configured", () => {
		expect(
			resolveAi(
				envWith({
					AI_API_KEY: "sk-or-test",
					AI_MODEL: "anthropic/claude-haiku",
				})
			)
		).toEqual({ apiKey: "sk-or-test", model: "anthropic/claude-haiku" });
	});
});
