import { describe, expect, it } from "bun:test";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { generate } from "./generate";

/**
 * Stubbed at the AI SDK's own boundary — a `LanguageModelV4` — rather than at
 * `fetch` or at `generateText`. No socket opens and no model is billed, and the
 * mapping under test is still the SDK's real one: the provider protocol reports
 * usage as `{ inputTokens: { total } }` and the SDK flattens it to
 * `LanguageModelUsage`, so a stub one layer higher would assert nothing.
 */
function modelReturning(
	result: Partial<{
		modelId: string;
		outputTokens: number | undefined;
		promptTokens: number | undefined;
		text: string;
	}> = {}
): LanguageModel {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ text: result.text ?? "the answer", type: "text" as const }],
			finishReason: { raw: undefined, unified: "stop" as const },
			response: { modelId: result.modelId },
			usage: {
				inputTokens: {
					cacheRead: undefined,
					cacheWrite: undefined,
					noCache: undefined,
					total: "promptTokens" in result ? result.promptTokens : 11,
				},
				outputTokens: {
					reasoning: undefined,
					text: undefined,
					total: "outputTokens" in result ? result.outputTokens : 7,
				},
			},
			warnings: [],
		}),
		modelId: "openai/gpt-4o-mini",
	});
}

describe("generate", () => {
	it("returns the completion with the tokens it cost", async () => {
		const generation = await generate(modelReturning({ text: "42" }), {
			prompt: "What is six times seven?",
		});

		expect(generation.text).toBe("42");
		expect(generation.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
	});

	it("records the model the provider served, not the one requested", async () => {
		// A router may answer with something other than the id in the request, and
		// a ledger row priced against the request would then be priced wrong.
		const generation = await generate(
			modelReturning({ modelId: "anthropic/claude-haiku" }),
			{ prompt: "hello" }
		);

		expect(generation.model).toBe("anthropic/claude-haiku");
	});

	it("names the requested model when the provider reports none", async () => {
		const generation = await generate(modelReturning({}), { prompt: "hello" });

		expect(generation.model).toBe("openai/gpt-4o-mini");
	});

	it("counts unreported tokens as zero rather than failing the call", async () => {
		// The completion is already paid for by the time usage is read. Throwing
		// here would fail the job, and the retry would buy it a second time.
		const generation = await generate(
			modelReturning({ outputTokens: undefined, promptTokens: undefined }),
			{ prompt: "hello" }
		);

		expect(generation.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	it("aborts a call that never answers", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: ({ abortSignal }) => {
				// A provider that accepted the request and then went quiet. Nothing
				// resolves this except the timeout, which is the point.
				const { promise, reject } = Promise.withResolvers<never>();
				abortSignal?.addEventListener("abort", () =>
					reject(abortSignal.reason)
				);
				return promise;
			},
		});

		await expect(
			generate(model, { prompt: "hello", timeoutMs: 20 })
		).rejects.toThrow();
	});
});
