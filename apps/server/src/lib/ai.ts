import {
	type AiConfig,
	createAiModel,
	type LanguageModel,
} from "@keel/ai/config";
import { env } from "@keel/env/server";

/**
 * The two deployment inputs `resolveAi` reads.
 *
 * Taken as a parameter rather than closed over for the same reason `MailEnv` is:
 * the startup guard below is the only reason this function exists, and a guard
 * nobody has seen fire is not a guard.
 */
export interface AiEnv {
	AI_API_KEY?: string | undefined;
	AI_MODEL?: string | undefined;
}

/**
 * The config `createAiModel` receives. The counterpart of `resolveMailConfig`,
 * and the only file that knows both the environment and the AI package.
 */
export function resolveAi(source: AiEnv = env): AiConfig {
	if (!source.AI_API_KEY) {
		throw new Error(
			"AI_API_KEY is required to run an ai.generate job. Set AI_API_KEY to an OpenRouter API key, or stop enqueueing ai.generate."
		);
	}

	// Neither half of the pair is defaulted, so both are guarded here. A model id
	// invented by the schema would be this repository choosing which vendor gets
	// billed for someone else's job.
	if (!source.AI_MODEL) {
		throw new Error(
			"AI_MODEL is required to run an ai.generate job. Set AI_MODEL to an OpenRouter model id — `provider/model`, as listed on openrouter.ai/models — or stop enqueueing ai.generate."
		);
	}

	return { apiKey: source.AI_API_KEY, model: source.AI_MODEL };
}

let model: LanguageModel | undefined;

/**
 * The provider, built once per process.
 *
 * Once, but on first use rather than at import — which is where this deviates
 * from mail, deliberately. Mail resolves at module scope because every
 * deployment sends mail and the `log` driver always works, so an eager guard
 * costs nothing. AI is opt-in and has no free driver: resolving it eagerly would
 * mean a worker refusing to boot over a key that most deployments will never
 * need, taking the mail queue down with it.
 *
 * So the guard fires on the first `ai.generate` job instead. That job fails with
 * the message above recorded in `job.last_error`, retries five times and settles
 * as `failed` — loud enough, because someone had to enqueue the job on purpose
 * to get here.
 */
export function aiModel(): LanguageModel {
	model ??= createAiModel(resolveAi());
	return model;
}
