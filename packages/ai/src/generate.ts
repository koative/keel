import { generateText, type LanguageModel } from "ai";

/**
 * How long one call may take before it is aborted.
 *
 * An LLM call has no natural upper bound. There is no content-length to read
 * ahead, the response arrives token by token, and a provider under load can hold
 * a socket open for minutes without ever failing. Left unbounded that is not one
 * slow job: `runOnce` runs a claimed batch sequentially, so a single hung call
 * stops the worker from touching any other kind of work until the provider gives
 * up — and the job row stays `running` with a lock nobody will release.
 *
 * Two minutes is chosen against the slowest thing a starter would sensibly do
 * here, a long completion from a reasoning model, and is an argument rather than
 * a constant so a consumer with a longer job can say so per call.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The token counts a bill is computed from.
 *
 * Named exactly as the AI SDK names them — `inputTokens` and `outputTokens`,
 * from `LanguageModelUsage` — so the mapping below is a copy and not a
 * translation nobody can check. The SDK types both as possibly undefined
 * because not every provider reports them.
 */
export interface AiUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface Generation {
	/** What actually answered, which is not always what was asked for. */
	model: string;
	text: string;
	usage: AiUsage;
}

export interface GenerateOptions {
	prompt: string;
	timeoutMs?: number;
}

/**
 * One completion, with what it cost.
 *
 * The usage comes back with the text rather than being fetched afterwards
 * because the provider only reports it once, on the response that carried the
 * completion. A caller that drops it has no second chance to learn what it
 * spent.
 */
export async function generate(
	model: LanguageModel,
	options: GenerateOptions
): Promise<Generation> {
	const result = await generateText({
		abortSignal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		// The queue is the retry mechanism, and it is the visible one: attempts
		// are counted on the job row and the last failure is readable there. A
		// second retry layer inside the call would multiply that budget by three
		// where nobody can see it, and every layer of retry against a metered API
		// is a multiplier on the bill.
		maxRetries: 0,
		model,
		prompt: options.prompt,
	});

	return {
		// The id the provider reported, not the one that was requested: a router
		// is free to serve `openrouter/auto` — or a fallback after an upstream
		// error — with something other than the model named in the request, and
		// the ledger has to price what ran. The SDK guarantees the field, filling
		// it from the requested id when the provider omits it.
		model: result.finalStep.response.modelId,
		text: result.text,
		usage: {
			// Zero, not a throw, when a provider reports nothing. The row is also
			// the marker that says this job's call already happened, so failing to
			// write it costs more than an under-counted meter: the retry would pay
			// for the completion a second time.
			inputTokens: result.usage.inputTokens ?? 0,
			outputTokens: result.usage.outputTokens ?? 0,
		},
	};
}
