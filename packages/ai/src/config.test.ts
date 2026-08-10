import { describe, expect, it } from "bun:test";

import { createAiModel } from "./config";

describe("createAiModel", () => {
	it("builds an OpenRouter model for the configured id", () => {
		// Constructing a provider makes no request, so this asserts the one thing
		// that can silently go wrong here: the configured model id reaching the
		// provider, which is also the id the ledger is priced against.
		expect(
			createAiModel({ apiKey: "sk-or-test", model: "openai/gpt-4o-mini" })
		).toMatchObject({
			modelId: "openai/gpt-4o-mini",
			provider: "openrouter",
		});
	});
});
