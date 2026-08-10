import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

// Re-exported so the app can name what `createAiModel` hands back without
// depending on the AI SDK directly: the whole point of this package is that the
// choice of SDK stops here.
export type { LanguageModel } from "ai";

/**
 * The two deployment inputs an AI call needs.
 *
 * Taken as an argument rather than read from the environment: this package has
 * no `@keel/env` import, so it can be exercised with a literal in a test and the
 * app stays the only place that knows what a variable is called.
 */
export interface AiConfig {
	apiKey: string;
	model: string;
}

/**
 * Builds the provider once for a process.
 *
 * The return is the AI SDK's own `LanguageModel` rather than a wrapper struct,
 * which is what makes the seam useful in both directions: a test hands
 * `generate` a `MockLanguageModelV4` and never opens a socket, and a consumer
 * who outgrows OpenRouter replaces this function without anything downstream
 * moving. That is the whole reason this package adds no abstraction of its own —
 * the AI SDK already is the abstraction, and a second one wrapping it would only
 * be something else to keep in sync.
 *
 * OpenRouter is a router, not a model vendor: one key and one bill reach every
 * model it fronts, which is why a starter can ship a working AI path without
 * asking a contributor to hold four accounts. That is bought with three real
 * costs. Every request takes an extra hop, so latency is theirs plus the
 * upstream's. Every prompt passes through a middleman, which is a decision to
 * make deliberately for anything regulated rather than inherit from a starter.
 * And provider-specific features — a new tool-calling mode, a caching header —
 * can lag behind the vendor's own API by weeks. Swapping to
 * `createAnthropic({ apiKey }).languageModel(config.model)` is the one line.
 */
export function createAiModel(config: AiConfig): LanguageModel {
	const openrouter = createOpenRouter({
		apiKey: config.apiKey,
		// `compatible`, the default, exists for third-party endpoints that only
		// speak an OpenAI-shaped subset. This talks to OpenRouter itself.
		compatibility: "strict",
	});

	return openrouter.chat(config.model);
}
